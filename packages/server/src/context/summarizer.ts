/**
 * 滚动摘要（rolling summary）。
 *
 * 目标：百万 Token 对话不崩溃，同时「不丢失关键决策」。
 * 策略：
 * 1) 只摘要「未摘要区间」，保留最近 N 条原文（绝对不摘要最近的用户指令）；
 * 2) 摘要 prompt 强制输出固定小节的 Markdown：决策 / 约束 / 未决问题 / 事实；
 * 3) 模型不可用（离线）时使用确定性抽取式摘要，保证关键决策仍能保留；
 * 4) 摘要结果带 from/to messageId，支持溯源回原始消息。
 */
import type { Message } from '@ai/shared';
import { modelRouter } from '../agent/model-router.ts';
import { estimateTokens } from '../agent/tokens.ts';
import { config } from '../config.ts';
import { logger } from '../utils/logger.ts';

export const SUMMARY_SECTIONS = ['关键决策', '约束与偏好', '未决问题', '已确认事实'] as const;

export interface SummaryInput {
  messages: Message[];
  previousSummary?: string;
}

export interface SummaryOutput {
  content: string;
  fromMessageId: string;
  toMessageId: string;
  coveredCount: number;
  tokens: number;
  degraded: boolean;
}

const SUMMARY_SYSTEM = `你是对话压缩器。把给定的历史对话压缩成简洁但信息无损的摘要。
必须保持以下 Markdown 小节结构（没有内容的小节写「无」）：
## 关键决策
## 约束与偏好
## 未决问题
## 已确认事实
规则：
- 保留所有已确定的决策、数字、名称、约束、待办
- 丢弃寒暄、重复表述
- 不要编造原文没有的信息
- 不要输出 JSON，不要输出与摘要无关的内容`;

/**
 * 生成摘要。模型不可用时回落到确定性抽取（保留「决策/约束/数字」样式的句子）。
 */
export async function summarize(input: SummaryInput): Promise<SummaryOutput> {
  const { messages } = input;
  if (messages.length === 0) {
    return { content: '', fromMessageId: '', toMessageId: '', coveredCount: 0, tokens: 0, degraded: true };
  }
  const from = messages[0]!.id;
  const to = messages[messages.length - 1]!.id;
  const transcript = messages
    .map((m) => `[${m.role}] ${m.content.slice(0, 4000)}`)
    .join('\n')
    .slice(0, 120_000);

  const chat = await modelRouter.chat({
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM },
      {
        role: 'user',
        content: [
          input.previousSummary ? `# 已有摘要（需要合并）\n${input.previousSummary}` : '',
          `# 待压缩对话（${messages.length} 条）\n${transcript}`,
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
    temperature: 0.1,
    ...(config.ai.summaryModel ? { model: config.ai.summaryModel } : {}),
  });

  const degraded = chat.degraded || !isUsable(chat.content);
  const content = degraded ? extractiveSummarize(messages) : chat.content.trim();
  return {
    content,
    fromMessageId: from,
    toMessageId: to,
    coveredCount: messages.length,
    tokens: estimateTokens(content),
    degraded,
  };
}

/** 摘要可用性检查：必须包含至少一个小节标题，避免模型瞎编空文本 */
function isUsable(content: string): boolean {
  const text = content.trim();
  if (text.length < 30) return false;
  return SUMMARY_SECTIONS.some((s) => text.includes(s));
}

const DECISION_PATTERNS: { section: (typeof SUMMARY_SECTIONS)[number]; re: RegExp }[] = [
  { section: '关键决策', re: /(决定|确定|采用|就用|选择|敲定|方案是|结论是)/ },
  { section: '约束与偏好', re: /(必须|不能|禁止|务必|要求|偏好|习惯|约束)/ },
  { section: '未决问题', re: /(待定|待确认|还没|尚未|问题|风险|阻塞|TODO|待办)/i },
  { section: '已确认事实', re: /\d/ },
];

/**
 * 抽取式摘要：确定性、无模型依赖。
 * 按句式特征分类收集句子，保证「离线也不会丢关键决策」。
 */
export function extractiveSummarize(messages: Message[]): string {
  const buckets = new Map<string, string[]>(SUMMARY_SECTIONS.map((s) => [s, []]));
  for (const m of messages) {
    const sentences = m.content
      .split(/(?<=[。！？!?\n；;])/)
      .map((s) => s.trim())
      .filter((s) => s.length > 4 && s.length < 300);
    for (const sentence of sentences) {
      for (const p of DECISION_PATTERNS) {
        const bucket = buckets.get(p.section)!;
        if (bucket.length < 12 && p.re.test(sentence) && !bucket.includes(sentence)) {
          bucket.push(sentence);
          break;
        }
      }
    }
  }
  const lines: string[] = [];
  for (const section of SUMMARY_SECTIONS) {
    const items = buckets.get(section)!;
    lines.push(`## ${section}`);
    lines.push(items.length ? items.map((i) => `- ${i}`).join('\n') : '无');
  }
  logger.debug('extractive summary generated', { messages: messages.length });
  return lines.join('\n');
}

/**
 * 计算需要摘要的消息区间。
 * @param messages 全部消息（时间升序）
 * @param keepRecent 保留最近的原文条数
 * @param tokenThreshold 未摘要区间超过该 token 数才压缩
 */
export function pickSummarizeRange(
  messages: Message[],
  keepRecent: number,
  tokenThreshold: number,
): { toSummarize: Message[]; tokenCount: number } {
  // 最近 keepRecent 条（无论是否已摘要）永远保留原文，绝不参与压缩
  const recentIds = new Set(messages.slice(-Math.max(0, keepRecent)).map((m) => m.id));
  const pending = messages.filter((m) => !m.summarized && !recentIds.has(m.id));
  const splitAt = pending.length;
  const toSummarize = pending.slice(0, splitAt);
  const tokenCount = toSummarize.reduce((s, m) => s + m.tokenCount, 0);
  if (tokenCount < tokenThreshold || toSummarize.length === 0) return { toSummarize: [], tokenCount };
  return { toSummarize, tokenCount };
}

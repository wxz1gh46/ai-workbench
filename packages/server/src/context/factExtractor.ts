/**
 * 关键事实抽取。
 *
 * 两类来源：
 * 1) 规则抽取（确定性，离线可用）：偏好/约束/决定/数字指标 → 四类事实；
 * 2) 模型抽取（在线增强）：结构化 JSON，失败自动回落规则结果。
 *
 * 共存原则：规则永远先行，模型只做补充（同 key+value 去重）。
 * 每条事实都带 sourceMessageId → 支持「点击跳回原消息」的溯源要求。
 */
import type { Message } from '@ai/shared';
import { modelRouter } from '../agent/model-router.ts';
import { estimateTokens } from '../agent/tokens.ts';
import { logger } from '../utils/logger.ts';

export type FactType = 'preference' | 'constraint' | 'decision' | 'fact';

export interface ExtractedFact {
  key: string;
  value: string;
  factType: FactType;
  /** 0-1，规则命中=0.6，模型判定=0.75，数字约束=0.8 */
  importance: number;
  sourceMessageId: string | null;
}

const RULES: { factType: FactType; key: string; re: RegExp; importance: number }[] = [
  { factType: 'preference', key: '偏好', re: /(?:我(?:更)?(?:喜欢|偏好|习惯|倾向))([^。！!\n]{1,60})/g, importance: 0.6 },
  { factType: 'constraint', key: '约束', re: /(?:必须|不能|禁止|务必|一定要)([^。！!\n]{1,60})/g, importance: 0.75 },
  { factType: 'decision', key: '决定', re: /(?:决定|确定|就用|采用|敲定)([^。！!\n]{1,60})/g, importance: 0.7 },
  {
    factType: 'fact',
    key: '指标',
    re: /([\u4e00-\u9fff]{2,12}(?:是|为|达到|约)\s?\d[\d,.]*\s?(?:%|亿|万|元|美元|人|台|GW|MW|吨|天|个月|年)?)/g,
    importance: 0.8,
  },
];

/** 规则抽取：同步、确定性 */
export function extractFactsByRules(text: string, sourceMessageId: string | null): ExtractedFact[] {
  const out: ExtractedFact[] = [];
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.re)) {
      const value = (match[1] ?? '').trim();
      if (value.length < 2) continue;
      out.push({
        key: rule.key,
        value: value.slice(0, 200),
        factType: rule.factType,
        importance: rule.importance,
        sourceMessageId,
      });
    }
  }
  return dedupe(out);
}

const MODEL_SYSTEM = `你是事实抽取器。从对话中抽取对后续协作有价值的长期记忆条目。
只输出 JSON：{"facts":[{"key":"...","value":"...","factType":"preference|constraint|decision|fact","importance":0.0-1.0}]}
规则：
- 只抽取确定的信息，不要推测
- 每条不超过 80 字
- 最多 8 条，宁缺毋滥
- 不要输出 JSON 以外的内容`;

/** 模型抽取（离线时返回空数组，由调用方保留规则结果） */
export async function extractFactsByModel(text: string): Promise<ExtractedFact[]> {
  try {
    const chat = await modelRouter.chat({
      messages: [
        { role: 'system', content: MODEL_SYSTEM },
        { role: 'user', content: text.slice(0, 12_000) },
      ],
      jsonMode: true,
      temperature: 0,
    });
    if (chat.degraded) return [];
    const parsed = JSON.parse(stripFence(chat.content)) as { facts?: unknown };
    if (!Array.isArray(parsed.facts)) return [];
    return parsed.facts
      .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
      .map((f) => {
        const type = String(f.factType ?? 'fact') as FactType;
        return {
          key: String(f.key ?? '事实').slice(0, 40),
          value: String(f.value ?? '').slice(0, 200),
          factType: (['preference', 'constraint', 'decision', 'fact'] as const).includes(type) ? type : 'fact',
          importance: typeof f.importance === 'number' ? Math.min(1, Math.max(0, f.importance)) : 0.6,
          sourceMessageId: null as string | null,
        };
      })
      .filter((f) => f.value.length > 0);
  } catch (e) {
    logger.debug('model fact extraction failed, using rules only', {
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
}

/**
 * 合并规则与模型结果：按类型+键+值去重，保留更高 importance。
 * 溯源优先级：规则结果自带 sourceMessageId（最精确）> 模型结果 > 兜底 sourceMessageId。
 */
export function mergeFacts(ruleFacts: ExtractedFact[], modelFacts: ExtractedFact[], sourceMessageId: string | null): ExtractedFact[] {
  const merged = [
    ...ruleFacts.map((f) => ({ ...f, sourceMessageId: f.sourceMessageId ?? sourceMessageId })),
    ...modelFacts.map((f) => ({ ...f, sourceMessageId: f.sourceMessageId ?? sourceMessageId })),
  ];
  return dedupe(merged).sort((a, b) => b.importance - a.importance).slice(0, 40);
}

function dedupe(facts: ExtractedFact[]): ExtractedFact[] {
  const map = new Map<string, ExtractedFact>();
  for (const f of facts) {
    const k = `${f.factType}|${f.key}|${f.value}`;
    const prev = map.get(k);
    if (!prev) {
      map.set(k, f);
      continue;
    }
    // 保留更高重要度；溯源优先取「已有来源」（通常是更精确的规则命中），避免被兜底值覆盖
    const winner = prev.importance >= f.importance ? prev : f;
    const source = prev.sourceMessageId ?? f.sourceMessageId;
    map.set(k, { ...winner, sourceMessageId: source });
  }
  return [...map.values()];
}

/** 事实的文本表示，用于 embedding 与预算估算 */
export function factToText(f: { key: string; value: string; factType?: string }): string {
  return `${f.factType ?? 'fact'} ${f.key}: ${f.value}`;
}

export function factTokens(f: { key: string; value: string }): number {
  return estimateTokens(`${f.key}: ${f.value}`);
}

function stripFence(s: string): string {
  const cleaned = s.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  return start === -1 || end === -1 ? cleaned : cleaned.slice(start, end + 1);
}

/** 从 Message[] 批量抽取事实（规则 + 模型） */
export async function extractFactsFromMessages(messages: Message[]): Promise<ExtractedFact[]> {
  const out: ExtractedFact[] = [];
  for (const m of messages) {
    const rules = extractFactsByRules(m.content, m.id);
    out.push(...rules);
  }
  const combined = messages.map((m) => m.content).join('\n').slice(0, 12_000);
  const modelFacts = combined.length > 40 ? await extractFactsByModel(combined) : [];
  return mergeFacts(out, modelFacts, messages[messages.length - 1]?.id ?? null);
}

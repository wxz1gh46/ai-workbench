/**
 * 完成审计（结构化）。
 *
 * 与 Phase 1 的 critic.ts 的关系：
 * - critic.ts 负责「向模型要一个结论」（文本 + 宽松 JSON）
 * - 本模块负责「把结论对齐到验收标准」，产出可持久化、可渲染、可逐条打勾的 AuditReport
 *
 * 关键设计：目标是既定的审计标准。因此审计必须逐条给出「标准 → 是否满足 → 证据」，
 * 而不是一个笼统的分数；任何未通过的标准都必须出现在 nextActions 里。
 */
import type { AuditReport, Goal, Task } from '@ai/shared';
import { nowIso } from '../utils/ids.ts';
import { summarize } from './progressTree.ts';

export interface AuditInput {
  goal: Goal;
  tasks: Task[];
  /** 模型给出的结论（可能不可用） */
  verdict?: {
    passed: boolean;
    score: number;
    issues: { severity: 'low' | 'medium' | 'high'; detail: string }[];
    nextActions: string[];
    report: string;
    degraded: boolean;
  } | null;
}

/** 文本证据：取任务产出的前若干字符，便于审计可查证 */
function evidenceOf(task: Task): string {
  const text = String((task.output as { text?: unknown } | null)?.text ?? '').trim();
  if (!text) return task.outputSummary ?? '（无正文产出）';
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

/**
 * 把验收标准逐条映射到任务产出。
 *
 * 匹配策略（确定性优先，避免模型幻觉影响审计结论）：
 * 1) 若任务标题/描述包含标准关键词（去停用词后），认为该任务服务于该标准；
 * 2) 该任务 succeeded → 标准判定为满足，证据为该任务产出；
 * 3) 无匹配任务 → 以「全部任务成功」作为兜底判断（Planner 可能没显式对齐标准）。
 */
export function matchCriteria(goal: Goal, tasks: Task[]): { criterion: string; met: boolean; evidence: string }[] {
  const allOk = tasks.length > 0 && tasks.every((t) => t.status === 'succeeded');
  return goal.acceptanceCriteria.map((criterion) => {
    const keywords = extractKeywords(criterion);
    const related = tasks.filter((t) => {
      const hay = `${t.title} ${t.description}`;
      return keywords.some((k) => hay.includes(k));
    });
    if (related.length === 0) {
      return {
        criterion,
        met: allOk,
        evidence: allOk ? '全部任务成功完成（无任务显式绑定该标准）' : `尚未有任务对应该标准；当前未完成 ${tasks.filter((t) => t.status !== 'succeeded').length} 个任务`,
      };
    }
    const ok = related.every((t) => t.status === 'succeeded');
    const failed = related.filter((t) => t.status !== 'succeeded');
    return {
      criterion,
      met: ok,
      evidence: ok ? `任务「${related[0]!.title}」${evidenceOf(related[0]!)}` : failed.map((t) => `${t.title}(${t.status})`).join('、'),
    };
  });
}

/**
 * 提取标准里的关键词。
 *
 * 不能直接用贪婪 CJK 正则（会把「必须支持百万」整体吞掉），
 * 因此先把虚词替换成空格做粗切分，再保留有效片段。
 */
export function extractKeywords(text: string): string[] {
  const STOP_WORDS = [
    '必须', '需要', '要求', '并且', '以及', '能够', '可以', '支持', '实现', '完成', '提供', '进行',
    '同时', '而且', '保证', '确保', '所有', '全部', '相关', '一个', '一种', '的', '了', '和', '与', '或',
  ];
  let segmented = text;
  for (const w of STOP_WORDS) segmented = segmented.split(w).join(' ');

  const tokens = segmented.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z][a-zA-Z0-9_+#.-]{1,}|\d+/g) ?? [];
  const out = [...new Set(tokens.map((t) => t.trim()).filter((t) => t.length >= 2))];
  // 关键词全被过滤时，退回「去掉虚词后的最长片段」，仍好于整句匹配
  return out.length > 0 ? out : [text.replace(/\s+/g, '').slice(0, 8)];
}

/**
 * 生成审计报告。
 * passed 的判定：所有验收标准满足 **且** 所有任务成功 **且** 模型未提出 high 级问题。
 * 这样即使模型说「通过」，只要任务失败也不会误判为完成。
 */
export function buildAuditReport(input: AuditInput): AuditReport {
  const { goal, tasks, verdict } = input;
  const criteria = matchCriteria(goal, tasks);
  const stats = summarize(tasks);

  const taskIssues = tasks
    .filter((t) => t.status !== 'succeeded')
    .map((t) => ({
      severity: (t.status === 'failed' ? 'high' : 'medium') as 'high' | 'medium',
      detail: `任务「${t.title}」状态 ${t.status}${t.error ? `：${t.error}` : ''}`,
    }));

  const modelIssues = verdict?.issues ?? [];
  const issues = [...taskIssues, ...modelIssues];

  const criteriaMet = criteria.every((c) => c.met);
  const noHighIssue = !issues.some((i) => i.severity === 'high');
  const tasksOk = stats.total > 0 && stats.succeeded === stats.total;
  const passed = criteriaMet && noHighIssue && tasksOk;

  const nextActions = [
    ...new Set([
      ...(verdict?.nextActions ?? []),
      ...criteria.filter((c) => !c.met).map((c) => `补齐验收标准：${c.criterion}`),
      ...tasks.filter((t) => t.status === 'blocked').map((t) => `解除阻塞：${t.title}`),
      ...tasks.filter((t) => t.status === 'failed').map((t) => `重试任务：${t.title}`),
    ]),
  ];

  const score = verdict?.score && verdict.score > 0 ? Math.min(verdict.score, passed ? verdict.score : Math.min(verdict.score, 89)) : Math.round((stats.succeeded / Math.max(1, stats.total)) * 100);

  return {
    goalId: goal.id,
    passed,
    score,
    criteria,
    issues,
    nextActions,
    markdown: renderAuditMarkdown({ goal, criteria, issues, nextActions, passed, score, stats, verdictMarkdown: verdict?.report ?? '' }),
    degraded: verdict?.degraded ?? true,
    generatedAt: nowIso(),
  };
}

function renderAuditMarkdown(input: {
  goal: Goal;
  criteria: { criterion: string; met: boolean; evidence: string }[];
  issues: { severity: string; detail: string }[];
  nextActions: string[];
  passed: boolean;
  score: number;
  stats: ReturnType<typeof summarize>;
  verdictMarkdown: string;
}): string {
  const lines: string[] = [
    `# 完成审计报告`,
    '',
    `- 目标：${input.goal.objective}`,
    `- 结论：${input.passed ? '✅ 通过' : '❌ 未通过'}（得分 ${input.score}/100）`,
    `- 任务：${input.stats.succeeded}/${input.stats.total} 成功，${input.stats.failed} 失败，${input.stats.blocked} 阻塞，${input.stats.running} 进行中`,
    `- 轮次：${input.goal.iterations}/${input.goal.maxIterations}`,
    `- 生成时间：${nowIso()}`,
    '',
    '## 验收标准逐条核对',
    '',
  ];
  for (const c of input.criteria) {
    lines.push(`- [${c.met ? 'x' : ' '}] ${c.criterion}`);
    lines.push(`  - 证据：${c.evidence}`);
  }
  lines.push('', '## 问题清单', '');
  if (input.issues.length === 0) lines.push('- 无');
  for (const i of input.issues) lines.push(`- [${i.severity}] ${i.detail}`);
  lines.push('', '## 后续动作', '');
  if (input.nextActions.length === 0) lines.push('- 无，目标已达成');
  for (const a of input.nextActions) lines.push(`- ${a}`);
  if (input.verdictMarkdown.trim()) {
    lines.push('', '## 审计 Agent 原始结论', '', input.verdictMarkdown.trim());
  }
  return lines.join('\n');
}

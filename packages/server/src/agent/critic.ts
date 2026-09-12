import type { Goal, Task } from '@ai/shared';
import { modelRouter } from './model-router.ts';

export interface CriticIssue {
  severity: 'low' | 'medium' | 'high';
  detail: string;
}

export interface CriticVerdict {
  passed: boolean;
  score: number;
  issues: CriticIssue[];
  nextActions: string[];
  report: string;
  degraded: boolean;
}

const CRITIC_SYSTEM = `你是完成审计 Agent。对照目标与验收标准逐条审查产出。
只输出 JSON：{"passed":boolean,"score":0-100,"issues":[{"severity":"low|medium|high","detail":"..."}],"nextActions":["..."],"report":"Markdown 审计报告"}
判断原则：
- 必须能指出已满足哪些验收标准、哪些未满足
- 缺少证据/来源的结论视为未完成
- nextActions 为空且全部标准满足时 passed 才能为 true`;

export function parseVerdict(raw: string): Omit<CriticVerdict, 'degraded'> {
  const cleaned = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('审计结果不是合法 JSON');
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as {
    __degraded?: unknown;
    passed?: unknown;
    score?: unknown;
    issues?: unknown;
    nextActions?: unknown;
    report?: unknown;
  };
  if (parsed.__degraded === true) throw new Error('模型处于离线兜底模式，无法完成审计');
  const issues: CriticIssue[] = Array.isArray(parsed.issues)
    ? parsed.issues
        .filter((i): i is Record<string, unknown> => typeof i === 'object' && i !== null)
        .map((i) => ({
          severity: (['low', 'medium', 'high'] as const).includes(String(i.severity) as 'low')
            ? (String(i.severity) as 'low' | 'medium' | 'high')
            : 'medium',
          detail: String(i.detail ?? ''),
        }))
    : [];
  const score = typeof parsed.score === 'number' ? Math.max(0, Math.min(100, parsed.score)) : 0;
  return {
    passed: parsed.passed === true,
    score,
    issues,
    nextActions: Array.isArray(parsed.nextActions) ? parsed.nextActions.map(String) : [],
    report: String(parsed.report ?? ''),
  };
}

/** 完成审计：目标文本同时作为验收标准 */
export async function auditGoal(goal: Goal, tasks: Task[]): Promise<CriticVerdict> {
  const outcomes = tasks.map((t) => ({
    title: t.title,
    role: t.agentRole,
    status: t.status,
    error: t.error,
    output: (t.output ?? null) as unknown,
  }));

  const res = await modelRouter.chat({
    messages: [
      { role: 'system', content: CRITIC_SYSTEM },
      {
        role: 'user',
        content: [
          `# 目标\n${goal.objective}`,
          `# 验收标准\n${goal.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
          `# 任务与产出\n${JSON.stringify(outcomes, null, 2).slice(0, 12000)}`,
        ].join('\n\n'),
      },
    ],
    jsonMode: true,
    temperature: 0.1,
  });

  try {
    return { ...parseVerdict(res.content), degraded: res.degraded };
  } catch {
    // 解析失败时用确定性规则兜底，保证审计环节永不静默通过
    const failed = tasks.filter((t) => t.status !== 'succeeded');
    return {
      passed: failed.length === 0,
      score: Math.round((tasks.filter((t) => t.status === 'succeeded').length / Math.max(1, tasks.length)) * 100),
      issues: failed.map((t) => ({
        severity: 'high' as const,
        detail: `任务未成功：${t.title}（${t.status}）${t.error ? ' - ' + t.error : ''}`,
      })),
      nextActions: failed.map((t) => `重试任务：${t.title}`),
      report: `## 完成审计\n\n- 任务总数：${tasks.length}\n- 成功：${tasks.length - failed.length}\n- 未完成：${failed.length}\n`,
      degraded: true,
    };
  }
}

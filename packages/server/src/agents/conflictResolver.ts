import type { Conflict } from './resultAggregator.ts';

/**
 * 冲突解决（Phase 4 Step 5）。
 *
 * 三种手段（按「自动程度」从高到低）：
 *   1) vote        投票：适用于可枚举的判定（如代码风险等级 high/medium/low）
 *   2) priority    优先级：适用于有明确权威来源的场景（架构师 > 助手）
 *   3) human       人工确认：**不可自动裁决时必须落到这里**，不允许「随便挑一个」
 *
 * 本文件只做「怎么选」，不做「选完存哪」——存储由 ResultAggregator 负责。
 */

export type Resolution = 'vote' | 'priority' | 'human';

export interface ResolveInput {
  conflict: Conflict;
  method: Resolution;
  /** priority 方法时的角色优先级 */
  rolePriority?: string[];
  /** agentId → role 的映射（priority 判定用） */
  agentRoles?: Record<string, string>;
  /** vote 方法时的最小一致比例（默认 0.5，即严格多数） */
  voteThreshold?: number;
}

export interface ResolveOutput {
  resolved: boolean;
  value?: string;
  reason: string;
  method: Resolution;
}

export function resolveConflict(input: ResolveInput): ResolveOutput {
  const { conflict } = input;
  if (conflict.values.length === 0) {
    return { resolved: false, reason: '没有可裁决的取值', method: input.method };
  }
  if (conflict.values.length === 1) {
    return { resolved: true, value: conflict.values[0]!.value, reason: '只有一个取值，无需裁决', method: input.method };
  }

  if (input.method === 'vote') {
    const tally = new Map<string, string[]>();
    for (const v of conflict.values) {
      const arr = tally.get(v.value) ?? [];
      arr.push(v.agentId);
      tally.set(v.value, arr);
    }
    const sorted = [...tally.entries()].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
    const threshold = input.voteThreshold ?? 0.5;
    const [value, agents] = sorted[0]!;
    const ratio = agents.length / conflict.values.length;
    // 平票 / 未达阈值 → 明确失败，交给上层走人工确认（不允许「随便选一个」）
    if (ratio <= threshold) {
      return { resolved: false, reason: `投票未达阈值 ${(threshold * 100).toFixed(0)}%（最高 ${(ratio * 100).toFixed(0)}%，且存在并列）`, method: 'vote' };
    }
    return { resolved: true, value, reason: `投票采纳「${value}」（${agents.length}/${conflict.values.length}）`, method: 'vote' };
  }

  if (input.method === 'priority') {
    const order = input.rolePriority ?? [];
    const ranked = [...conflict.values].sort((a, b) => {
      const ra = order.indexOf(input.agentRoles?.[a.agentId] ?? '');
      const rb = order.indexOf(input.agentRoles?.[b.agentId] ?? '');
      const na = ra === -1 ? order.length : ra;
      const nb = rb === -1 ? order.length : rb;
      if (na !== nb) return na - nb;
      return a.agentId < b.agentId ? -1 : 1;
    });
    const winner = ranked[0]!;
    return { resolved: true, value: winner.value, reason: `按角色优先级采纳 ${winner.agentId} 的取值`, method: 'priority' };
  }

  return { resolved: false, reason: '人工确认：未作自动裁决', method: 'human' };
}

/** 批量裁决：返回「已解决」与「待人工」两部分 */
export function resolveAll(input: {
  conflicts: Conflict[];
  method: Resolution;
  rolePriority?: string[];
  agentRoles?: Record<string, string>;
}): { resolved: { key: string; value: string; reason: string }[]; pending: Conflict[] } {
  const resolved: { key: string; value: string; reason: string }[] = [];
  const pending: Conflict[] = [];
  for (const c of input.conflicts) {
    if (c.resolvedBy !== 'unresolved') continue;
    const out = resolveConflict({
      conflict: c,
      method: input.method,
      ...(input.rolePriority ? { rolePriority: input.rolePriority } : {}),
      ...(input.agentRoles ? { agentRoles: input.agentRoles } : {}),
    });
    if (out.resolved && out.value !== undefined) resolved.push({ key: c.key, value: out.value, reason: out.reason });
    else pending.push(c);
  }
  return { resolved, pending };
}

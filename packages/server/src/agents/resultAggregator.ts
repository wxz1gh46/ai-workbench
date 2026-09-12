import type { AggregatedResultInfo } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { aggregatedResults } from '../db/schema/index.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';

/**
 * 结果聚合（Phase 4 Step 5）。
 *
 * 多 Agent 并行的产物必须能合并成「一个结论」，否则并行只是把混乱放大了。
 * 支持四种策略：
 *   majority  多数一致（适合「判定类」结论，如三路代码审查的定级）
 *   priority  按 Agent 角色优先级（适合「有主次」的场景，如架构师 vs 助手）
 *   concat    拼接（适合「分工不重叠」的场景，如不同模块的文档）
 *   manual    不自动裁决，交给人工确认（冲突不可自动解决时必须走这条）
 *
 * 关键设计：**冲突必须显式记录**，不允许静默取第一个值 —— 那会让错误结论看起来像共识。
 */

export interface AgentOutput {
  agentId: string;
  role?: string;
  /** 结构化结果：同一 key 的多个取值会被判定为潜在冲突 */
  data: Record<string, unknown>;
  /** 自然语言总结（concat 时拼接） */
  summary?: string;
  /** 置信度 0~1 */
  confidence?: number;
}

export interface AggregateInput {
  taskId: string;
  goalId?: string;
  strategy: 'majority' | 'priority' | 'concat' | 'manual';
  outputs: AgentOutput[];
  /** priority 策略下的角色优先级（靠前的更权威） */
  rolePriority?: string[];
  /** concat 策略下的分隔符 */
  separator?: string;
}

export interface Conflict {
  key: string;
  values: { agentId: string; value: string }[];
  resolution: string;
  resolvedBy: string;
}

/** 归一化取值：把不同写法收敛，避免「1」与「1.0」、「较高」与"较高" 被判成冲突 */
export function normalizeValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return v.trim().replace(/\s+/g, ' ');
  return JSON.stringify(v);
}

export function aggregate(input: AggregateInput): { result: Record<string, unknown>; conflicts: Conflict[]; needsReview: boolean; notes: string[] } {
  if (input.outputs.length === 0) {
    return { result: {}, conflicts: [], needsReview: false, notes: ['没有可聚合的输出'] };
  }
  const notes: string[] = [];
  if (input.strategy === 'concat') {
    return { result: concat(input, notes), conflicts: [], needsReview: false, notes };
  }
  if (input.strategy === 'manual') {
    const conflicts = detectConflicts(input.outputs);
    notes.push(`manual 策略：不自动裁决，已列出 ${conflicts.length} 处差异供人工确认`);
    return { result: { outputs: input.outputs.map((o) => ({ agentId: o.agentId, ...o.data, summary: o.summary ?? '' })) }, conflicts, needsReview: conflicts.length > 0, notes };
  }
  if (input.strategy === 'priority') {
    return priority(input, notes);
  }
  return majority(input, notes);
}

function concat(input: AggregateInput, notes: string[]): Record<string, unknown> {
  const sep = input.separator ?? '\n\n---\n\n';
  const texts = input.outputs.filter((o) => o.summary?.trim()).map((o) => `## ${o.role ?? o.agentId}\n${o.summary!.trim()}`);
  notes.push(`concat 策略：拼接 ${texts.length} 段输出`);
  return { merged: texts.join(sep), parts: input.outputs.map((o) => ({ agentId: o.agentId, role: o.role ?? '', summary: o.summary ?? '' })) };
}

function majority(input: AggregateInput, notes: string[]): { result: Record<string, unknown>; conflicts: Conflict[]; needsReview: boolean; notes: string[] } {
  const keys = new Set<string>();
  for (const o of input.outputs) for (const k of Object.keys(o.data)) keys.add(k);

  const result: Record<string, unknown> = {};
  const conflicts: Conflict[] = [];

  for (const key of keys) {
    const values = input.outputs
      .filter((o) => o.data[key] !== undefined)
      .map((o) => ({ agentId: o.agentId, raw: o.data[key], norm: normalizeValue(o.data[key]) }));

    const tally = new Map<string, { count: number; value: unknown; agents: string[] }>();
    for (const v of values) {
      const entry = tally.get(v.norm) ?? { count: 0, value: v.raw, agents: [] };
      entry.count += 1;
      entry.agents.push(v.agentId);
      tally.set(v.norm, entry);
    }

    const sorted = [...tally.entries()].sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1));
    const top = sorted[0];
    if (!top) continue;

    if (sorted.length === 1) {
      result[key] = top[1].value;
      continue;
    }

    // 平票（无严格多数）：不擅自裁决
    const isTie = sorted.length > 1 && sorted[1]![1].count === top[1].count;
    if (isTie || top[1].count * 2 <= values.length) {
      conflicts.push({
        key,
        values: values.map((v) => ({ agentId: v.agentId, value: v.norm })),
        resolution: '存在分歧且无多数一致，已保留全部取值待人工确认',
        resolvedBy: 'unresolved',
      });
      result[key] = values.map((v) => ({ agentId: v.agentId, value: v.raw }));
      continue;
    }

    result[key] = top[1].value;
    conflicts.push({
      key,
      values: values.map((v) => ({ agentId: v.agentId, value: v.norm })),
      resolution: `采纳多数一致值「${top[0]}」（${top[1].count}/${values.length} 个 Agent）`,
      resolvedBy: 'majority',
    });
  }

  const unresolved = conflicts.filter((c) => c.resolvedBy === 'unresolved');
  notes.push(`majority 策略：${keys.size} 个字段，${conflicts.length} 处分歧，${unresolved.length} 处未决`);
  return { result, conflicts, needsReview: unresolved.length > 0, notes };
}

function priority(input: AggregateInput, notes: string[]): { result: Record<string, unknown>; conflicts: Conflict[]; needsReview: boolean; notes: string[] } {
  const order = input.rolePriority ?? ['coordinator', 'reviewer', 'analyst', 'researcher', 'coder', 'writer', 'operator'];
  const rank = (o: AgentOutput) => {
    const idx = order.indexOf(o.role ?? '');
    return idx === -1 ? order.length : idx;
  };
  const sorted = [...input.outputs].sort((a, b) => rank(a) - rank(b) || (b.confidence ?? 0.5) - (a.confidence ?? 0.5));

  const keys = new Set<string>();
  for (const o of sorted) for (const k of Object.keys(o.data)) keys.add(k);

  const result: Record<string, unknown> = {};
  const conflicts: Conflict[] = [];
  for (const key of keys) {
    const values = sorted.filter((o) => o.data[key] !== undefined).map((o) => ({ agentId: o.agentId, role: o.role ?? '', norm: normalizeValue(o.data[key]), raw: o.data[key] }));
    const winner = values[0];
    if (!winner) continue;
    result[key] = winner.raw;
    const distinct = new Set(values.map((v) => v.norm));
    if (distinct.size > 1) {
      conflicts.push({
        key,
        values: values.map((v) => ({ agentId: v.agentId, value: v.norm })),
        resolution: `按角色优先级采纳 ${winner.role || winner.agentId} 的取值`,
        resolvedBy: 'priority',
      });
    }
  }
  notes.push(`priority 策略：按角色优先级裁决 ${conflicts.length} 处分歧`);
  // priority 策略下冲突已被明确裁决，无需人工介入
  return { result, conflicts, needsReview: false, notes };
}

/** 仅检测冲突（manual 策略用） */
export function detectConflicts(outputs: AgentOutput[]): Conflict[] {
  const keys = new Set<string>();
  for (const o of outputs) for (const k of Object.keys(o.data)) keys.add(k);
  const conflicts: Conflict[] = [];
  for (const key of keys) {
    const values = outputs.filter((o) => o.data[key] !== undefined).map((o) => ({ agentId: o.agentId, value: normalizeValue(o.data[key]) }));
    if (new Set(values.map((v) => v.value)).size > 1) {
      conflicts.push({ key, values, resolution: '待人工确认', resolvedBy: 'unresolved' });
    }
  }
  return conflicts;
}

export class AggregationStore {
  constructor(private readonly db: Db) {}

  async save(input: AggregateInput): Promise<AggregatedResultInfo> {
    const agg = aggregate(input);
    const id = newId('aggr');
    const now = nowIso();
    await this.db.insert(aggregatedResults).values({
      id,
      taskId: input.taskId,
      goalId: input.goalId ?? null,
      strategy: input.strategy,
      result: agg.result as never,
      conflicts: agg.conflicts as never,
      needsReview: agg.needsReview,
      resolvedAt: agg.needsReview ? null : now,
      createdAt: now,
    } as never);
    return {
      id,
      taskId: input.taskId,
      goalId: input.goalId ?? null,
      strategy: input.strategy,
      result: agg.result,
      conflicts: agg.conflicts,
      needsReview: agg.needsReview,
      resolvedAt: agg.needsReview ? null : now,
      createdAt: now,
    };
  }

  /** 人工确认未决冲突：需要为每个未决 key 指定采纳的 agentId 或自定义值 */
  async resolve(input: { workspaceId: string; id: string; decisions: { key: string; agentId?: string; value?: unknown }[] }) {
    const rows = (await this.db.select().from(aggregatedResults)) as unknown as AggRow[];
    const row = rows.find((r) => r.id === input.id);
    if (!row) throw AppError.notFound(`聚合结果不存在: ${input.id}`);
    const conflicts = (row.conflicts ?? []) as Conflict[];
    const result = { ...(row.result as Record<string, unknown>) };
    const remaining: Conflict[] = [];

    for (const c of conflicts) {
      if (c.resolvedBy !== 'unresolved') continue;
      const decision = input.decisions.find((d) => d.key === c.key);
      if (!decision) {
        remaining.push(c);
        continue;
      }
      if (decision.value !== undefined) {
        result[c.key] = decision.value;
        c.resolution = '人工指定值';
        c.resolvedBy = 'human';
      } else if (decision.agentId) {
        const pick = c.values.find((v) => v.agentId === decision.agentId);
        if (!pick) {
          remaining.push(c);
          continue;
        }
        result[c.key] = pick.value;
        c.resolution = `人工采纳 ${decision.agentId} 的取值`;
        c.resolvedBy = 'human';
      } else {
        remaining.push(c);
      }
    }

    const resolvedAt = nowIso();
    await this.db
      .update(aggregatedResults)
      .set({ result: result as never, conflicts: conflicts as never, needsReview: remaining.length > 0, resolvedAt: remaining.length > 0 ? null : resolvedAt } as never)
      .where(eqId(this.db, row.id));
    return { id: row.id, remaining: remaining.length, needsReview: remaining.length > 0, resolvedAt };
  }

  async get(taskId: string) {
    const rows = (await this.db.select().from(aggregatedResults)) as unknown as AggRow[];
    return rows.filter((r) => r.taskId === taskId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
}

import { eq } from 'drizzle-orm';
function eqId(_db: Db, id: string) {
  return eq(aggregatedResults.id, id);
}

export type AggRow = typeof aggregatedResults.$inferSelect;

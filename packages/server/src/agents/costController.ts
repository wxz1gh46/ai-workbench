import type { CostSummary } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { costRecords } from '../db/schema/index.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';

/**
 * 成本控制（Phase 4 Step 5）。
 *
 * 三层：
 *   1) 计量：每次 Agent 调用写 cost_records（token 入/出 + 模型 + 成本）
 *   2) 预算：工作区/目标级预算，超过阈值 → warn，超过上限 → exceeded（调用方应暂停并行）
 *   3) 预警：跨过阈值时发事件（UI 弹提示 + 可接通知渠道）
 *
 * 为什么不用浮点数直接比较：金额比较必须留误差容忍度，
 * 否则「预算 1.00 用掉 0.9999999」会被判成超限（边界误报）。
 */

export interface BudgetConfig {
  /** 预算上限（美元）；0 或未设置表示不限 */
  limitUsd: number;
  /** 预警阈值比例（默认 0.8） */
  warnRatio?: number;
}

export interface CostInput {
  workspaceId: string;
  goalId?: string | null;
  taskId?: string | null;
  agentId?: string | null;
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** 显式成本（美元）；不传则按价格表计算 */
  costUsd?: number;
}

/** 常用模型价格（美元 / 百万 token）；未知模型按 0 计（并标注估算为 0） */
export const MODEL_PRICES: Record<string, { in: number; out: number }> = {
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-4.1': { in: 2, out: 8 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'claude-3-5-sonnet': { in: 3, out: 15 },
  'claude-3-5-haiku': { in: 0.8, out: 4 },
  'deepseek-chat': { in: 0.27, out: 1.1 },
  'qwen2.5-72b': { in: 0.35, out: 1.4 },
  'local-model': { in: 0, out: 0 },
};

export function estimateCost(model: string, tokensIn: number, tokensOut: number): number {
  const price = MODEL_PRICES[model];
  if (!price) return 0;
  return Math.round(((tokensIn / 1_000_000) * price.in + (tokensOut / 1_000_000) * price.out) * 1e6) / 1e6;
}

export function budgetStateOf(used: number, config: BudgetConfig): { state: 'none' | 'warn' | 'exceeded'; ratio: number } {
  if (!config.limitUsd || config.limitUsd <= 0) return { state: 'none', ratio: 0 };
  const ratio = used / config.limitUsd;
  const warnRatio = config.warnRatio ?? 0.8;
  // 浮点误差：用 1e-9 容差，避免「刚好等于上限」被误判
  if (ratio > 1 + 1e-9) return { state: 'exceeded', ratio };
  if (ratio >= warnRatio) return { state: 'warn', ratio };
  return { state: 'none', ratio };
}

export class CostController {
  constructor(private readonly db: Db) {}

  async record(input: CostInput, budget: BudgetConfig = { limitUsd: 0 }) {
    const cost = input.costUsd ?? estimateCost(input.model, input.tokensIn, input.tokensOut);
    const used = await this.totalCost(input.workspaceId, input.goalId ?? undefined);
    const after = used + cost;
    const { state, ratio } = budgetStateOf(after, budget);
    const id = newId('cost');
    await this.db.insert(costRecords).values({
      id,
      workspaceId: input.workspaceId,
      goalId: input.goalId ?? null,
      taskId: input.taskId ?? null,
      agentId: input.agentId ?? null,
      model: input.model,
      tokensIn: input.tokensIn,
      tokensOut: input.tokensOut,
      cost,
      budgetState: state,
      createdAt: nowIso(),
    } as never);
    if (state === 'warn') {
      logger.warn('token budget warning', { workspaceId: input.workspaceId, used: after, limit: budget.limitUsd, ratio: ratio.toFixed(3) });
    } else if (state === 'exceeded') {
      logger.error('token budget exceeded', { workspaceId: input.workspaceId, used: after, limit: budget.limitUsd });
    }
    return { id, cost, total: after, state, ratio };
  }

  async totalCost(workspaceId: string, goalId?: string): Promise<number> {
    const rows = (await this.db.select().from(costRecords)) as unknown as CostRow[];
    return rows.filter((r) => r.workspaceId === workspaceId && (!goalId || r.goalId === goalId)).reduce((s, r) => s + r.cost, 0);
  }

  async summary(workspaceId: string, budget: BudgetConfig = { limitUsd: 0 }): Promise<CostSummary> {
    const rows = (await this.db.select().from(costRecords)) as unknown as CostRow[];
    const scoped = rows.filter((r) => r.workspaceId === workspaceId);
    const byModelMap = new Map<string, { tokensIn: number; tokensOut: number; cost: number }>();
    const byAgentMap = new Map<string, { tokensIn: number; tokensOut: number; cost: number }>();
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalCost = 0;
    for (const r of scoped) {
      totalTokensIn += r.tokensIn;
      totalTokensOut += r.tokensOut;
      totalCost += r.cost;
      const m = byModelMap.get(r.model) ?? { tokensIn: 0, tokensOut: 0, cost: 0 };
      m.tokensIn += r.tokensIn;
      m.tokensOut += r.tokensOut;
      m.cost += r.cost;
      byModelMap.set(r.model, m);
      const key = r.agentId ?? 'unknown';
      const a = byAgentMap.get(key) ?? { tokensIn: 0, tokensOut: 0, cost: 0 };
      a.tokensIn += r.tokensIn;
      a.tokensOut += r.tokensOut;
      a.cost += r.cost;
      byAgentMap.set(key, a);
    }
    const { state, ratio } = budgetStateOf(totalCost, budget);
    return {
      totalTokensIn,
      totalTokensOut,
      totalCost: round6(totalCost),
      budget: { limit: budget.limitUsd, used: round6(totalCost), ratio: Math.round(ratio * 1000) / 1000, state },
      byModel: [...byModelMap.entries()].map(([model, v]) => ({ model, tokensIn: v.tokensIn, tokensOut: v.tokensOut, cost: round6(v.cost) })).sort((a, b) => b.cost - a.cost),
      byAgent: [...byAgentMap.entries()].map(([agentId, v]) => ({ agentId, tokensIn: v.tokensIn, tokensOut: v.tokensOut, cost: round6(v.cost) })).sort((a, b) => b.cost - a.cost),
    };
  }

  /** 目标维度成本（用于目标页展示「这个目标花了多少钱」） */
  async byGoal(workspaceId: string, goalId: string) {
    const rows = (await this.db.select().from(costRecords)) as unknown as CostRow[];
    const scoped = rows.filter((r) => r.workspaceId === workspaceId && r.goalId === goalId);
    return {
      goalId,
      cost: round6(scoped.reduce((s, r) => s + r.cost, 0)),
      tokensIn: scoped.reduce((s, r) => s + r.tokensIn, 0),
      tokensOut: scoped.reduce((s, r) => s + r.tokensOut, 0),
      records: scoped.length,
    };
  }
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

export type CostRow = typeof costRecords.$inferSelect;

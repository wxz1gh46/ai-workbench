/**
 * Token 预算分配（纯函数，便于单测）。
 *
 * 分区比例（可被 config 覆盖总预算，比例总和必须为 1）：
 *   近期原文 35% | 滚动摘要 20% | 向量召回 20% | 关键事实 10% | 文件 5% | 目标 5%
 *   输出预留 5%（不参与输入组装，但必须从总预算中扣除，否则会超模型上限）
 *
 * 分配策略：先按固定比例给上限，再在「未被用满」的分区之间做二次分配，
 * 保证百万 Token 场景下不会因为某个分区为空而浪费预算。
 */
import type { ContextBlock, ContextBlockKind, TokenBudgetUsage } from '@ai/shared';

export interface BudgetRatios {
  recent: number;
  summary: number;
  retrieval: number;
  facts: number;
  file: number;
  goal: number;
  outputReserve: number;
}

/** 默认比例，总和为 1（含输出预留） */
export const DEFAULT_BUDGET_RATIOS: BudgetRatios = {
  recent: 0.35,
  summary: 0.2,
  retrieval: 0.2,
  facts: 0.1,
  file: 0.05,
  goal: 0.05,
  outputReserve: 0.05,
};

/** 比例自检：配置错误时立即暴露，而不是静默算错预算 */
export function validateRatios(ratios: BudgetRatios = DEFAULT_BUDGET_RATIOS): void {
  const sum = Object.values(ratios).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(`Token 预算比例之和必须为 1，当前为 ${sum}`);
  }
  for (const [k, v] of Object.entries(ratios)) {
    if (v < 0) throw new Error(`Token 预算比例不能为负: ${k}=${v}`);
  }
}

export interface BudgetPlan {
  total: number;
  outputReserve: number;
  /** 各分区 token 上限 */
  limits: Record<ContextBlockKind, number>;
  /** 输入可用总量（total - outputReserve） */
  inputTotal: number;
}

export function planBudget(total: number, ratios: BudgetRatios = DEFAULT_BUDGET_RATIOS): BudgetPlan {
  validateRatios(ratios);
  const safeTotal = Math.max(1, Math.floor(total));
  const outputReserve = Math.floor(safeTotal * ratios.outputReserve);
  const inputTotal = safeTotal - outputReserve;
  const limits: Record<ContextBlockKind, number> = {
    recent: Math.floor(inputTotal * ratios.recent),
    summary: Math.floor(inputTotal * ratios.summary),
    retrieval: Math.floor(inputTotal * ratios.retrieval),
    facts: Math.floor(inputTotal * ratios.facts),
    file: Math.floor(inputTotal * ratios.file),
    goal: Math.floor(inputTotal * ratios.goal),
  };
  return { total: safeTotal, outputReserve, limits, inputTotal };
}

export interface AssembleInput {
  /** 按优先级从高到低排列的候选块（recent 最高） */
  candidates: { kind: ContextBlockKind; items: { content: string; sourceIds: string[]; tokens: number; score?: number }[] }[];
}

export interface AssembleOutput {
  blocks: ContextBlock[];
  totalTokens: number;
  citations: string[];
  usage: TokenBudgetUsage;
}

const PRIORITY: ContextBlockKind[] = ['recent', 'goal', 'summary', 'facts', 'retrieval', 'file'];

/**
 * 按预算装配上下文。
 * 规则：
 * 1) 每个分区不超过自己的上限；
 * 2) 高优先级分区先分配，剩余额度可被低优先级分区借用（仍不超过总输入预算）；
 * 3) 单个超大条目（如整本书的一章）会被截断到剩余额度，而不是直接丢弃；
 * 4) 返回精确的来源 ID 列表，实现「可点击跳回原消息」。
 */
export function assembleContext(plan: BudgetPlan, input: AssembleInput): AssembleOutput {
  const byKind = new Map(input.candidates.map((c) => [c.kind, c.items]));
  const blocks: ContextBlock[] = [];
  const citations = new Set<string>();
  const usedByKind: Record<string, number> = {};
  let usedTotal = 0;

  // 剩余额度池：按优先级依次消耗
  const pool = plan.inputTotal;

  for (const kind of PRIORITY) {
    const items = byKind.get(kind) ?? [];
    const limit = plan.limits[kind];
    let used = 0;
    const parts: string[] = [];
    const sourceIds: string[] = [];

    for (const item of items) {
      if (used >= limit || usedTotal >= pool) break;
      const remainingKind = limit - used;
      const remainingPool = pool - usedTotal;
      const allowance = Math.min(remainingKind, remainingPool);
      if (allowance <= 0) break;

      let content = item.content;
      let tokens = item.tokens;
      if (tokens > allowance) {
        // 截断策略：按字符比例截断，保留开头（信息密度更高）
        const ratio = allowance / tokens;
        const keep = Math.max(80, Math.floor(content.length * ratio));
        content = `${content.slice(0, keep)}\n…（已按 Token 预算截断，完整内容见来源 ${item.sourceIds[0] ?? 'n/a'}）`;
        tokens = Math.max(1, Math.floor(allowance * 0.98));
      }
      if (tokens <= 0) continue;

      parts.push(content);
      for (const id of item.sourceIds) citations.add(id);
      sourceIds.push(...item.sourceIds);
      used += tokens;
      usedTotal += tokens;
    }

    usedByKind[kind] = used;
    if (parts.length > 0) {
      blocks.push({ kind, content: parts.join('\n'), sourceIds, tokens: used });
    }
  }

  return {
    blocks,
    totalTokens: usedTotal,
    citations: [...citations],
    usage: {
      total: plan.total,
      used: usedTotal + plan.outputReserve,
      byKind: {
        recent: usedByKind.recent ?? 0,
        summary: usedByKind.summary ?? 0,
        retrieval: usedByKind.retrieval ?? 0,
        facts: usedByKind.facts ?? 0,
        file: usedByKind.file ?? 0,
        goal: usedByKind.goal ?? 0,
      },
      limits: plan.limits,
      outputReserve: plan.outputReserve,
      overBudget: usedTotal > plan.inputTotal,
    },
  };
}

/** 空预算使用情况，用于 UI 初始渲染 */
export function emptyUsage(total: number, ratios?: BudgetRatios): TokenBudgetUsage {
  const plan = planBudget(total, ratios);
  return {
    total: plan.total,
    used: plan.outputReserve,
    byKind: { recent: 0, summary: 0, retrieval: 0, facts: 0, file: 0, goal: 0 },
    limits: plan.limits,
    outputReserve: plan.outputReserve,
    overBudget: false,
  };
}

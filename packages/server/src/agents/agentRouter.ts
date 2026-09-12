import type { Db } from '../db/client.ts';
import { agentRoutes } from '../db/schema/index.ts';
import { newId, nowIso } from '../utils/ids.ts';
import type { AgentPoolInfo } from '@ai/shared';

/**
 * 模型 / 工具 / Agent 路由（Phase 4 Step 5）。
 *
 * 三类路由统一成「打分 + 可解释」：
 *   - 模型路由：按任务类型、上下文长度、成本选择（长上下文 → 长上下文模型；便宜任务 → 便宜模型）
 *   - 工具路由：按任务关键词 → 候选工具（不调用未注册工具）
 *   - Agent 路由：按角色匹配 + 池容量 + 优先级
 *
 * 每次路由都写 agent_routes（含 reason 与 score），
 * 这样「为什么这个任务交给了那个 Agent」永远可查 —— 多 Agent 系统最缺的就是这个。
 */

export interface ModelCandidate {
  model: string;
  /** 上下文窗口（token） */
  contextWindow: number;
  /** 每百万 token 输入价格（美元），用于成本打分 */
  inputPricePerM: number;
  outputPricePerM: number;
  /** 擅长的任务类型 */
  strengths: string[];
  /** 是否支持长上下文（百万级） */
  longContext?: boolean;
}

export interface ModelRouteInput {
  taskKind: string;
  estimatedInputTokens: number;
  /** 是否对质量敏感（写作/评审 → true；批量抽取 → false） */
  qualitySensitive?: boolean;
  /** 单次成本上限（美元），超出则不选 */
  maxCostUsd?: number;
  candidates: ModelCandidate[];
}

export interface ModelRouteOutput {
  model: string;
  reason: string;
  score: number;
  estimatedCostUsd: number;
  rejected: { model: string; reason: string }[];
}

export function routeModel(input: ModelRouteInput): ModelRouteOutput {
  const rejected: { model: string; reason: string }[] = [];
  const estimatedOutput = Math.max(256, Math.round(input.estimatedInputTokens * 0.25));

  const scored: { c: ModelCandidate; score: number; cost: number }[] = [];
  for (const c of input.candidates) {
    if (c.contextWindow < input.estimatedInputTokens) {
      rejected.push({ model: c.model, reason: `上下文窗口 ${c.contextWindow} 小于所需 ${input.estimatedInputTokens}` });
      continue;
    }
    const cost = (input.estimatedInputTokens / 1_000_000) * c.inputPricePerM + (estimatedOutput / 1_000_000) * c.outputPricePerM;
    if (input.maxCostUsd !== undefined && cost > input.maxCostUsd) {
      rejected.push({ model: c.model, reason: `预估成本 $${cost.toFixed(4)} 超上限 $${input.maxCostUsd}` });
      continue;
    }
    let score = 50;
    if (c.strengths.includes(input.taskKind)) score += 25;
    if (input.qualitySensitive && c.inputPricePerM > 1) score += 10;
    if (c.longContext && input.estimatedInputTokens > 100_000) score += 20;
    // 成本惩罚：便宜模型优先（同样满足要求时）
    score -= Math.min(20, cost * 200);
    scored.push({ c, score, cost });
  }

  if (scored.length === 0) {
    return { model: '', reason: '没有满足上下文窗口与成本上限的模型', score: 0, estimatedCostUsd: 0, rejected };
  }
  scored.sort((a, b) => b.score - a.score || (a.c.model < b.c.model ? -1 : 1));
  const best = scored[0]!;
  const reasons: string[] = [];
  if (best.c.strengths.includes(input.taskKind)) reasons.push(`擅长 ${input.taskKind}`);
  if (input.estimatedInputTokens > 100_000) reasons.push('长上下文需求');
  reasons.push(`预估成本 $${best.cost.toFixed(4)}`);
  return { model: best.c.model, reason: reasons.join('；'), score: Math.round(best.score * 100) / 100, estimatedCostUsd: best.cost, rejected };
}

/* ------------------------------ 工具路由 ------------------------------ */

export interface ToolCandidate {
  name: string;
  /** 关键词 → 相关性 */
  keywords: string[];
  /** 危险工具需要用户确认 */
  dangerous?: boolean;
  /** 需要联网（未启用联网时排除） */
  network?: boolean;
}

export function routeTools(input: { taskText: string; candidates: ToolCandidate[]; networkAllowed: boolean; maxTools?: number }): {
  tools: string[];
  scores: { name: string; score: number }[];
  excluded: { name: string; reason: string }[];
} {
  const text = input.taskText.toLowerCase();
  const excluded: { name: string; reason: string }[] = [];
  const scored: { name: string; score: number }[] = [];
  for (const t of input.candidates) {
    if (t.network && !input.networkAllowed) {
      excluded.push({ name: t.name, reason: '任务需要联网，但当前未允许联网' });
      continue;
    }
    const hits = t.keywords.filter((k) => text.includes(k.toLowerCase())).length;
    const score = hits * 10 - (t.dangerous ? 3 : 0);
    if (score > 0) scored.push({ name: t.name, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1));
  const limit = input.maxTools ?? 5;
  return { tools: scored.slice(0, limit).map((s) => s.name), scores: scored.slice(0, limit), excluded };
}

/* ------------------------------ Agent 路由 ------------------------------ */

export interface AgentRouteInput {
  taskKind: string;
  requiredRole?: string;
  pools: AgentPoolInfo[];
  /** 各角色当前忙碌数 */
  busyByRole: Record<string, number>;
  /** 指定的 Agent（用户手动指派时优先） */
  pinnedAgentId?: string;
}

export interface AgentRouteOutput {
  role: string;
  agentId: string | null;
  reason: string;
  score: number;
  alternatives: { role: string; score: number }[];
}

/** 角色 ↔ 任务类型映射（与内置 Agent 角色一致） */
const ROLE_AFFINITY: Record<string, string[]> = {
  coordinator: ['planning', 'orchestration', 'general'],
  researcher: ['research', 'search', 'fact-check'],
  coder: ['code', 'refactor', 'test'],
  writer: ['document', 'writing', 'report'],
  analyst: ['data-analysis', 'analysis', 'metrics'],
  reviewer: ['review', 'critic', 'audit'],
  operator: ['deploy', 'ops', 'schedule'],
};

export function routeAgent(input: AgentRouteInput): AgentRouteOutput {
  const candidates: { role: string; score: number; reason: string }[] = [];
  for (const pool of input.pools) {
    if (pool.status !== 'active') continue;
    const busy = input.busyByRole[pool.role] ?? 0;
    const headroom = pool.activeAgents - busy;
    if (headroom <= 0) continue;
    const affinity = ROLE_AFFINITY[pool.role] ?? [];
    let score = 30 + Math.min(20, headroom * 5);
    const reasons: string[] = [`剩余容量 ${headroom}`];
    if (input.requiredRole && pool.role === input.requiredRole) {
      score += 40;
      reasons.push('指定角色');
    }
    if (affinity.includes(input.taskKind)) {
      score += 25;
      reasons.push(`角色匹配 ${input.taskKind}`);
    }
    candidates.push({ role: pool.role, score, reason: reasons.join('；') });
  }

  if (candidates.length === 0) {
    return { role: input.requiredRole ?? 'coordinator', agentId: null, reason: '没有可用容量的 Agent 池，已回退到协调者单干', score: 0, alternatives: [] };
  }
  candidates.sort((a, b) => b.score - a.score || (a.role < b.role ? -1 : 1));
  const best = candidates[0]!;
  return {
    role: best.role,
    agentId: input.pinnedAgentId ?? null,
    reason: best.reason,
    score: Math.round(best.score * 100) / 100,
    alternatives: candidates.slice(1).map((c) => ({ role: c.role, score: Math.round(c.score * 100) / 100 })),
  };
}

/* ------------------------------ 落库 ------------------------------ */

export class RouteRecorder {
  constructor(private readonly db: Db) {}

  async record(input: { taskId: string; agentId: string; poolId?: string | null; reason: string; score: number; kind: 'agent' | 'model' | 'tool'; detail?: Record<string, unknown> }) {
    const id = newId('aroute');
    await this.db.insert(agentRoutes).values({
      id,
      taskId: input.taskId,
      agentId: input.agentId,
      poolId: input.poolId ?? null,
      reason: input.reason,
      score: input.score,
      kind: input.kind,
      detail: (input.detail ?? {}) as never,
      createdAt: nowIso(),
    } as never);
    return id;
  }

  async list(taskId: string) {
    const rows = (await this.db.select().from(agentRoutes)) as unknown as RouteRow[];
    return rows.filter((r) => r.taskId === taskId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async listRecent(limit = 100) {
    const rows = (await this.db.select().from(agentRoutes)) as unknown as RouteRow[];
    return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit);
  }
}

export type RouteRow = typeof agentRoutes.$inferSelect;

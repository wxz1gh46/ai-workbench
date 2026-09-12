import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { agentPools, agents } from '../db/schema/index.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';

/**
 * Agent 池（Phase 4 Step 5）。
 *
 * 设计要点：
 *   - 池 = 「角色 + 数量区间 + 模型/工具约束」，不是进程池（单机场景用逻辑计数即可）
 *   - min/max 必须满足 min ≤ active ≤ max：扩容/缩容都做边界校验，
 *     不允许出现「池里 0 个 Agent 却还有任务在跑」的状态
 *   - 缩容时不允许驱逐「正在执行任务」的 Agent：直接拒绝并说明原因
 */

export interface CreatePoolInput {
  workspaceId: string;
  name: string;
  role: string;
  minAgents?: number;
  maxAgents?: number;
  model?: string | null;
  tools?: string[];
}

export class AgentPoolService {
  constructor(private readonly db: Db) {}

  async list(workspaceId: string) {
    return (await this.db.select().from(agentPools).where(eq(agentPools.workspaceId, workspaceId))) as unknown as PoolRow[];
  }

  async get(workspaceId: string, id: string): Promise<PoolRow> {
    const rows = (await this.db.select().from(agentPools).where(eq(agentPools.workspaceId, workspaceId))) as unknown as PoolRow[];
    const row = rows.find((r) => r.id === id || r.role === id);
    if (!row) throw AppError.notFound(`Agent 池不存在: ${id}`);
    return row;
  }

  /** 按角色取池；不存在则按内置角色自动创建（首次使用时不需要用户先手动建池） */
  async ensurePool(workspaceId: string, role: string, defaults: { min?: number; max?: number; model?: string | null; tools?: string[] } = {}) {
    const pools = await this.list(workspaceId);
    const found = pools.find((p) => p.role === role);
    if (found) return found;
    return this.create({
      workspaceId,
      name: `${role} 池`,
      role,
      minAgents: defaults.min ?? 1,
      maxAgents: defaults.max ?? 4,
      model: defaults.model ?? null,
      tools: defaults.tools ?? [],
    });
  }

  async create(input: CreatePoolInput) {
    const min = input.minAgents ?? 1;
    const max = input.maxAgents ?? 4;
    validateRange(min, max);
    const existing = await this.list(input.workspaceId);
    if (existing.some((p) => p.role === input.role)) {
      throw AppError.conflict(`该角色已有 Agent 池：${input.role}（一个角色只应有一个池，否则调度会不确定）`);
    }
    const now = nowIso();
    const row = {
      id: newId('apool'),
      workspaceId: input.workspaceId,
      name: input.name.trim(),
      role: input.role.trim(),
      minAgents: min,
      maxAgents: max,
      activeAgents: min,
      model: input.model ?? null,
      tools: (input.tools ?? []) as never,
      status: 'active' as const,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(agentPools).values(row as never);
    return row as unknown as PoolRow;
  }

  /**
   * 扩缩容。
   * 缩容前检查该角色下是否有正在执行任务的 Agent（agents.current_task_id 非空）：
   * 有则拒绝 —— 「任务被悄悄丢掉」是最难排查的问题之一。
   */
  async scale(input: { workspaceId: string; idOrRole: string; target: number }): Promise<{ pool: PoolRow; changed: number; reason: string }> {
    const pool = await this.get(input.workspaceId, input.idOrRole);
    if (!Number.isInteger(input.target) || input.target < 0 || input.target > 64) {
      throw AppError.badRequest(`目标实例数必须是 0~64 的整数（收到 ${input.target}）`);
    }
    if (input.target < pool.minAgents) {
      throw AppError.badRequest(`目标 ${input.target} 小于池的最小实例数 ${pool.minAgents}；请先调小 minAgents`);
    }
    if (input.target > pool.maxAgents) {
      throw AppError.badRequest(`目标 ${input.target} 超过池的最大实例数 ${pool.maxAgents}；请先调大 maxAgents`);
    }

    const delta = input.target - pool.activeAgents;
    if (delta < 0) {
      const busy = await this.busyAgents(input.workspaceId, pool.role);
      // 缩容后剩余实例数必须能容纳所有忙碌 Agent：否则会出现「实例被砍掉但任务还在跑」
      const remaining = pool.activeAgents + delta;
      if (remaining < busy.length) {
        throw AppError.conflict(
          `缩容被拒绝：该角色有 ${busy.length} 个 Agent 正在执行任务，缩容到 ${input.target} 会让 ${busy.length - remaining} 个运行中的任务失去归属。请等任务结束后重试（或先把目标设为 ≥ ${busy.length}）。`,
        );
      }
    }

    await this.db.update(agentPools).set({ activeAgents: input.target, updatedAt: nowIso() } as never).where(eq(agentPools.id, pool.id));
    const updated = await this.get(input.workspaceId, pool.id);
    return { pool: updated, changed: delta, reason: delta === 0 ? '实例数未变化' : delta > 0 ? `扩容 ${delta} 个` : `缩容 ${-delta} 个` };
  }

  async update(workspaceId: string, idOrRole: string, patch: Partial<CreatePoolInput> & { status?: PoolRow['status'] }) {
    const pool = await this.get(workspaceId, idOrRole);
    const min = patch.minAgents ?? pool.minAgents;
    const max = patch.maxAgents ?? pool.maxAgents;
    validateRange(min, max);
    if (pool.activeAgents < min) {
      throw AppError.badRequest(`当前实例数 ${pool.activeAgents} 小于新的 minAgents ${min}，请先扩容`);
    }
    await this.db
      .update(agentPools)
      .set({
        name: patch.name ?? pool.name,
        minAgents: min,
        maxAgents: max,
        model: patch.model === undefined ? pool.model : patch.model,
        tools: (patch.tools ?? (pool.tools as string[])) as never,
        status: patch.status ?? pool.status,
        updatedAt: nowIso(),
      } as never)
      .where(eq(agentPools.id, pool.id));
    return this.get(workspaceId, pool.id);
  }

  /** 该角色正在执行任务的 Agent（用于缩容保护与「忙碌度」展示） */
  async busyAgents(workspaceId: string, role: string) {
    const rows = (await this.db.select().from(agents).where(eq(agents.workspaceId, workspaceId))) as unknown as { id: string; role: string; currentTaskId: string | null }[];
    return rows.filter((a) => a.role === role && a.currentTaskId);
  }
}

function validateRange(min: number, max: number): void {
  if (!Number.isInteger(min) || min < 0) throw AppError.badRequest(`minAgents 必须是非负整数（收到 ${min}）`);
  if (!Number.isInteger(max) || max < 1) throw AppError.badRequest(`maxAgents 必须是正整数（收到 ${max}）`);
  if (min > max) throw AppError.badRequest(`minAgents(${min}) 不能大于 maxAgents(${max})`);
}

export type PoolRow = typeof agentPools.$inferSelect;

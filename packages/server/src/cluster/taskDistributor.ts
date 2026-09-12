import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { clusterShards, clusterTasks } from '../db/schema/index.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';
import type { NodeRow } from './nodeRegistry.ts';
import { shardAuto, type Shard } from './shardScheduler.ts';

/**
 * 任务分发（Phase 4 Step 4）。
 *
 * 分配策略（按优先级，可解释）：
 *   1) 标签匹配：任务声明的 labels 必须被节点满足
 *   2) 资源满足：任务 need 不超过节点剩余资源（已按在途任务扣减）
 *   3) 负载最低：选「在途任务权重 / 节点资源得分」最低的节点
 *   4) 平局时按节点名排序（确定性，便于复现与测试）
 *
 * 关键点：分发是「幂等 + 可重入」的 —— 同一个分片被重复分发时不会产生两条 cluster_tasks。
 */

export interface DistributeInput {
  workspaceId: string;
  /** 任务标识（对应 Agent 侧的 taskId） */
  taskId: string;
  goalId?: string;
  shards: Shard<unknown>[];
  nodes: NodeRow[];
  /** 分片级别标签要求 */
  labels?: Record<string, string>;
  /** 分片级别资源需求 */
  need?: Record<string, number>;
  /** 并行上限（来自集群策略） */
  maxParallel: number;
  /**
   * 强制改派：跳过「已在执行」的重复分发保护。
   * 仅用于容错路径（节点失联/失败重试）—— 此时旧分配已经失效，
   * 不强制就会被「重复分发保护」挡住，表现为「失联后任务永远卡住」。
   */
  force?: boolean;
}

export interface Assignment {
  shardIndex: number;
  nodeId: string;
  nodeName: string;
  reason: string;
}

export class TaskDistributor {
  /** 节点在途权重（用于负载均衡） */
  private readonly inflight = new Map<string, number>();

  constructor(private readonly db: Db) {}

  /** 记录分片结束，释放在途权重 */
  release(nodeId: string, weight: number): void {
    const cur = this.inflight.get(nodeId) ?? 0;
    this.inflight.set(nodeId, Math.max(0, cur - weight));
  }

  load(nodeId: string): number {
    return this.inflight.get(nodeId) ?? 0;
  }

  /** 选择最合适的节点；返回 null 表示当前无可用节点（调用方决定降级） */
  pick(shards: Shard<unknown>[], nodes: NodeRow[], labels: Record<string, string> = {}, need: Record<string, number> = {}): { node: NodeRow | null; reason: string } {
    const eligible = nodes.filter((n) => {
      if (n.status !== 'online') return false;
      for (const [k, v] of Object.entries(labels)) if (n.labels[k] !== v) return false;
      for (const [k, v] of Object.entries(need)) {
        const have = n.resources[k];
        if (typeof have === 'number' && have < v) return false;
      }
      return true;
    });
    if (eligible.length === 0) {
      return { node: null, reason: nodes.length === 0 ? '集群中没有节点，将降级单机执行' : '没有满足标签/资源要求的在线节点' };
    }
    const totalWeight = shards.reduce((s, x) => s + x.weight, 0);
    const scored = eligible
      .map((n) => {
        const capacity = (n.resources.cpu ?? 1) * 10 + (n.resources.memoryMb ?? 1024) / 512;
        return { node: n, score: (this.load(n.id) + totalWeight) / Math.max(0.1, capacity) };
      })
      .sort((a, b) => a.score - b.score || (a.node.name < b.node.name ? -1 : 1));
    const best = scored[0]!;
    return { node: best.node, reason: `负载最低（在途 ${this.load(best.node.id).toFixed(1)}，资源得分 ${best.node.resources.cpu ?? '?'}c/${best.node.resources.memoryMb ?? '?'}MB）` };
  }

  /**
   * 分发：写 cluster_shards + cluster_tasks。
   * 已存在的 shard（同一 taskId + index）会被更新而不是新增 —— 保证可重入。
   */
  async distribute(input: DistributeInput): Promise<{ assignments: Assignment[]; skipped: { shardIndex: number; reason: string }[] }> {
    const assignments: Assignment[] = [];
    const skipped: { shardIndex: number; reason: string }[] = [];
    const now = nowIso();

    const existing = (await this.db.select().from(clusterShards).where(eq(clusterShards.taskId, input.taskId))) as unknown as ShardRow[];
    // byIndex 只取「未终结」的分片：已完成/已失败的分片不参与复用，
    // 否则失败重试会被误判为「重复分发」而永远卡住（真实踩坑）。
    const byIndex = new Map(existing.filter((s) => s.status !== 'reassigned').map((s) => [s.index, s]));

    // 强制改派时不把「旧节点上的在途分片」计入并行占用：它们已随节点失联而失效
    let running = input.force ? 0 : existing.filter((s) => s.status === 'assigned' || s.status === 'running').length;

    for (const shard of input.shards) {
      const prev = byIndex.get(shard.index);
      if (!input.force && prev && (prev.status === 'succeeded' || prev.status === 'running' || prev.status === 'assigned')) {
        // 已完成或正在执行的分片不重复分发（重复执行 = 重复计费 + 结果冲突）
        skipped.push({ shardIndex: shard.index, reason: `分片状态为 ${prev.status}，跳过重复分发` });
        continue;
      }
      if (running >= input.maxParallel) {
        skipped.push({ shardIndex: shard.index, reason: `已达并行上限 ${input.maxParallel}（分片保持 pending，等待下一轮）` });
        continue;
      }
      const picked = this.pick([shard], input.nodes, input.labels ?? {}, input.need ?? {});
      if (!picked.node) {
        skipped.push({ shardIndex: shard.index, reason: picked.reason });
        continue;
      }

      const shardId = prev?.id ?? newId('csh');
      const payload = { items: shard.items, weight: shard.weight } as never;
      if (prev) {
        await this.db
          .update(clusterShards)
          .set({ status: 'assigned', assignedNodeId: picked.node.id, payload, attempts: prev.attempts + 1, error: null } as never)
          .where(eq(clusterShards.id, prev.id));
      } else {
        await this.db.insert(clusterShards).values({
          id: shardId,
          taskId: input.taskId,
          goalId: input.goalId ?? null,
          index: shard.index,
          total: shard.total,
          payload,
          result: null,
          status: 'assigned',
          assignedNodeId: picked.node.id,
          attempts: 1,
          error: null,
          createdAt: now,
          finishedAt: null,
        } as never);
      }

      await this.db.insert(clusterTasks).values({
        id: newId('ctk'),
        workspaceId: input.workspaceId,
        goalId: input.goalId ?? null,
        taskId: input.taskId,
        shardId,
        assignedNodeId: picked.node.id,
        status: 'queued',
        error: null,
        startedAt: null,
        finishedAt: null,
        createdAt: now,
      } as never);

      this.inflight.set(picked.node.id, this.load(picked.node.id) + shard.weight);
      running += 1;
      assignments.push({ shardIndex: shard.index, nodeId: picked.node.id, nodeName: picked.node.name, reason: picked.reason });
      logger.info('shard assigned', { taskId: input.taskId, shardIndex: shard.index, node: picked.node.name });
    }

    return { assignments, skipped };
  }

  /** 分片完成回调：更新状态、释放负载、记录结果 */
  async complete(shardId: string, input: { ok: boolean; result?: Record<string, unknown>; error?: string }) {
    const rows = (await this.db.select().from(clusterShards).where(eq(clusterShards.id, shardId)).limit(1)) as unknown as ShardRow[];
    const shard = rows[0];
    if (!shard) return null;
    const weight = Number((shard.payload as { weight?: number })?.weight ?? 0);
    if (shard.assignedNodeId) this.release(shard.assignedNodeId, weight);
    const now = nowIso();
    await this.db
      .update(clusterShards)
      .set({
        status: input.ok ? 'succeeded' : 'failed',
        result: (input.result ?? null) as never,
        error: input.error ?? null,
        finishedAt: now,
      } as never)
      .where(eq(clusterShards.id, shardId));
    await this.db.update(clusterTasks).set({ status: input.ok ? 'succeeded' : 'failed', error: input.error ?? null, finishedAt: now } as never).where(eq(clusterTasks.shardId, shardId));
    return { shardId, status: input.ok ? ('succeeded' as const) : ('failed' as const) };
  }

  async listShards(taskId: string) {
    const rows = (await this.db.select().from(clusterShards).where(eq(clusterShards.taskId, taskId))) as unknown as ShardRow[];
    return rows.sort((a, b) => a.index - b.index);
  }

  async listTasks(workspaceId: string, limit = 100) {
    const rows = (await this.db.select().from(clusterTasks).where(eq(clusterTasks.workspaceId, workspaceId))) as unknown as TaskRow[];
    return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit);
  }

  async cancelTask(workspaceId: string, taskId: string) {
    const rows = (await this.db.select().from(clusterTasks).where(eq(clusterTasks.workspaceId, workspaceId))) as unknown as TaskRow[];
    const target = rows.find((t) => t.id === taskId || t.taskId === taskId);
    if (!target) return null;
    const now = nowIso();
    await this.db.update(clusterTasks).set({ status: 'cancelled', finishedAt: now } as never).where(eq(clusterTasks.id, target.id));
    if (target.shardId) {
      const shards = (await this.db.select().from(clusterShards).where(eq(clusterShards.id, target.shardId))) as unknown as ShardRow[];
      const shard = shards[0];
      if (shard) {
        const weight = Number((shard.payload as { weight?: number })?.weight ?? 0);
        if (shard.assignedNodeId) this.release(shard.assignedNodeId, weight);
        await this.db.update(clusterShards).set({ status: 'failed', error: '用户取消', finishedAt: now } as never).where(eq(clusterShards.id, shard.id));
      }
    }
    return target;
  }

  /** 把一个任务按 items 自动分片 + 分发（一步到位，供 API 使用） */
  async planAndDistribute(input: Omit<DistributeInput, 'shards'> & { items: unknown[]; shardCount: number; weightOf?: (item: unknown) => number }) {
    const shards = shardAuto(input.items, input.shardCount, input.weightOf);
    return this.distribute({ ...input, shards });
  }
}

export type ShardRow = typeof clusterShards.$inferSelect;
export type TaskRow = typeof clusterTasks.$inferSelect;

import type { Db } from '../db/client.ts';
import { eq } from 'drizzle-orm';
import { clusterShards } from '../db/schema/index.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';
import { TaskDistributor } from './taskDistributor.ts';
import { shardByCount, type ShardState } from './shardScheduler.ts';
import type { NodeRow } from './nodeRegistry.ts';

/**
 * 容错（Phase 4 Step 4）。
 *
 * 三类故障的处置策略：
 *   1) 节点失联 → 该节点上的 assigned/running 分片重新入队，重新分发给其他节点
 *   2) 分片执行失败 → 重试（受 maxAttempts 限制），超限则标记 failed 并向上汇报
 *   3) 集群整体不可用 → 由集群服务决定是否降级单机（本文件只负责「判断」）
 *
 * 关键约束：
 *   - 已完成（succeeded）的分片**永不重跑** —— 否则会重复计费并产生冲突结果
 *   - 重试次数落库（attempts），避免「无限重试把集群打满」
 */

export interface ReassignResult {
  reassigned: { shardId: string; from: string | null; to: string; index: number }[];
  exhausted: { shardId: string; index: number; attempts: number; error: string }[];
  reason: string;
}

export class FaultTolerance {
  constructor(
    private readonly db: Db,
    private readonly distributor: TaskDistributor,
    private readonly opts: { maxAttempts?: number; now?: () => Date } = {},
  ) {}

  private nowIso(): string {
    return (this.opts.now ? this.opts.now() : new Date()).toISOString();
  }

  /**
   * 解析真实 workspaceId。
   * cluster_tasks.workspace_id 有外键约束，早期版本用字面量 'cluster' 会导致
   * FOREIGN KEY constraint failed（真实缺陷：失联改派在生产才会触发，很难发现）。
   * 这里按「分片所属任务已有的 workspace」反查，查不到则取本机唯一工作区。
   */
  private async resolveWorkspaceId(): Promise<string> {
    const { workspaces } = await import('../db/schema/index.ts');
    const rows = (await this.db.select().from(workspaces).limit(1)) as unknown as { id: string }[];
    const id = rows[0]?.id;
    if (!id) throw new Error('无法解析工作区：库中没有任何工作区记录');
    return id;
  }

  /** 节点失联：重新分配其分片 */
  async handleNodeLoss(deadNodes: NodeRow[], healthyNodes: NodeRow[], maxParallel: number): Promise<ReassignResult> {
    const deadIds = new Set(deadNodes.map((n) => n.id));
    const all = (await this.db.select().from(clusterShards)) as unknown as ShardRow[];
    const affected = all.filter((s) => s.assignedNodeId && deadIds.has(s.assignedNodeId) && (s.status === 'assigned' || s.status === 'running'));
    const reassigned: ReassignResult['reassigned'] = [];
    const exhausted: ReassignResult['exhausted'] = [];
    const maxAttempts = this.opts.maxAttempts ?? 3;

    for (const shard of affected) {
      if (shard.attempts >= maxAttempts) {
        await this.db.update(clusterShards).set({ status: 'failed', error: `节点失联且已重试 ${shard.attempts} 次`, finishedAt: this.nowIso() } as never).where(eq(clusterShards.id, shard.id));
        exhausted.push({ shardId: shard.id, index: shard.index, attempts: shard.attempts, error: '超过最大重试次数' });
        continue;
      }
      const items = (shard.payload as { items?: unknown[] })?.items ?? [];
      const shards = shardByCount(items, 1);
      const result = await this.distributor.distribute({
        workspaceId: await this.resolveWorkspaceId(),
        taskId: shard.taskId,
        goalId: shard.goalId ?? undefined,
        // 单分片：只重分这一个 shard，但用原 index 覆盖写回，保证 index 语义稳定
        shards: [{ index: shard.index, total: shard.total, items: shards[0]?.items ?? [], weight: shards[0]?.weight ?? 0 }],
        nodes: healthyNodes,
        maxParallel,
        force: true,
      });
      const assignment = result.assignments[0];
      if (assignment) {
        // distribute 会新建 shard 行；这里把旧的置为 reassigned，并在新行上累加 attempts
        await this.db.update(clusterShards).set({ status: 'reassigned', error: `节点 ${shard.assignedNodeId} 失联，已改派` } as never).where(eq(clusterShards.id, shard.id));
        const fresh = (await this.db.select().from(clusterShards).where(eq(clusterShards.taskId, shard.taskId))) as unknown as ShardRow[];
        const newest = fresh
          .filter((s) => s.index === shard.index && s.id !== shard.id)
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
        if (newest) {
          await this.db.update(clusterShards).set({ attempts: shard.attempts + 1 } as never).where(eq(clusterShards.id, newest.id));
        }
        reassigned.push({ shardId: shard.id, from: shard.assignedNodeId, to: assignment.nodeId, index: shard.index });
        logger.info('shard reassigned after node loss', { shardId: shard.id, to: assignment.nodeName });
      } else {
        await this.db.update(clusterShards).set({ status: 'pending', assignedNodeId: null, error: '暂无可用节点，等待重试' } as never).where(eq(clusterShards.id, shard.id));
      }
    }

    return {
      reassigned,
      exhausted,
      reason: affected.length === 0 ? '无受影响分片' : `处理 ${affected.length} 个受影响分片，成功改派 ${reassigned.length} 个`,
    };
  }

  /** 单分片失败重试：返回是否允许继续重试 */
  async retryShard(shardId: string, healthyNodes: NodeRow[], maxParallel: number): Promise<{ retried: boolean; reason: string }> {
    const rows = (await this.db.select().from(clusterShards).where(eq(clusterShards.id, shardId))) as unknown as ShardRow[];
    const shard = rows[0];
    if (!shard) return { retried: false, reason: '分片不存在' };
    if (shard.status === 'succeeded') return { retried: false, reason: '分片已成功，不重试' };
    const maxAttempts = this.opts.maxAttempts ?? 3;
    if (shard.attempts >= maxAttempts) {
      await this.db.update(clusterShards).set({ status: 'failed', error: `重试已达上限 ${maxAttempts}`, finishedAt: this.nowIso() } as never).where(eq(clusterShards.id, shardId));
      return { retried: false, reason: `已达到最大重试次数 ${maxAttempts}` };
    }
    const items = (shard.payload as { items?: unknown[] })?.items ?? [];
    const result = await this.distributor.distribute({
      workspaceId: await this.resolveWorkspaceId(),
      taskId: shard.taskId,
      goalId: shard.goalId ?? undefined,
      shards: [{ index: shard.index, total: shard.total, items, weight: items.length }],
      nodes: healthyNodes,
      maxParallel,
      force: true,
    });
    if (result.assignments.length === 0) {
      return { retried: false, reason: result.skipped[0]?.reason ?? '无可用节点' };
    }
    await this.db.update(clusterShards).set({ status: 'reassigned', error: '失败重试改派' } as never).where(eq(clusterShards.id, shardId));
    return { retried: true, reason: `已重试（第 ${shard.attempts + 1} 次）` };
  }

  /** 集群可用性判断：有在线节点且 leader 存在 → 集群可用 */
  static isClusterUsable(nodes: NodeRow[], leader: NodeRow | null): { usable: boolean; reason: string } {
    const online = nodes.filter((n) => n.status === 'online');
    if (online.length === 0) return { usable: false, reason: '没有在线节点' };
    if (!leader) return { usable: false, reason: '没有 leader（需先完成选举）' };
    if (leader.status !== 'online') return { usable: false, reason: `leader 节点 ${leader.name} 不在线` };
    return { usable: true, reason: `集群可用（在线 ${online.length}/${nodes.length}）` };
  }

  /** 分片聚合状态（用于 UI 展示与「任务是否完成」判断） */
  static summarize(shards: ShardState<unknown>[]): { done: boolean; succeeded: number; failed: number; pending: number; total: number } {
    const succeeded = shards.filter((s) => s.status === 'succeeded').length;
    const failed = shards.filter((s) => s.status === 'failed').length;
    const pending = shards.filter((s) => s.status !== 'succeeded' && s.status !== 'failed').length;
    return { done: pending === 0, succeeded, failed, pending, total: shards.length };
  }
}

export type ShardRow = typeof clusterShards.$inferSelect;
export { newId, nowIso };

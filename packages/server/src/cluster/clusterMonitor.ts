import type { ClusterStatus } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { eq } from 'drizzle-orm';
import { clusterShards, clusterTasks } from '../db/schema/index.ts';
import { NodeRegistry, type NodeRow } from './nodeRegistry.ts';
import { ElectionService } from './election.ts';
import { ClusterPolicyService } from './clusterPolicy.ts';
import { decideFallback } from './clusterFallback.ts';

/**
 * 集群监控（Phase 4 Step 4）。
 *
 * 输出一份**自解释**的状态快照：UI 只看这一个接口就能渲染完整集群视图，
 * 不需要前端自己拼多个接口（拼接口最容易出现「数字对不上」的困惑）。
 */

export class ClusterMonitor {
  constructor(
    private readonly db: Db,
    private readonly nodes: NodeRegistry,
    private readonly elections: ElectionService,
    private readonly policies: ClusterPolicyService,
    private readonly opts: { clusterEnabled?: boolean } = {},
  ) {}

  async snapshot(workspaceId: string, requested: 'single' | 'cluster' = 'cluster'): Promise<ClusterStatus> {
    const clusterId = 'local';
    const [nodes, policy, leader, term] = await Promise.all([this.nodes.list(clusterId), this.policies.get(workspaceId), this.elections.currentLeader(), this.elections.currentTerm()]);

    const tasks = (await this.db.select().from(clusterTasks).where(eq(clusterTasks.workspaceId, workspaceId))) as unknown as { status: string }[];
    const shards = (await this.db.select().from(clusterShards)) as unknown as { status: string }[];

    const taskStats = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
    for (const t of tasks) if (t.status in taskStats) (taskStats as Record<string, number>)[t.status] = ((taskStats as Record<string, number>)[t.status] ?? 0) + 1;
    const shardStats = { pending: 0, assigned: 0, running: 0, succeeded: 0, failed: 0, reassigned: 0 };
    for (const s of shards) if (s.status in shardStats) (shardStats as Record<string, number>)[s.status] = ((shardStats as Record<string, number>)[s.status] ?? 0) + 1;

    const decision = decideFallback({
      requested,
      fallbackEnabled: policy.fallbackEnabled,
      nodes: nodes.map((n) => ({ status: n.status, role: n.role })),
      leaderExists: leader !== null,
      ...(this.opts.clusterEnabled === undefined ? {} : { clusterEnabled: this.opts.clusterEnabled }),
    });

    return {
      clusterId,
      mode: decision.effective === 'degraded' ? 'single' : decision.effective === 'cluster' ? 'cluster' : 'single',
      degraded: decision.effective === 'degraded',
      degradeReason: decision.effective === 'degraded' ? decision.reason : null,
      leader,
      term,
      nodes,
      online: nodes.filter((n) => n.status === 'online').length,
      policy,
      taskStats,
      shardStats,
    };
  }

  /** 健康摘要：供看板小组件使用（不含策略明细，体量小） */
  async healthSummary(clusterId = 'local') {
    const nodes = await this.nodes.list(clusterId);
    const samples = await this.nodes.healthAll(200);
    const latest = new Map<string, (typeof samples)[number]>();
    for (const s of samples) if (!latest.has(s.nodeId)) latest.set(s.nodeId, s);
    return {
      nodes: nodes.map((n) => {
        const h = latest.get(n.id);
        return {
          id: n.id,
          name: n.name,
          role: n.role,
          status: n.status,
          lastHeartbeat: n.lastHeartbeat,
          heartbeatMiss: n.heartbeatMiss,
          metrics: h ? { cpu: h.cpu, memory: h.memory, gpu: h.gpu, disk: h.disk, network: h.network } : null,
        };
      }),
      online: nodes.filter((n) => n.status === 'online').length,
      total: nodes.length,
    };
  }

  /** 触发一次心跳扫描（UI 上的「立即检查」按钮） */
  async sweep(timeoutMs: number): Promise<{ offline: NodeRow[]; online: NodeRow[] }> {
    const result = await this.nodes.sweep(timeoutMs);
    this.nodes.setOnlineCache(result.online);
    return result;
  }
}

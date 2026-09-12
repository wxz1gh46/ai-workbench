import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { EventType } from '@ai/shared';
import { clusterElections, clusterNodes } from '../db/schema/index.ts';
import { eventBus } from '../events/bus.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';
import type { NodeRow } from './nodeRegistry.ts';

/**
 * Leader 选举（Phase 4 Step 4）。
 *
 * 算法：**确定性优先级投票**（不是 Raft，但语义足够且可测）：
 *   rank 越高（candidate > worker）、标签 leaderPriority 越高、节点名更小者优先
 *   → 保证「同样的节点集合 + 同样的 term」在任意时刻算出同一个 leader（幂等、可复现）
 *
 * 为什么不用随机超时：
 *   单机/小集群场景下随机选举很难测（结果不确定），确定性排序既能满足「主节点故障可选举」，
 *   又能在测试中逐条断言。规则写在这里，UI 上也能解释「为什么选了它」。
 */

export interface ElectionResult {
  term: number;
  leaderNodeId: string;
  reason: string;
  electedAt: string;
  /** 是否发生了 leader 变更 */
  changed: boolean;
}

function priorityOf(node: NodeRow): number {
  const raw = node.labels.leaderPriority;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function rankCandidates(nodes: NodeRow[]): NodeRow[] {
  return [...nodes].sort((a, b) => {
    if (priorityOf(a) !== priorityOf(b)) return priorityOf(b) - priorityOf(a);
    const roleWeight = (r: NodeRow['role']) => (r === 'candidate' ? 2 : r === 'worker' ? 1 : 0);
    if (roleWeight(a.role) !== roleWeight(b.role)) return roleWeight(b.role) - roleWeight(a.role);
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

export class ElectionService {
  constructor(
    private readonly db: Db,
    private readonly clusterId = 'local',
  ) {}

  async history(limit = 20) {
    const rows = (await this.db.select().from(clusterElections).where(eq(clusterElections.clusterId, this.clusterId))) as unknown as ElectionRow[];
    return rows.sort((a, b) => b.term - a.term).slice(0, limit);
  }

  async currentTerm(): Promise<number> {
    const rows = await this.history(1);
    return rows[0]?.term ?? 0;
  }

  async currentLeader(): Promise<NodeRow | null> {
    const rows = (await this.db.select().from(clusterNodes).where(eq(clusterNodes.clusterId, this.clusterId))) as unknown as NodeRow[];
    return rows.find((n) => n.role === 'leader') ?? null;
  }

  /**
   * 选举：只在「候选集合非空」时产生新 term。
   * 候选集合为空 → 返回 leaderNodeId=''，由调用方决定是否降级单机（本方法不擅自决定）。
   */
  async elect(input: { candidates?: NodeRow[]; reason?: 'initial' | 'failover' | 'manual'; onlineOnly?: boolean } = {}): Promise<ElectionResult> {
    const all = (await this.db.select().from(clusterNodes).where(eq(clusterNodes.clusterId, this.clusterId))) as unknown as NodeRow[];
    const base = input.candidates ?? all;
    const candidates = input.onlineOnly === false ? base : base.filter((n) => n.status === 'online');
    if (candidates.length === 0) {
      return { term: await this.currentTerm(), leaderNodeId: '', reason: '无可用候选节点', electedAt: nowIso(), changed: false };
    }
    const ranked = rankCandidates(candidates);
    const winner = ranked[0]!;
    const prevLeader = all.find((n) => n.role === 'leader') ?? null;
    const changed = prevLeader?.id !== winner.id;
    if (!changed && !input.reason) {
      return { term: await this.currentTerm(), leaderNodeId: winner.id, reason: 'leader 未变化', electedAt: nowIso(), changed: false };
    }

    const term = (await this.currentTerm()) + 1;
    const now = nowIso();

    // 角色变更：所有节点先降为 worker/candidate，再把 winner 设为 leader（保证全局只有一个 leader）
    for (const n of all) {
      const role: NodeRow['role'] = n.id === winner.id ? 'leader' : n.role === 'leader' ? 'worker' : n.role;
      await this.db.update(clusterNodes).set({ role, updatedAt: now } as never).where(eq(clusterNodes.id, n.id));
    }

    await this.db.insert(clusterElections).values({
      id: newId('cel'),
      clusterId: this.clusterId,
      term,
      leaderNodeId: winner.id,
      reason: input.reason ?? 'initial',
      electedAt: now,
    } as never);

    logger.info('cluster leader elected', { term, leader: winner.name, reason: input.reason ?? 'initial' });
    eventBus.publishBuffered(EventType.CLUSTER_LEADER, { term, leaderNodeId: winner.id, name: winner.name, reason: input.reason ?? 'initial' }, { workspaceId: 'cluster', goalId: null, taskId: null });

    return {
      term,
      leaderNodeId: winner.id,
      reason: `按优先级选出：${winner.name}（priority=${priorityOf(winner)}，role=${winner.role}）`,
      electedAt: now,
      changed: true,
    };
  }

  /** leader 掉线时的重新选举（由 HeartbeatManager.onOffline 调用） */
  async handleFailover(offline: NodeRow[]): Promise<ElectionResult | null> {
    const leader = await this.currentLeader();
    if (!leader) return this.elect({ reason: 'initial' });
    if (!offline.some((n) => n.id === leader.id)) return null;
    logger.warn('leader offline, triggering failover election', { leader: leader.name });
    return this.elect({ reason: 'failover' });
  }
}

export type ElectionRow = typeof clusterElections.$inferSelect;

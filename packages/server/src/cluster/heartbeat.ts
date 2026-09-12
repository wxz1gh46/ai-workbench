import type { Db } from '../db/client.ts';
import { eventBus } from '../events/bus.ts';
import { EventType } from '@ai/shared';
import { logger } from '../utils/logger.ts';
import { NodeRegistry, type NodeRow } from './nodeRegistry.ts';

/**
 * 心跳管理器（Phase 4 Step 4）。
 *
 * 为什么不用 setInterval 直接写在构造里：
 *   - 测试需要「确定性推进时间」，所以 tick() 必须可手动调用；
 *   - 定时器必须可 stop（否则 `node --test` 不会退出 —— 这是 Phase 3 踩过的坑）。
 */

export interface HeartbeatEvent {
  node: NodeRow;
  at: string;
  missed: number;
}

export class HeartbeatManager {
  private timer: NodeJS.Timeout | null = null;
  private readonly lastSeen = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly registry: NodeRegistry,
    private readonly opts: {
      timeoutMs: number;
      intervalMs?: number;
      clusterId?: string;
      /** 离线判定后的回调（用于触发重新选举 / 重新分片） */
      onOffline?: (nodes: NodeRow[]) => void | Promise<unknown>;
      now?: () => Date;
    },
  ) {}

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  /** 接收一次心跳（可由 HTTP / WS 触发，也可由测试直接调用） */
  async beat(nodeId: string, health?: Record<string, number>): Promise<NodeRow> {
    const node = await this.registry.heartbeat(nodeId, health as never);
    this.lastSeen.set(nodeId, this.now().getTime());
    eventBus.publishBuffered(EventType.CLUSTER_NODE_HEARTBEAT, { nodeId, status: node.status, at: node.lastHeartbeat }, { workspaceId: 'cluster', goalId: null, taskId: null });
    return node;
  }

  /** 单次扫描：返回本次判定离线的节点（并发事件 + 回调） */
  async tick(): Promise<{ offline: NodeRow[]; online: NodeRow[] }> {
    const { offline, online } = await this.registry.sweep(this.opts.timeoutMs, this.now());
    this.registry.setOnlineCache(online);
    for (const n of offline) {
      logger.warn('cluster node marked offline (heartbeat timeout)', { nodeId: n.id, name: n.name, miss: n.heartbeatMiss });
      eventBus.publishBuffered(EventType.CLUSTER_NODE_OFFLINE, { nodeId: n.id, name: n.name, missed: n.heartbeatMiss }, { workspaceId: 'cluster', goalId: null, taskId: null });
    }
    if (offline.length > 0 && this.opts.onOffline) {
      await this.opts.onOffline(offline);
    }
    return { offline, online };
  }

  start(): void {
    if (this.timer) return;
    const interval = this.opts.intervalMs ?? Math.max(1000, Math.floor(this.opts.timeoutMs / 3));
    this.timer = setInterval(() => {
      void this.tick().catch((e) => logger.error('heartbeat tick failed', { error: e instanceof Error ? e.message : String(e) }));
    }, interval);
    // unref：不阻止进程退出（测试环境必需）
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get running(): boolean {
    return this.timer !== null;
  }
}

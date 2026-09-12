import type { ClusterStatus } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { NodeRegistry } from './nodeRegistry.ts';
import { HeartbeatManager } from './heartbeat.ts';
import { ElectionService } from './election.ts';
import { ClusterPolicyService } from './clusterPolicy.ts';
import { TaskDistributor } from './taskDistributor.ts';
import { FaultTolerance } from './faultTolerance.ts';
import { ClusterMonitor } from './clusterMonitor.ts';
import { decideFallback, type EffectiveMode } from './clusterFallback.ts';

/**
 * 集群管理器（Phase 4 Step 4）—— 对外只暴露这一个门面。
 *
 * 职责划分（各组件互不越界，便于测试）：
 *   NodeRegistry      节点与心跳数据
 *   HeartbeatManager  心跳扫描 + 离线事件
 *   ElectionService   选举
 *   ClusterPolicySvc  策略与资源治理
 *   TaskDistributor   分片与分发
 *   FaultTolerance    失联改派 / 失败重试
 *   ClusterMonitor    只读快照
 *
 * ClusterManager 负责「把它们的调用顺序编排对」，并在 leader 掉线时
 * 自动串起：选举 → 改派分片（这两步的顺序不能反，否则改派时仍无 leader）。
 */
export class ClusterManager {
  readonly nodes: NodeRegistry;
  readonly elections: ElectionService;
  readonly policies: ClusterPolicyService;
  readonly distributor: TaskDistributor;
  readonly faults: FaultTolerance;
  readonly monitor: ClusterMonitor;
  readonly heartbeat: HeartbeatManager;

  constructor(
    private readonly db: Db,
    private readonly opts: { clusterEnabled?: boolean; heartbeatIntervalMs?: number; maxAttempts?: number; now?: () => Date } = {},
  ) {
    this.nodes = new NodeRegistry(db);
    this.elections = new ElectionService(db);
    this.policies = new ClusterPolicyService(db);
    this.distributor = new TaskDistributor(db);
    this.faults = new FaultTolerance(db, this.distributor, opts.maxAttempts === undefined ? {} : { maxAttempts: opts.maxAttempts });
    this.monitor = new ClusterMonitor(db, this.nodes, this.elections, this.policies, opts.clusterEnabled === undefined ? {} : { clusterEnabled: opts.clusterEnabled });
    this.heartbeat = new HeartbeatManager(db, this.nodes, {
      timeoutMs: 30_000,
      ...(opts.heartbeatIntervalMs === undefined ? {} : { intervalMs: opts.heartbeatIntervalMs }),
      ...(opts.now ? { now: opts.now } : {}),
      onOffline: async (offline) => {
        // 顺序关键：先选举（保证有新 leader），再改派分片
        const policy = await this.policies.get('local');
        const election = await this.elections.handleFailover(offline);
        const nodes = await this.nodes.list();
        this.nodes.setOnlineCache(nodes.filter((n) => n.status === 'online'));
        const result = await this.faults.handleNodeLoss(offline, nodes.filter((n) => n.status === 'online'), policy.maxParallelTasks);
        return { election, result };
      },
    });
  }

  /** 启动后台心跳扫描（不阻塞进程退出） */
  start(): void {
    this.heartbeat.start();
  }

  stop(): void {
    this.heartbeat.stop();
  }

  /** 使用策略里的心跳超时更新扫描窗口（策略变更后调用） */
  async syncHeartbeat(workspaceId: string): Promise<void> {
    const policy = await this.policies.get(workspaceId);
    (this.heartbeat as unknown as { opts: { timeoutMs: number } }).opts.timeoutMs = policy.heartbeatTimeoutMs;
  }

  /** 当前有效模式（供 Agent 并行调度决定「分发到集群」还是「本机执行」） */
  async effectiveMode(workspaceId: string, requested: 'single' | 'cluster' = 'cluster'): Promise<{ mode: EffectiveMode; reason: string }> {
    const policy = await this.policies.get(workspaceId);
    const nodes = await this.nodes.list();
    const leader = await this.elections.currentLeader();
    const decision = decideFallback({
      requested,
      fallbackEnabled: policy.fallbackEnabled,
      nodes: nodes.map((n) => ({ status: n.status, role: n.role })),
      leaderExists: leader !== null,
      ...(this.opts.clusterEnabled === undefined ? {} : { clusterEnabled: this.opts.clusterEnabled }),
    });
    return { mode: decision.effective, reason: decision.reason };
  }

  async status(workspaceId: string, requested: 'single' | 'cluster' = 'cluster'): Promise<ClusterStatus> {
    return this.monitor.snapshot(workspaceId, requested);
  }

  /** 集群初始化：注册本机节点 → 选举 → 建立在线缓存（幂等，可重复调用） */
  async ensureBootstrapped(workspaceId: string): Promise<{ nodeId: string; elected: boolean; term: number }> {
    const policy = await this.policies.get(workspaceId);
    const node = await this.nodes.register({ name: 'local-node-1', role: 'worker', host: '127.0.0.1', resources: policy.resourceLimits }, { maxNodes: policy.maxNodes, allowLoopback: true });
    await this.nodes.heartbeat(node.id, { cpu: 10, memory: 20, disk: 5, network: 1 });
    const election = await this.elections.elect({ reason: 'initial' });
    const nodes = await this.nodes.list();
    this.nodes.setOnlineCache(nodes.filter((n) => n.status === 'online'));
    return { nodeId: node.id, elected: election.changed, term: election.term };
  }
}

export { decideFallback };

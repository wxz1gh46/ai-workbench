/**
 * 集群降级（Phase 4 Step 4）。
 *
 * 核心承诺：**集群不可用时，任务仍然能跑完**，且用户能明确知道「现在跑的是单机模式」。
 *
 * 三种状态：
 *   single   —— 用户显式选择单机（或策略关闭了集群）
 *   cluster  —— 集群可用，任务分发到节点
 *   degraded —— 想用集群但不可用，已自动回退单机（必须给出原因）
 */

export type ClusterMode = 'single' | 'cluster';
export type EffectiveMode = 'single' | 'cluster' | 'degraded';

export interface FallbackDecision {
  effective: EffectiveMode;
  requested: ClusterMode;
  reason: string;
  /** 用户可见的建议（含如何恢复集群） */
  suggestion: string;
}

export interface FallbackInput {
  requested: ClusterMode;
  /** 策略是否允许回退 */
  fallbackEnabled: boolean;
  nodes: { status: string; role?: string }[];
  leaderExists: boolean;
  /** 集群是否已被整体禁用（如功能开关关闭） */
  clusterEnabled?: boolean;
}

export function decideFallback(input: FallbackInput): FallbackDecision {
  if (input.requested === 'single') {
    return { effective: 'single', requested: 'single', reason: '用户选择单机模式', suggestion: '需要并行加速时可切换为集群模式' };
  }
  if (input.clusterEnabled === false) {
    return {
      effective: 'degraded',
      requested: 'cluster',
      reason: '集群功能已被功能开关关闭（config.features.phase4Cluster = false）',
      suggestion: '在配置中打开 phase4Cluster 后重启服务即可启用',
    };
  }
  const online = input.nodes.filter((n) => n.status === 'online');
  if (online.length === 0) {
    if (!input.fallbackEnabled) {
      // 不允许回退时，明确拒绝而不是偷偷降级 —— 用户需要知道任务没有按预期方式执行
      return {
        effective: 'cluster',
        requested: 'cluster',
        reason: '集群无在线节点，且策略禁止回退单机 → 任务不会被调度',
        suggestion: '注册并启动至少一个节点，或打开「允许降级单机」',
      };
    }
    return {
      effective: 'degraded',
      requested: 'cluster',
      reason: '集群无在线节点，已自动回退单机执行',
      suggestion: '检查节点进程是否运行、心跳端口是否可达；恢复后会自动回到集群模式',
    };
  }
  if (!input.leaderExists) {
    return {
      effective: input.fallbackEnabled ? 'degraded' : 'cluster',
      requested: 'cluster',
      reason: input.fallbackEnabled ? '集群没有 leader，已自动回退单机执行' : '集群没有 leader，且策略禁止回退 → 任务不会被调度',
      suggestion: '触发一次选举（POST /cluster/elections）以选出 leader',
    };
  }
  return { effective: 'cluster', requested: 'cluster', reason: `集群可用（在线 ${online.length} 个节点）`, suggestion: '如需强制单机，可将模式切为 single' };
}

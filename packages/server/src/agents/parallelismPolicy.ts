/**
 * 并行度策略（Phase 4 Step 5）。
 *
 * 回答一个问题：**现在最多能同时跑几个 Agent？**
 *
 * 约束来源（取最小值）：
 *   1) 用户/工作区配置的 maxParallel
 *   2) 集群策略 maxParallelTasks（若走集群）
 *   3) 各角色 Agent 池的剩余容量之和
 *   4) 成本预算：预算剩余不足时收缩并行度（花超了比跑慢了更糟）
 *   5) 本机资源（CPU 核数上限，防止把开发机打满）
 *
 * 纯函数实现：输入确定 → 输出确定 → 可单测；同时保证「为什么只跑 N 个」可解释。
 */

export interface ParallelismInput {
  /** 工作区配置上限（通常来自 cluster_configs.maxParallel） */
  configuredMax: number;
  /** 集群策略上限（单机模式传 undefined） */
  clusterMax?: number;
  /** 池剩余容量：{role: 剩余实例数} */
  poolHeadroom: Record<string, number>;
  /** 就绪任务数 */
  readyTasks: number;
  /** 预算状态 */
  budget?: { ratio: number; state: 'none' | 'warn' | 'exceeded' };
  /** 本机可用 CPU 核数（undefined 表示不限制） */
  cpuCores?: number;
  /** 每个 Agent 占用的 CPU 核数系数（默认 1） */
  coresPerAgent?: number;
}

export interface ParallelismDecision {
  limit: number;
  /** 触发上限的原因（按生效顺序） */
  reason: string;
  factors: { name: string; value: number }[];
}

const BUDGET_WARN_FACTOR = 0.5;

export function decideParallelism(input: ParallelismInput): ParallelismDecision {
  const factors: { name: string; value: number }[] = [];
  let limit = Math.max(0, Math.floor(input.configuredMax));
  factors.push({ name: '工作区配置上限', value: limit });
  let reason = '按工作区配置';

  if (input.clusterMax !== undefined) {
    const v = Math.max(0, Math.floor(input.clusterMax));
    if (v < limit) {
      limit = v;
      reason = '受集群策略 maxParallelTasks 限制';
    }
    factors.push({ name: '集群策略上限', value: v });
  }

  const headroom = Object.values(input.poolHeadroom).reduce((s, v) => s + Math.max(0, Math.floor(v)), 0);
  factors.push({ name: 'Agent 池剩余容量', value: headroom });
  if (headroom < limit) {
    limit = headroom;
    reason = '受 Agent 池容量限制（可通过扩容池提升）';
  }

  if (input.budget) {
    if (input.budget.state === 'exceeded') {
      factors.push({ name: '预算已超', value: 0 });
      return { limit: 0, reason: 'Token 预算已超限，已暂停并行执行（提高预算或等待下一个计费周期）', factors };
    }
    if (input.budget.state === 'warn') {
      const shrunk = Math.max(1, Math.floor(limit * BUDGET_WARN_FACTOR));
      factors.push({ name: '预算预警收缩后', value: shrunk });
      if (shrunk < limit) {
        limit = shrunk;
        reason = `预算已用 ${(input.budget.ratio * 100).toFixed(0)}%，并行度自动下调`;
      }
    }
  }

  if (input.cpuCores !== undefined) {
    const per = Math.max(0.25, input.coresPerAgent ?? 1);
    const byCpu = Math.max(1, Math.floor(input.cpuCores / per));
    factors.push({ name: '本机 CPU 上限', value: byCpu });
    if (byCpu < limit) {
      limit = byCpu;
      reason = '受本机 CPU 核数限制';
    }
  }

  if (input.readyTasks < limit) {
    limit = Math.max(0, input.readyTasks);
    reason = '就绪任务数少于并行上限，按任务数执行';
  }
  factors.push({ name: '就绪任务数', value: input.readyTasks });

  return { limit: Math.max(0, limit), reason, factors };
}

/** 计算「并行带来的加速比」估计：用于向用户解释「数倍生产力」的量化依据 */
export function estimateSpeedup(input: { taskCount: number; limit: number; avgTaskMs: number; sequentialOverheadMs?: number }): {
  sequentialMs: number;
  parallelMs: number;
  speedup: number;
  batches: number;
} {
  const overhead = input.sequentialOverheadMs ?? 0;
  const limit = Math.max(1, input.limit);
  const batches = Math.ceil(input.taskCount / limit);
  const sequentialMs = input.taskCount * (input.avgTaskMs + overhead);
  // 并行时仍保留一部分串行开销（调度、聚合），保守估计为 overhead / 2
  const parallelMs = batches * input.avgTaskMs + input.taskCount * (overhead / 2);
  return {
    sequentialMs,
    parallelMs,
    speedup: parallelMs > 0 ? Math.round((sequentialMs / parallelMs) * 100) / 100 : 1,
    batches,
  };
}

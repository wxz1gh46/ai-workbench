/**
 * 进度树（纯函数）。
 *
 * 目标 → 任务 → 子任务。所有统计都从任务快照算出，保证 UI 与审计一致，
 * 不会出现「进度条 100% 但任务还在跑」这类自相矛盾的状态。
 */
import type { Goal, ProgressNode, ProgressTree, Task, TaskStatus } from '@ai/shared';
import { computeProgress, toDagNodes } from '../agent/task-graph.ts';

export interface ProgressSummary {
  total: number;
  succeeded: number;
  failed: number;
  blocked: number;
  running: number;
  pending: number;
  percent: number;
}

export function summarize(tasks: Task[]): ProgressSummary {
  const count = (s: TaskStatus) => tasks.filter((t) => t.status === s).length;
  const succeeded = count('succeeded');
  const failed = count('failed');
  const blocked = count('blocked');
  const running = count('running');
  const pending = tasks.length - succeeded - failed - blocked - running;
  return {
    total: tasks.length,
    succeeded,
    failed,
    blocked,
    running,
    pending,
    percent: computeProgress(toDagNodes(tasks)),
  };
}

/**
 * 构建进度树。
 * - 按 parentTaskId 组织层级（Planner 目前产出扁平图，子任务能力已预留）
 * - blocked 节点附带原因（取 task.error，或依赖失败推断）
 * - outputSummary 用于 UI 悬浮展示任务产出
 */
export function buildProgressTree(goal: Goal, tasks: Task[]): ProgressTree {
  const byParent = new Map<string | null, Task[]>();
  for (const t of tasks) {
    const key = t.parentTaskId ?? null;
    const list = byParent.get(key) ?? [];
    list.push(t);
    byParent.set(key, list);
  }

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const toNode = (task: Task): ProgressNode => {
    const children = (byParent.get(task.id) ?? []).map(toNode);
    const blockedDep = task.dependsOn
      .map((d) => byId.get(d))
      .find((d) => d && (d.status === 'failed' || d.status === 'cancelled'));
    return {
      id: task.id,
      parentId: task.parentTaskId,
      title: task.title,
      status: task.status,
      progress: task.progress,
      agentRole: task.agentRole,
      // 优先反映「真正执行过该任务」的 Agent，其次才是声明认领者
      assigneeAgentId: task.lastAgentId ?? task.claimedBy,
      dependsOn: task.dependsOn,
      children,
      blockedReason:
        task.status === 'blocked'
          ? (task.error ?? (blockedDep ? `依赖任务「${blockedDep.title}」状态为 ${blockedDep.status}` : '阻塞原因未知'))
          : null,
      outputSummary: task.outputSummary ?? null,
    };
  };

  const roots = (byParent.get(null) ?? []).map(toNode);
  const summary = summarize(tasks);

  // 阻塞项汇总：任务级阻塞 + 目标级 blockers，去重后给 UI 直接展示
  const blockers = [
    ...new Set([
      ...tasks.filter((t) => t.status === 'blocked').map((t) => `${t.title}：${t.error ?? '阻塞'}`),
      ...(goal.blockers ?? []),
    ]),
  ];

  return {
    goal: {
      id: goal.id,
      objective: goal.objective,
      status: goal.status,
      progress: goal.progress,
      iterations: goal.iterations,
      maxIterations: goal.maxIterations,
      acceptanceCriteria: goal.acceptanceCriteria,
    },
    nodes: roots,
    summary,
    blockers,
  };
}

/** 扁平化进度树，便于服务端计算与测试 */
export function flattenTree(nodes: ProgressNode[]): ProgressNode[] {
  const out: ProgressNode[] = [];
  const walk = (list: ProgressNode[]) => {
    for (const n of list) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** 是否所有任务都已进入终态 */
export function allSettled(tasks: Task[]): boolean {
  return tasks.every((t) => ['succeeded', 'failed', 'blocked', 'cancelled'].includes(t.status));
}

/** 是否全部成功 */
export function allSucceeded(tasks: Task[]): boolean {
  return tasks.length > 0 && tasks.every((t) => t.status === 'succeeded');
}

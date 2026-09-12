import type { Task, TaskStatus } from '@ai/shared';

export interface DagNode {
  id: string;
  dependsOn: string[];
  status: TaskStatus;
}

/**
 * DAG 调度核心（纯函数，便于单测）。
 * 与 DB 解耦，service 层只负责读写与持久化。
 */
export function resolveReady(nodes: DagNode[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return nodes
    // ready 表示依赖已满足可立即执行；blocked 会在依赖修复后重新变为可执行
    .filter((n) => n.status === 'pending' || n.status === 'ready' || n.status === 'blocked')
    .filter((n) =>
      n.dependsOn.every((dep) => {
        const d = byId.get(dep);
        // 依赖不存在视为缺失，任务保持 blocked 不执行
        return d !== undefined && d.status === 'succeeded';
      }),
    )
    .map((n) => n.id);
}

/** 依赖链上出现失败/取消，则该任务不可能完成 → 标记为 blocked 并给出原因 */
export function resolveBlocked(nodes: DagNode[]): { id: string; reason: string }[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: { id: string; reason: string }[] = [];
  for (const n of nodes) {
    if (n.status === 'succeeded' || n.status === 'failed' || n.status === 'cancelled') continue;
    const bad = n.dependsOn
      .map((dep) => byId.get(dep))
      .filter((d): d is DagNode => !!d)
      .find((d) => d.status === 'failed' || d.status === 'cancelled');
    if (bad) out.push({ id: n.id, reason: `依赖任务 ${bad.id} 状态为 ${bad.status}` });
  }
  return out;
}

/** 检测环：DAG 必须无环，Planner 产出的图入库前先校验 */
export function detectCycle(nodes: DagNode[]): string[] | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map<string, 0 | 1 | 2>();

  const visit = (id: string, stack: string[]): string[] | null => {
    const s = state.get(id) ?? 0;
    if (s === 1) return [...stack, id];
    if (s === 2) return null;
    state.set(id, 1);
    const node = byId.get(id);
    for (const dep of node?.dependsOn ?? []) {
      const cycle = visit(dep, [...stack, id]);
      if (cycle) return cycle;
    }
    state.set(id, 2);
    return null;
  };

  for (const n of nodes) {
    const cycle = visit(n.id, []);
    if (cycle) return cycle;
  }
  return null;
}

/** 拓扑排序，用于展示与日志 */
export function topoSort(nodes: DagNode[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const visited = new Set<string>();
  const out: string[] = [];
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep);
    out.push(id);
  };
  for (const n of nodes) visit(n.id);
  return out;
}

/** 整体完成度：按任务数加权，成功=100，运行中=50，其余=0 */
export function computeProgress(nodes: DagNode[]): number {
  if (nodes.length === 0) return 0;
  const score = nodes.reduce((s, n) => {
    if (n.status === 'succeeded') return s + 100;
    if (n.status === 'running') return s + 50;
    return s;
  }, 0);
  return Math.round(score / nodes.length);
}

/** 从 Task[] 转 DAG 视图 */
export function toDagNodes(tasks: Pick<Task, 'id' | 'dependsOn' | 'status'>[]): DagNode[] {
  return tasks.map((t) => ({ id: t.id, dependsOn: t.dependsOn ?? [], status: t.status }));
}

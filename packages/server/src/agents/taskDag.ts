/**
 * 任务 DAG（Phase 4 Step 5）。
 *
 * 提供三件事，全部是纯函数（可完整单测）：
 *   1) 环检测：有环必须报错并给出环路径（否则调度器会死锁）
 *   2) 拓扑分层：算出「第几批可以并行」，用于呈现加速效果
 *   3) 就绪计算：当前哪些任务可执行（依赖全部成功）
 */

export interface DagNode {
  id: string;
  dependsOn: string[];
  status: 'pending' | 'ready' | 'running' | 'blocked' | 'succeeded' | 'failed' | 'cancelled';
  title?: string;
  priority?: number;
}

export interface DagValidation {
  ok: boolean;
  /** 环路径（有环时给出，便于用户定位） */
  cycle: string[] | null;
  /** 依赖了不存在的任务 id */
  missing: { id: string; dependsOn: string }[];
  /** 自依赖 */
  selfLoops: string[];
}

export function validateDag(nodes: DagNode[]): DagValidation {
  const ids = new Set(nodes.map((n) => n.id));
  const missing: { id: string; dependsOn: string }[] = [];
  const selfLoops: string[] = [];
  for (const n of nodes) {
    for (const d of n.dependsOn) {
      if (d === n.id) selfLoops.push(n.id);
      else if (!ids.has(d)) missing.push({ id: n.id, dependsOn: d });
    }
  }
  if (missing.length > 0 || selfLoops.length > 0) {
    return { ok: false, cycle: null, missing, selfLoops };
  }

  // DFS 找环（返回构成环的路径，比「只有环」可读得多）
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const state = new Map<string, 0 | 1 | 2>(); // 0 未访问 1 访问中 2 完成
  const stack: string[] = [];
  let cycle: string[] | null = null;

  const visit = (id: string): boolean => {
    const st = state.get(id) ?? 0;
    if (st === 1) {
      const start = stack.indexOf(id);
      cycle = stack.slice(start >= 0 ? start : 0).concat(id);
      return false;
    }
    if (st === 2) return true;
    state.set(id, 1);
    stack.push(id);
    const node = byId.get(id);
    for (const dep of node?.dependsOn ?? []) {
      if (!visit(dep)) return false;
    }
    stack.pop();
    state.set(id, 2);
    return true;
  };

  for (const n of nodes) {
    if (!visit(n.id)) break;
  }
  return { ok: cycle === null, cycle, missing: [], selfLoops: [] };
}

/** 拓扑分层：同一层内的任务互不依赖，可并行执行 */
export function topologicalLayers(nodes: DagNode[]): { layers: string[][]; validation: DagValidation } {
  const validation = validateDag(nodes);
  if (!validation.ok) return { layers: [], validation };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const depth = new Map<string, number>();

  const computeDepth = (id: string, seen: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    // seen 防御性检查（有环时已经在上面被拦住，这里只是兜底）
    if (seen.has(id)) return 0;
    seen.add(id);
    const node = byId.get(id);
    const d = (node?.dependsOn ?? []).length === 0 ? 0 : Math.max(...(node?.dependsOn ?? []).map((x) => computeDepth(x, seen))) + 1;
    depth.set(id, d);
    return d;
  };

  const maxDepth = Math.max(0, ...nodes.map((n) => computeDepth(n.id, new Set())));
  const layers: string[][] = Array.from({ length: maxDepth + 1 }, () => []);
  // 同层内按 priority 降序、再按 id 排序：保证调度顺序确定（可复现）
  for (const n of [...nodes].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || (a.id < b.id ? -1 : 1))) {
    layers[computeDepth(n.id, new Set())]!.push(n.id);
  }
  return { layers, validation };
}

/** 就绪任务：依赖全部 succeeded，且自身处于 pending/ready */
export function resolveReadyTasks(nodes: DagNode[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return nodes
    .filter((n) => n.status === 'pending' || n.status === 'ready')
    .filter((n) => n.dependsOn.every((d) => byId.get(d)?.status === 'succeeded'))
    .map((n) => n.id);
}

/**
 * 阻塞任务：依赖里有 failed/cancelled 的，永远无法满足 → 标记为 blocked 并给出原因。
 * 不做这一步的话，UI 会显示任务「一直 pending」，用户不知道是卡住了还是没轮到。
 */
export function resolveBlockedTasks(nodes: DagNode[]): { id: string; reason: string }[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: { id: string; reason: string }[] = [];
  for (const n of nodes) {
    if (n.status === 'succeeded' || n.status === 'failed' || n.status === 'cancelled' || n.status === 'running') continue;
    const dead = n.dependsOn.filter((d) => ['failed', 'cancelled', 'blocked'].includes(byId.get(d)?.status ?? ''));
    if (dead.length > 0) {
      out.push({ id: n.id, reason: `依赖任务未成功：${dead.map((d) => byId.get(d)?.title ?? d).join(', ')}` });
    }
  }
  return out;
}

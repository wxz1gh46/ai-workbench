/**
 * 任务分片（Phase 4 Step 4）。
 *
 * 分片规则是「纯函数」：同样的输入必然得到同样的分片，
 * 这样「重新分片」（节点掉线后）才能复用同一套逻辑，
 * 且能被单测完整覆盖（分片是最容易出错、也最难排查的一环）。
 *
 * 支持两种模式：
 *   - by-count：按数量平均切（items.length / shardCount）
 *   - by-weight：按权重切（大 item 单独成片，避免「一个超大项拖慢整片」）
 */

export interface Shard<T> {
  index: number;
  total: number;
  items: T[];
  /** 该分片的权重（用于调度器评估负载） */
  weight: number;
}

export function shardByCount<T>(items: T[], shardCount: number): Shard<T>[] {
  const count = Math.max(1, Math.min(Math.floor(shardCount) || 1, items.length || 1));
  const out: Shard<T>[] = [];
  const base = Math.floor(items.length / count);
  const rest = items.length % count;
  let cursor = 0;
  for (let i = 0; i < count; i += 1) {
    const size = base + (i < rest ? 1 : 0);
    const slice = items.slice(cursor, cursor + size);
    cursor += size;
    out.push({ index: i, total: count, items: slice, weight: slice.length });
  }
  return out.filter((s) => s.items.length > 0);
}

/** 权重函数：默认 1，调用方可用「文本长度 / token 估算」等做真实权重 */
export type Weighter<T> = (item: T) => number;

export function shardByWeight<T>(items: T[], shardCount: number, weightOf: Weighter<T>): Shard<T>[] {
  const count = Math.max(1, Math.min(Math.floor(shardCount) || 1, items.length || 1));
  const buckets: Shard<T>[] = Array.from({ length: count }, (_, i) => ({ index: i, total: count, items: [], weight: 0 }));
  // 大项优先（LPT 贪心）：先放大项，负载更均衡
  const sorted = items
    .map((item, idx) => ({ item, idx, w: Math.max(0, weightOf(item)) }))
    .sort((a, b) => b.w - a.w || a.idx - b.idx);
  for (const entry of sorted) {
    // 选当前权重最小的分片（同权重时选 index 小的，保证确定性）
    let target = buckets[0]!;
    for (const b of buckets) if (b.weight < target.weight) target = b;
    target.items.push(entry.item);
    target.weight += entry.w;
  }
  for (const b of buckets) {
    // 恢复原始顺序：分片内部顺序最好与输入一致，便于人工核对
    b.items.sort((a, c) => items.indexOf(a) - items.indexOf(c));
    b.weight = Math.round(b.weight * 100) / 100;
  }
  return buckets.filter((b) => b.items.length > 0);
}

/** 自动选模式：item 权重差异大 → by-weight；否则 by-count（简单且分片数精确） */
export function shardAuto<T>(items: T[], shardCount: number, weightOf?: Weighter<T>): Shard<T>[] {
  if (!weightOf) return shardByCount(items, shardCount);
  const weights = items.map(weightOf);
  if (weights.length === 0) return [];
  const avg = weights.reduce((a, b) => a + b, 0) / weights.length;
  const max = Math.max(...weights);
  // 最大项超过均值 3 倍 → 认为分布不均，走权重分片
  return max > avg * 3 ? shardByWeight(items, shardCount, weightOf) : shardByCount(items, shardCount);
}

/**
 * 重新分片：把失败/掉线分片的 items 合并后重新平均分。
 * 注意：**已完成分片不参与重新分片**（否则已完成的工作会被重复执行）。
 */
export interface ShardState<T> {
  index: number;
  items: T[];
  status: 'pending' | 'assigned' | 'running' | 'succeeded' | 'failed' | 'reassigned';
}

export function reshuffle<T>(shards: ShardState<T>[], failedIndexes: number[], totalShards?: number): Shard<T>[] {
  const done = shards.filter((s) => s.status === 'succeeded');
  const redo = shards.filter((s) => failedIndexes.includes(s.index) || s.status === 'failed');
  const items = redo.flatMap((s) => s.items);
  if (items.length === 0) return [];
  const target = Math.max(1, Math.min(totalShards ?? redo.length ?? 1, items.length));
  const fresh = shardByCount(items, target);
  // index 从「已完成数量」往后排，避免与已完成分片 index 冲突（冲突会让统计口径混乱）
  return fresh.map((s, i) => ({ ...s, index: done.length + i, total: done.length + fresh.length }));
}

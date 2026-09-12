/**
 * 付费数据结果缓存（Phase 4 Step 2）。
 *
 * 为什么必须有：
 *   - 付费数据按次计费，重复查询是纯浪费；
 *   - 平台有频率限制，缓存能显著降低被限流的概率；
 *   - 但金融/法律/工商数据有时效性 → 每类 provider 不同 TTL，不能一刀切。
 */

export interface CacheEntry<T> {
  key: string;
  value: T;
  createdAt: number;
  expiresAt: number;
}

/** 不同数据源的缓存时长（毫秒）。行情短、工商长、学术最长。 */
const TTL_MS: Record<string, number> = {
  tonghuashun: 30_000, // 行情：30 秒
  tianyancha: 6 * 60 * 60 * 1000, // 工商司法：6 小时
  wind: 5 * 60 * 1000,
  'hs-juyuan': 5 * 60 * 1000,
  'sp-global': 10 * 60 * 1000,
  imf: 24 * 60 * 60 * 1000, // 宏观：1 天
  'hyyd-legal': 12 * 60 * 60 * 1000,
  academic: 24 * 60 * 60 * 1000,
};

export function ttlFor(providerId: string): number {
  return TTL_MS[providerId] ?? 60_000;
}

/**
 * 缓存键：provider + action + 归一化后的参数。
 * 归一化要点：key 排序（否则 {a,b} 与 {b,a} 会算出两个键，缓存命中率骤降），
 * 且剔除 purpose 这类「元信息」参数（不影响数据内容）。
 */
export function cacheKey(providerId: string, action: string, params: Record<string, unknown>): string {
  const cleaned: Record<string, unknown> = {};
  for (const k of Object.keys(params).sort()) {
    if (k === 'purpose' || k === 'confirm') continue;
    const v = params[k];
    if (v === undefined) continue;
    cleaned[k] = typeof v === 'string' ? v.trim() : v;
  }
  return `${providerId}::${action}::${JSON.stringify(cleaned)}`;
}

export class ResultCache {
  private readonly store = new Map<string, CacheEntry<unknown>>();
  private static readonly MAX_ENTRIES = 500;

  constructor(private readonly now: () => number = () => Date.now()) {}

  get<T>(key: string): T | null {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= this.now()) {
      this.store.delete(key);
      return null;
    }
    // LRU 触碰：重新插入以更新顺序
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    if (this.store.size >= ResultCache.MAX_ENTRIES) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    const createdAt = this.now();
    this.store.set(key, { key, value, createdAt, expiresAt: createdAt + ttlMs });
  }

  size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  /** 清理过期项（由 QueryRunner 定时调用或按需调用） */
  prune(): number {
    const now = this.now();
    let removed = 0;
    for (const [k, v] of this.store) {
      if (v.expiresAt <= now) {
        this.store.delete(k);
        removed += 1;
      }
    }
    return removed;
  }
}

/** 进程级共享缓存（单机场景够用；多机可换 Redis，接口不变） */
export const resultCache = new ResultCache();

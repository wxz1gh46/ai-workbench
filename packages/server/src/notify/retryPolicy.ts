/**
 * 重试策略（Step 5 / Step 6 共用）。
 *
 * 指数退避 + 抖动：
 *   delay(n) = min(maxDelayMs, baseDelayMs * factor^(n-1)) * (0.8 ~ 1.2)
 * 抖动的作用：多任务同时失败时避免形成「重试风暴」。
 */

export interface RetryOptions {
  maxRetry: number;
  baseDelayMs: number;
  factor: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxRetry: 2,
  baseDelayMs: 1000,
  factor: 2,
  maxDelayMs: 60_000,
};

/** 通讯类重试：更激进一点点，但仍有上限 */
export const NOTIFY_RETRY: RetryOptions = {
  maxRetry: 3,
  baseDelayMs: 800,
  factor: 2,
  maxDelayMs: 20_000,
};

export function normalizeRetry(input: Partial<RetryOptions> | null | undefined): RetryOptions {
  const merged = { ...DEFAULT_RETRY, ...(input ?? {}) };
  return {
    maxRetry: clamp(merged.maxRetry, 0, 10),
    baseDelayMs: clamp(merged.baseDelayMs, 100, 600_000),
    factor: clamp(merged.factor, 1, 10),
    maxDelayMs: clamp(merged.maxDelayMs, 100, 3_600_000),
  };
}

export function computeDelay(attempt: number, opts: RetryOptions): number {
  const raw = opts.baseDelayMs * Math.pow(opts.factor, Math.max(0, attempt - 1));
  const capped = Math.min(raw, opts.maxDelayMs);
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.round(capped * jitter);
}

/** 是否还有重试机会 */
export function shouldRetry(attempt: number, opts: RetryOptions): boolean {
  return attempt <= opts.maxRetry;
}

/** 带重试的执行；onRetry 用于写日志/审计（每次重试都留痕） */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
  onRetry?: (info: { attempt: number; error: string; delayMs: number }) => void,
): Promise<{ value: T; attempts: number }> {
  let attempt = 0;
  let lastError: unknown;
  while (attempt <= opts.maxRetry) {
    attempt += 1;
    try {
      const value = await fn(attempt);
      return { value, attempts: attempt };
    } catch (e) {
      lastError = e;
      if (!shouldRetry(attempt, opts)) break;
      const delayMs = computeDelay(attempt, opts);
      onRetry?.({ attempt, error: e instanceof Error ? e.message : String(e), delayMs });
      await sleep(delayMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, v));
}

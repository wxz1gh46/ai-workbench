import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { paidDataQueries, paidDataResults } from '../db/schema/index.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';
import { createAdapter } from './adapterFactory.ts';
import { checkCompliance } from './complianceGuard.ts';
import { findProvider } from './providerRegistry.ts';
import { ResultCache, cacheKey, resultCache, ttlFor } from './resultCache.ts';
import type { AdapterContext, AdapterResult } from './adapterBase.ts';

/**
 * 查询运行器（Phase 4 Step 2）。
 *
 * 一次查询的完整生命周期（顺序即安全设计）：
 *   1) 合规守卫：provider/action 合法？有无滥用意图？凭据是否齐备？
 *   2) 限流：按 provider 声明做滑动窗口限流（本地强制，不依赖对方）
 *   3) 缓存：命中则直接返回（标注 cached=true）
 *   4) 执行适配器（带超时）
 *   5) 落库：paid_data_queries + paid_data_results（含 citations）
 *   6) 审计由调用方（router）写全局 audit_logs
 *
 * 未配置凭据 / 未联调：**显式降级**（degraded=true + 说明），不抛 500、不返回假数据。
 */

const RATE_WINDOW_MS = 60_000;

export interface RunQueryInput {
  workspaceId: string;
  providerId: string;
  action: string;
  params?: Record<string, unknown>;
  credentials?: Record<string, string>;
  /** 显式跳过缓存（用户点「强制刷新」） */
  noCache?: boolean;
  /** 用途说明（审计用） */
  purpose?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface RunQueryOutput {
  queryId: string;
  providerId: string;
  action: string;
  status: 'succeeded' | 'failed' | 'blocked';
  data: unknown;
  citations: { title: string; url: string; accessedAt: string; provider: string }[];
  cached: boolean;
  degraded: boolean;
  note?: string;
  blockedReason?: string;
  rowCount: number;
  durationMs: number;
}

export class PaidDataQueryRunner {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly db: Db,
    private readonly cache: ResultCache = resultCache,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  private rateLimited(providerId: string, perMinute: number): { limited: boolean; retryAfterMs: number } {
    const now = this.clock();
    const arr = (this.hits.get(providerId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (arr.length >= perMinute) {
      const oldest = arr[0] as number;
      return { limited: true, retryAfterMs: RATE_WINDOW_MS - (now - oldest) };
    }
    arr.push(now);
    this.hits.set(providerId, arr);
    return { limited: false, retryAfterMs: 0 };
  }

  async run(input: RunQueryInput): Promise<RunQueryOutput> {
    const started = this.clock();
    const spec = findProvider(input.providerId);
    if (!spec) throw AppError.notFound(`未知的付费数据源：${input.providerId}`);
    const credentials = input.credentials ?? {};
    const params = input.params ?? {};

    const decision = checkCompliance({
      providerId: input.providerId,
      action: input.action,
      params,
      hasCredentials: Object.keys(credentials).length > 0 && spec.credentialFields.filter((f) => f.required).every((f) => Boolean(credentials[f.key]?.trim())),
      ...(input.purpose ? { purpose: input.purpose } : {}),
    });

    // 合规拒绝：也要落一行 blocked 记录，让「谁试过什么」可追溯
    if (!decision.allowed) {
      const queryId = await this.insertQuery({
        workspaceId: input.workspaceId,
        providerId: input.providerId,
        action: input.action,
        params,
        status: 'blocked',
        blockedReason: decision.reason ?? '不合规',
      });
      logger.warn('paid data query blocked by compliance guard', { providerId: input.providerId, action: input.action, code: decision.code });
      return {
        queryId,
        providerId: input.providerId,
        action: input.action,
        status: 'blocked',
        data: null,
        citations: [],
        cached: false,
        degraded: false,
        blockedReason: decision.reason,
        rowCount: 0,
        durationMs: this.clock() - started,
      };
    }

    const limit = this.rateLimited(input.providerId, spec.rateLimit.perMinute);
    if (limit.limited) {
      throw new AppError('RATE_LIMITED', `${spec.name} 本地限流：${spec.rateLimit.note}。请在 ${Math.ceil(limit.retryAfterMs / 1000)} 秒后重试。`, 429, {
        providerId: input.providerId,
        perMinute: spec.rateLimit.perMinute,
        retryAfterMs: limit.retryAfterMs,
      });
    }

    const key = cacheKey(input.providerId, input.action, params);
    if (!input.noCache) {
      const hit = this.cache.get<{ data: unknown; citations: AdapterResult['citations']; degraded: boolean; note?: string }>(key);
      if (hit) {
        const queryId = await this.insertQuery({
          workspaceId: input.workspaceId,
          providerId: input.providerId,
          action: input.action,
          params,
          status: 'succeeded',
          cached: true,
          degraded: hit.degraded,
          rowCount: countRows(hit.data),
          durationMs: this.clock() - started,
        });
        await this.insertResult(queryId, hit.data, hit.citations, key, this.clock() + ttlFor(input.providerId));
        return {
          queryId,
          providerId: input.providerId,
          action: input.action,
          status: 'succeeded',
          data: hit.data,
          citations: hit.citations,
          cached: true,
          degraded: hit.degraded,
          ...(hit.note ? { note: hit.note } : {}),
          rowCount: countRows(hit.data),
          durationMs: this.clock() - started,
        };
      }
    }

    const adapter = createAdapter(input.providerId);
    const ctx: AdapterContext = {
      providerId: input.providerId,
      credentials,
      timeoutMs: input.timeoutMs ?? 15_000,
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    };

    let result: AdapterResult;
    try {
      result = await adapter.query(input.action, params, ctx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const queryId = await this.insertQuery({
        workspaceId: input.workspaceId,
        providerId: input.providerId,
        action: input.action,
        params,
        status: 'failed',
        error: msg,
        durationMs: this.clock() - started,
      });
      return {
        queryId,
        providerId: input.providerId,
        action: input.action,
        status: 'failed',
        data: null,
        citations: [],
        cached: false,
        degraded: false,
        note: msg,
        rowCount: 0,
        durationMs: this.clock() - started,
      };
    }

    // 降级结果不写缓存：否则「未配置凭据」的空结果会被缓存住，用户配置完还得等 TTL 过期
    if (!result.degraded) {
      this.cache.set(key, { data: result.data, citations: result.citations, degraded: result.degraded, note: result.note }, ttlFor(input.providerId));
    }

    const queryId = await this.insertQuery({
      workspaceId: input.workspaceId,
      providerId: input.providerId,
      action: input.action,
      params,
      status: 'succeeded',
      degraded: result.degraded,
      rowCount: countRows(result.data),
      durationMs: this.clock() - started,
    });
    await this.insertResult(queryId, result.data, result.citations, key, result.degraded ? null : this.clock() + ttlFor(input.providerId));

    return {
      queryId,
      providerId: input.providerId,
      action: input.action,
      status: 'succeeded',
      data: result.data,
      citations: result.citations,
      cached: false,
      degraded: result.degraded,
      ...(result.note ? { note: result.note } : {}),
      rowCount: countRows(result.data),
      durationMs: this.clock() - started,
    };
  }

  async getQuery(workspaceId: string, queryId: string) {
    const rows = (await this.db.select().from(paidDataQueries).where(eq(paidDataQueries.id, queryId)).limit(1)) as unknown as QueryRow[];
    const row = rows[0];
    if (!row || row.workspaceId !== workspaceId) throw AppError.notFound(`查询记录不存在: ${queryId}`);
    const resultRows = (await this.db.select().from(paidDataResults).where(eq(paidDataResults.queryId, queryId)).limit(1)) as unknown as ResultRow[];
    return { query: row, result: resultRows[0] ?? null };
  }

  async listQueries(workspaceId: string, limit = 50) {
    const rows = (await this.db.select().from(paidDataQueries)) as unknown as QueryRow[];
    return rows
      .filter((r) => r.workspaceId === workspaceId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  /** 保存前预检：让 UI 能在提交前提示用户「会被拒」 */
  preflight(input: { providerId: string; action: string; params?: Record<string, unknown>; hasCredentials: boolean }) {
    return checkCompliance({
      providerId: input.providerId,
      action: input.action,
      params: input.params ?? {},
      hasCredentials: input.hasCredentials,
    });
  }

  private async insertQuery(input: {
    workspaceId: string;
    providerId: string;
    action: string;
    params: Record<string, unknown>;
    status: QueryRow['status'];
    cached?: boolean;
    degraded?: boolean;
    rowCount?: number;
    durationMs?: number;
    error?: string;
    blockedReason?: string;
  }): Promise<string> {
    const id = newId('pdq');
    const now = nowIso();
    await this.db.insert(paidDataQueries).values({
      id,
      workspaceId: input.workspaceId,
      providerId: input.providerId,
      action: input.action,
      params: input.params as never,
      status: input.status,
      cached: input.cached ?? false,
      degraded: input.degraded ?? false,
      rowCount: input.rowCount ?? 0,
      durationMs: Math.max(0, Math.round(input.durationMs ?? 0)),
      error: input.error ?? null,
      blockedReason: input.blockedReason ?? null,
      createdAt: now,
      finishedAt: now,
    } as never);
    return id;
  }

  private async insertResult(queryId: string, data: unknown, citations: AdapterResult['citations'], key: string, expiresAtMs: number | null) {
    await this.db.insert(paidDataResults).values({
      id: newId('pdr'),
      queryId,
      data: (data ?? null) as never,
      citations: citations as never,
      cacheKey: key,
      expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(),
      createdAt: nowIso(),
    } as never);
  }
}

export type QueryRow = typeof paidDataQueries.$inferSelect;
export type ResultRow = typeof paidDataResults.$inferSelect;

/** 行数估算：数组取长度，{items|data|rows} 取第一个数组的长度 */
export function countRows(data: unknown): number {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === 'object') {
    for (const k of ['items', 'data', 'rows', 'results', 'list']) {
      const v = (data as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v.length;
    }
  }
  return data === null || data === undefined ? 0 : 1;
}

import type { QueryResult } from '@ai/shared';
import { AppError } from '../utils/errors.ts';
import { PostgresAdapter } from './postgresAdapter.ts';
import type { DbAdapter } from './adapter.ts';

/**
 * 查询运行器（Step 2）。
 *
 * 安全设计（这是整条链路里最容易出事的地方，所以做三层防护）：
 *   1. 静态层：PostgresAdapter.inspect 拦 DROP DATABASE / TRUNCATE / COPY FROM PROGRAM 等；
 *   2. 会话层：只读时 `BEGIN READ ONLY`，即使 SQL 是写操作数据库也会拒绝；
 *   3. 结果层：强制 LIMIT（行数上限），避免把百万行拉进内存。
 *
 * 参数化：支持 $1,$2 占位符；禁止把 params 直接拼进 SQL（调用方传值，这里只做绑定）。
 */

export interface QueryOptions {
  readOnly: boolean;
  limit: number;
  /** 写操作必须显式确认（由 dangerGate 上层校验后传入） */
  confirmed: boolean;
}

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 2000;

export class QueryRunner {
  constructor(private readonly adapter: DbAdapter) {}

  static normalizeLimit(input: unknown): number {
    const n = Number(input ?? DEFAULT_LIMIT);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
    return Math.min(Math.floor(n), MAX_LIMIT);
  }

  /** 预检：不执行，只返回结论（UI 上「执行前确认」用） */
  preflight(sql: string, opts: { readOnly: boolean }): { safe: boolean; isWrite: boolean; reason?: string; needConfirm: boolean } {
    const inspection = PostgresAdapter.inspect(sql);
    return {
      safe: inspection.safe,
      isWrite: inspection.isWrite,
      reason: inspection.reason,
      needConfirm: inspection.isWrite && !opts.readOnly,
    };
  }

  async run(sql: string, params: unknown[] = [], opts: Partial<QueryOptions> = {}): Promise<QueryResult> {
    const readOnly = opts.readOnly ?? true;
    const limit = QueryRunner.normalizeLimit(opts.limit);
    const inspection = PostgresAdapter.inspect(sql);
    if (!inspection.safe) throw AppError.badRequest(inspection.reason ?? 'SQL 被安全策略拒绝');

    if (inspection.isWrite) {
      if (readOnly) throw AppError.forbidden('当前为只读模式：请关闭只读（需二次确认）后再执行写操作');
      if (opts.confirmed !== true) throw AppError.confirmRequired('写操作需要二次确认', { sql: sql.slice(0, 200), kind: 'db.write' });
    }

    if (!this.adapter.configured()) {
      throw AppError.badRequest(`未配置数据库连接：${this.adapter.label} 需要用户手动填写连接串`);
    }

    const effectiveSql = inspection.isWrite ? sql : withLimit(sql, limit);
    const started = Date.now();
    const result = await this.adapter.runQuery(effectiveSql, params, { readOnly, limit });
    return { ...result, ms: Date.now() - started, readOnly };
  }
}

/** 给 SELECT 追加 LIMIT（已有 LIMIT 时不重复加） */
export function withLimit(sql: string, limit: number): string {
  const trimmed = sql.trim().replace(/;$/, '');
  if (/\blimit\s+\d+/i.test(trimmed)) return trimmed;
  if (!/^\s*(select|with|table|values)\b/i.test(trimmed)) return trimmed;
  return `${trimmed} limit ${limit}`;
}

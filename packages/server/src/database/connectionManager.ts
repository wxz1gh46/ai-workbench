import { eq } from 'drizzle-orm';
import type { DatabaseConnectionInfo, DatabaseProvider } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { databaseConnections } from '../db/schema/index.ts';
import { AppError } from '../utils/errors.ts';
import { redactConnectionString, seal, unseal } from '../security/secrets.ts';
import { resolveProviderToken } from '../security/secrets.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';

/**
 * 连接管理（Step 2）。
 *
 * 存储设计（三条硬约束）：
 *   1. 连接串必须以密文入库（encrypted_config），DB 里搜不到任何明文凭据；
 *   2. 对外接口只返回「脱敏后的形状」，例如 postgres://us****:****@host/db；
 *   3. host/database 单独存明文列，仅用于展示与审计（它们不是凭据）。
 *
 * 与 0001 的 database_connections 表兼容：沿用 id/workspace_id/kind/name/secret_ref，
 * Phase 3 的字段（provider/status/encrypted_config/schema_json/...）由 0003 迁移补列。
 */
export interface ConnectionInput {
  workspaceId: string;
  provider: DatabaseProvider;
  name: string;
  /** 连接串（仅在内存中出现，落库前加密） */
  connectionString: string;
  branch?: string;
  note?: string;
}

export class ConnectionManager {
  constructor(private readonly db: Db) {}

  async create(input: ConnectionInput): Promise<DatabaseConnectionInfo> {
    const name = input.name.trim();
    if (!name) throw AppError.badRequest('连接名称不能为空');
    const conn = input.connectionString.trim();
    if (!conn) throw AppError.badRequest('连接串不能为空');
    const parsed = parseConnectionString(conn);

    const now = nowIso();
    const row = {
      id: newId('db'),
      workspaceId: input.workspaceId,
      kind: input.provider,
      provider: input.provider,
      name,
      secretRef: `dbconn:${newId('sec')}`,
      encryptedConfig: seal({ connectionString: conn, branch: input.branch ?? null, note: input.note ?? null }),
      status: 'unconfigured' as const,
      schemaJson: {} as Record<string, unknown>,
      schemaVersion: 0,
      host: parsed.host,
      database: parsed.database,
      ssl: parsed.ssl,
      lastTestedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(databaseConnections).values(row as never);
    logger.info('database connection created', { id: row.id, provider: row.provider, host: row.host });
    return this.toPublic(row as never);
  }

  async list(workspaceId: string): Promise<DatabaseConnectionInfo[]> {
    const rows = await this.db.select().from(databaseConnections).where(eq(databaseConnections.workspaceId, workspaceId));
    return rows.map((r) => this.toPublic(r as never));
  }

  async raw(workspaceId: string, id: string) {
    const rows = await this.db.select().from(databaseConnections).where(eq(databaseConnections.id, id)).limit(1);
    const row = rows[0];
    if (!row || row.workspaceId !== workspaceId) return null;
    return row;
  }

  async get(workspaceId: string, id: string): Promise<DatabaseConnectionInfo> {
    const row = await this.raw(workspaceId, id);
    if (!row) throw AppError.notFound(`数据库连接不存在: ${id}`);
    return this.toPublic(row as never);
  }

  /** 解密连接串：只在真正要连数据库时调用，调用方不得把它写进日志 */
  async resolveConnectionString(workspaceId: string, id: string): Promise<string | null> {
    const row = await this.raw(workspaceId, id);
    if (!row) throw AppError.notFound(`数据库连接不存在: ${id}`);
    if (!row.encryptedConfig) return null;
    const secret = unseal<{ connectionString?: string }>(row.encryptedConfig);
    return secret?.connectionString ?? null;
  }

  async updateStatus(workspaceId: string, id: string, status: 'unconfigured' | 'ok' | 'error' | 'migrating'): Promise<void> {
    await this.db
      .update(databaseConnections)
      .set({ status, lastTestedAt: nowIso(), updatedAt: nowIso() })
      .where(eq(databaseConnections.id, id));
    void workspaceId;
  }

  async saveSchemaSnapshot(workspaceId: string, id: string, schema: Record<string, unknown>): Promise<number> {
    const row = await this.raw(workspaceId, id);
    if (!row) throw AppError.notFound(`数据库连接不存在: ${id}`);
    const version = row.schemaVersion + 1;
    await this.db
      .update(databaseConnections)
      .set({ schemaJson: schema as never, schemaVersion: version, updatedAt: nowIso() })
      .where(eq(databaseConnections.id, id));
    return version;
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    const row = await this.raw(workspaceId, id);
    if (!row) throw AppError.notFound(`数据库连接不存在: ${id}`);
    await this.db.delete(databaseConnections).where(eq(databaseConnections.id, id));
    logger.info('database connection removed', { id });
  }

  /** 供 UI 与审计使用的脱敏视图 */
  private toPublic(row: {
    id: string;
    workspaceId: string;
    provider: string;
    kind: string;
    name: string;
    host: string | null;
    database: string | null;
    ssl: boolean;
    status: string;
    schemaVersion: number;
    lastTestedAt: string | null;
    createdAt: string;
    updatedAt: string;
    encryptedConfig: string | null;
  }): DatabaseConnectionInfo {
    const provider = (row.provider || row.kind) as DatabaseProvider;
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      provider,
      name: row.name,
      status: (row.status as DatabaseConnectionInfo['status']) ?? 'unconfigured',
      target: row.host ? `postgres://${row.host}${row.database ? `/${row.database}` : ''}` : '（未配置）',
      schemaVersion: row.schemaVersion,
      lastTestedAt: row.lastTestedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      configured: Boolean(row.encryptedConfig) || Boolean(resolveProviderToken(provider)),
    };
  }
}

/** 解析连接串中的非敏感信息（host/db/ssl），失败时给出可读错误 */
export function parseConnectionString(conn: string): { host: string | null; database: string | null; ssl: boolean } {
  try {
    const u = new URL(conn);
    if (!/^(postgres|postgresql|sqlite):$/.test(u.protocol)) {
      throw new Error(`协议不被支持：${u.protocol}（支持 postgres:// / postgresql://）`);
    }
    const sslParam = u.searchParams.get('sslmode');
    return {
      host: u.host || null,
      database: u.pathname.replace(/^\//, '') || null,
      ssl: sslParam !== 'disable',
    };
  } catch (e) {
    if (conn.startsWith('sqlite:')) return { host: null, database: conn.replace(/^sqlite:/, ''), ssl: false };
    throw AppError.badRequest(`连接串格式不合法：${e instanceof Error ? e.message : String(e)}（示例：postgres://user:pass@host:5432/db?sslmode=require）`);
  }
}

export { redactConnectionString };

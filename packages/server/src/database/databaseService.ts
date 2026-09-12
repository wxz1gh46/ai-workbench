import type { DatabaseProvider, DatabaseSchemaSnapshot, QueryResult, WebsitePlan } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { AppError } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';
import { ConnectionManager } from './connectionManager.ts';
import { createAdapter, supportedProviders } from './adapterFactory.ts';
import { generateSchema, migrationName } from './schemaGenerator.ts';
import { MigrationRunner } from './migrationRunner.ts';
import { QueryRunner } from './queryRunner.ts';
import { BackupService, type BackupArtifact } from './backup.ts';
import { DbAuditor } from '../audit/index.ts';
import { getAdapter } from '../deploy/providerRegistry.ts';
import type { DbAdapter, ConnectionTestResult } from './adapter.ts';

/**
 * 数据库服务（Step 2 编排）。
 *
 * 统一在这里做三件事：
 *   1. 组装适配器（从加密存储取连接串）；
 *   2. 写审计（每次 test/query/migrate/backup 都留痕）；
 *   3. 把「未配置凭据」变成可读提示，而不是抛底层网络错误。
 */
export class DatabaseService {
  private readonly conn: ConnectionManager;
  private readonly migrations: MigrationRunner;
  private readonly backups = new Map<string, BackupArtifact>();

  constructor(private readonly db: Db) {
    this.conn = new ConnectionManager(db);
    this.migrations = new MigrationRunner(db);
  }

  private auditor() {
    return new DbAuditor(this.db);
  }

  async createConnection(input: { workspaceId: string; provider: DatabaseProvider; name: string; connectionString: string; branch?: string; note?: string; actor?: string }) {
    const info = await this.conn.create(input);
    await this.auditor().record({
      workspaceId: input.workspaceId,
      action: 'db.create',
      actor: input.actor ?? 'user',
      databaseConnectionId: info.id,
      confirmedByUser: true,
      detail: { provider: info.provider, name: info.name, target: info.target },
    });
    return info;
  }

  async listConnections(workspaceId: string) {
    return this.conn.list(workspaceId);
  }

  async getConnection(workspaceId: string, id: string) {
    return this.conn.get(workspaceId, id);
  }

  async removeConnection(input: { workspaceId: string; id: string; actor?: string; confirm: boolean }) {
    await this.conn.remove(input.workspaceId, input.id);
    await this.auditor().record({
      workspaceId: input.workspaceId,
      action: 'db.delete',
      actor: input.actor ?? 'user',
      databaseConnectionId: input.id,
      confirmedByUser: input.confirm,
      detail: { removed: true },
    });
    return { ok: true };
  }

  /** 构造适配器（惰性连接，不会因为未配置凭据而失败） */
  async adapterFor(workspaceId: string, id: string, opts: { allowWrite?: boolean } = {}): Promise<DbAdapter> {
    const info = await this.conn.get(workspaceId, id);
    const connectionString = await this.conn.resolveConnectionString(workspaceId, id);
    return createAdapter({ provider: info.provider, connectionString, allowWrite: opts.allowWrite });
  }

  async testConnection(input: { workspaceId: string; id: string; actor?: string }): Promise<ConnectionTestResult & { provider: DatabaseProvider }> {
    const info = await this.conn.get(input.workspaceId, input.id);
    const adapter = await this.adapterFor(input.workspaceId, input.id);
    const result = await adapter.testConnection();
    await adapter.dispose().catch(() => undefined);
    await this.conn.updateStatus(input.workspaceId, input.id, result.ok ? 'ok' : result.degraded ? 'unconfigured' : 'error');
    await this.auditor().record({
      workspaceId: input.workspaceId,
      action: 'db.test',
      actor: input.actor ?? 'user',
      databaseConnectionId: input.id,
      confirmedByUser: true,
      detail: { ok: result.ok, degraded: result.degraded, latencyMs: result.latencyMs, message: result.message.slice(0, 300) },
    });
    logger.info('db test', { id: input.id, ok: result.ok, degraded: result.degraded });
    return { ...result, provider: info.provider };
  }

  /** 生成 Schema（纯计算，不需要连接） */
  async generateSchema(input: { workspaceId: string; id: string; plan: WebsitePlan; actor?: string; withRls?: boolean }) {
    const info = await this.conn.get(input.workspaceId, input.id);
    const generated = generateSchema(input.plan, { withRls: input.withRls ?? info.provider === 'supabase' });
    const version = await this.conn.saveSchemaSnapshot(input.workspaceId, input.id, generated.snapshot as unknown as Record<string, unknown>);
    await this.auditor().record({
      workspaceId: input.workspaceId,
      action: 'db.schema.generate',
      actor: input.actor ?? 'user',
      databaseConnectionId: input.id,
      confirmedByUser: true,
      detail: { tables: generated.snapshot.tables.length, version, withRls: Boolean(input.withRls) },
    });
    return { snapshot: generated.snapshot, up: generated.up, down: generated.down, version };
  }

  async introspect(input: { workspaceId: string; id: string; actor?: string; save?: boolean }): Promise<DatabaseSchemaSnapshot> {
    const adapter = await this.adapterFor(input.workspaceId, input.id);
    if (!adapter.configured()) {
      await this.auditor().record({
        workspaceId: input.workspaceId,
        action: 'db.introspect.blocked',
        actor: input.actor ?? 'user',
        databaseConnectionId: input.id,
        confirmedByUser: false,
        detail: { reason: 'not-configured' },
      });
      throw AppError.badRequest(`未配置 ${adapter.label} 连接串：请在连接详情中填写后再试`);
    }
    const snapshot = await adapter.introspection();
    await adapter.dispose().catch(() => undefined);
    if (input.save !== false) await this.conn.saveSchemaSnapshot(input.workspaceId, input.id, snapshot as unknown as Record<string, unknown>);
    await this.auditor().record({
      workspaceId: input.workspaceId,
      action: 'db.introspect',
      actor: input.actor ?? 'user',
      databaseConnectionId: input.id,
      confirmedByUser: true,
      detail: { tables: snapshot.tables.length },
    });
    return snapshot;
  }

  /** 从网站项目计划 + 连接生成并创建迁移（可选立即执行） */
  async createMigration(input: {
    workspaceId: string;
    id: string;
    name?: string;
    sql?: string;
    downSql?: string;
    plan?: WebsitePlan;
    actor?: string;
  }) {
    let sql = input.sql ?? '';
    let downSql = input.downSql ?? '';
    if (input.plan) {
      const generated = generateSchema(input.plan, {});
      sql = generated.up;
      downSql = generated.down;
    }
    const existing = await this.migrations.list(input.id);
    const name = input.name ?? migrationName(existing.length + 1, 'init');
    const migration = await this.migrations.plan({ databaseConnectionId: input.id, name, sql, downSql });
    await this.auditor().record({
      workspaceId: input.workspaceId,
      action: 'db.migration.plan',
      actor: input.actor ?? 'user',
      databaseConnectionId: input.id,
      confirmedByUser: true,
      detail: { name, bytes: sql.length, hasDown: Boolean(downSql.trim()) },
    });
    return migration;
  }

  async listMigrations(workspaceId: string, id: string) {
    void workspaceId;
    return this.migrations.list(id);
  }

  async applyMigration(input: { workspaceId: string; id: string; migrationId: string; actor?: string; confirm: boolean }) {
    const migration = await this.migrations.get(input.migrationId);
    if (!migration) throw AppError.notFound(`迁移不存在: ${input.migrationId}`);
    const adapter = await this.adapterFor(input.workspaceId, input.id);
    if (!adapter.configured()) throw AppError.badRequest(`未配置 ${adapter.label} 连接串，无法执行迁移`);
    await this.conn.updateStatus(input.workspaceId, input.id, 'migrating');
    const res = await this.migrations.apply(adapter, migration);
    await adapter.dispose().catch(() => undefined);
    await this.conn.updateStatus(input.workspaceId, input.id, res.ok ? 'ok' : 'error');
    await this.auditor().record({
      workspaceId: input.workspaceId,
      action: 'db.migrate',
      actor: input.actor ?? 'user',
      databaseConnectionId: input.id,
      confirmedByUser: input.confirm,
      detail: { migrationId: migration.id, name: migration.name, ok: res.ok, message: res.message.slice(0, 300) },
    });
    return res;
  }

  async rollbackMigration(input: { workspaceId: string; id: string; migrationId: string; actor?: string; confirm: boolean }) {
    const migration = await this.migrations.get(input.migrationId);
    if (!migration) throw AppError.notFound(`迁移不存在: ${input.migrationId}`);
    const preview = this.migrations.rollbackPreview(migration);
    const adapter = await this.adapterFor(input.workspaceId, input.id);
    const res = await this.migrations.rollback(adapter, migration);
    await adapter.dispose().catch(() => undefined);
    await this.auditor().record({
      workspaceId: input.workspaceId,
      action: 'db.rollback',
      actor: input.actor ?? 'user',
      databaseConnectionId: input.id,
      confirmedByUser: input.confirm,
      detail: { migrationId: migration.id, name: migration.name, ok: res.ok, dangerous: preview.dangerous },
    });
    return { ...res, preview };
  }

  async runQuery(input: {
    workspaceId: string;
    id: string;
    sql: string;
    params?: unknown[];
    readOnly?: boolean;
    limit?: number;
    actor?: string;
    confirm?: boolean;
  }): Promise<QueryResult> {
    const adapter = await this.adapterFor(input.workspaceId, input.id, { allowWrite: input.confirm === true });
    const runner = new QueryRunner(adapter);
    const readOnly = input.readOnly ?? true;
    const preflight = runner.preflight(input.sql, { readOnly });
    try {
      const result = await runner.run(input.sql, input.params ?? [], { readOnly, limit: input.limit, confirmed: input.confirm });
      await this.auditor().record({
        workspaceId: input.workspaceId,
        action: preflight.isWrite ? 'db.write' : 'db.query',
        actor: input.actor ?? 'user',
        databaseConnectionId: input.id,
        confirmedByUser: preflight.isWrite ? input.confirm === true : true,
        // SQL 可能很长，只留前 500 字符；绝不记录 params（可能含隐私数据）
        detail: { sqlPreview: input.sql.slice(0, 500), rows: result.rowCount, ms: result.ms, readOnly, truncated: result.truncated },
      });
      return result;
    } catch (e) {
      await this.auditor().record({
        workspaceId: input.workspaceId,
        action: preflight.isWrite ? 'db.write.blocked' : 'db.query.failed',
        actor: input.actor ?? 'user',
        databaseConnectionId: input.id,
        confirmedByUser: input.confirm === true,
        detail: { sqlPreview: input.sql.slice(0, 500), error: e instanceof Error ? e.message.slice(0, 300) : String(e) },
      });
      throw e;
    } finally {
      await adapter.dispose().catch(() => undefined);
    }
  }

  async backup(input: { workspaceId: string; id: string; actor?: string; compress?: boolean; confirm: boolean }) {
    const adapter = await this.adapterFor(input.workspaceId, input.id);
    if (!adapter.configured()) throw AppError.badRequest(`未配置 ${adapter.label} 连接串，无法备份`);
    const service = new BackupService(input.id);
    const artifact = await service.create(adapter, { compress: input.compress });
    await adapter.dispose().catch(() => undefined);
    this.backups.set(artifact.id, artifact);
    await this.auditor().record({
      workspaceId: input.workspaceId,
      action: 'db.backup',
      actor: input.actor ?? 'user',
      databaseConnectionId: input.id,
      confirmedByUser: input.confirm,
      detail: { backupId: artifact.id, tables: artifact.tables, bytes: artifact.bytes, sha256: artifact.sha256.slice(0, 16) },
    });
    return {
      id: artifact.id,
      createdAt: artifact.createdAt,
      format: artifact.format,
      bytes: artifact.bytes,
      tables: artifact.tables,
      sha256: artifact.sha256,
      preview: artifact.preview,
      downloadPath: `backups/${input.id}/${artifact.id}.${artifact.format}`,
    };
  }

  /** 恢复计划：不自动执行，返回 SQL 与步骤（危险动作由用户确认后走查询通道） */
  async planRestore(input: { workspaceId: string; id: string; backupId: string; actor?: string }) {
    const artifact = this.backups.get(input.backupId);
    if (!artifact) throw AppError.notFound(`备份不存在: ${input.backupId}`);
    const plan = BackupService.planRestore(artifact);
    await this.auditor().record({
      workspaceId: input.workspaceId,
      action: 'db.restore.plan',
      actor: input.actor ?? 'user',
      databaseConnectionId: input.id,
      confirmedByUser: false,
      detail: { backupId: input.backupId, bytes: artifact.bytes },
    });
    return plan;
  }

  async listBackups(workspaceId: string, id: string) {
    void workspaceId;
    return [...this.backups.values()]
      .filter((b) => b.connectionId === id)
      .map((b) => ({
        id: b.id,
        createdAt: b.createdAt,
        format: b.format,
        bytes: b.bytes,
        tables: b.tables,
        sha256: b.sha256,
      }));
  }

  providers() {
    return supportedProviders();
  }

  /** 供「部署中心」复用：把网站项目的 schema 同步过去 */
  async syncPlanSchemaFromProject(input: { workspaceId: string; connectionId: string; plan: WebsitePlan; actor?: string }) {
    return this.generateSchema({ ...input, id: input.connectionId });
  }
}

export { getAdapter };

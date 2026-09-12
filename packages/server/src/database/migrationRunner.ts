import { and, desc, eq } from 'drizzle-orm';
import type { DatabaseMigration } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { databaseMigrations } from '../db/schema/index.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { PostgresAdapter } from './postgresAdapter.ts';

/**
 * 迁移运行器（Step 2）。
 *
 * 关键要求：「版本化 + 可回滚」。
 *   - 每条迁移都必须带 downSql，缺 down 的迁移不允许创建（宁可提前报错）；
 *   - 执行前做静态安全校验（PostgresAdapter.inspect），拒绝 DROP DATABASE 等；
 *   - 执行结果与错误都落库，UI 可完整回看迁移历史；
 *   - 回滚是「单条迁移粒度」，不是「回滚到最后一次」这种粗暴操作。
 */

export interface MigrationInput {
  databaseConnectionId: string;
  name: string;
  sql: string;
  downSql: string;
}

export class MigrationRunner {
  constructor(private readonly db: Db) {}

  async plan(input: MigrationInput): Promise<DatabaseMigration> {
    if (!input.name.trim()) throw AppError.badRequest('迁移名称不能为空');
    if (!input.sql.trim()) throw AppError.badRequest('迁移 SQL 不能为空');
    if (!input.downSql.trim()) {
      throw AppError.badRequest(
        '缺少回滚脚本（downSql）：Phase 3 要求每条迁移可独立回滚。请同时提供 down 脚本（例如 drop table if exists ...）',
      );
    }
    // 静态安全校验（不连接数据库）
    for (const stmt of splitStatements(input.sql)) {
      const inspection = PostgresAdapter.inspect(stmt);
      if (!inspection.safe) throw AppError.badRequest(`迁移 SQL 被安全策略拒绝：${inspection.reason}`);
    }

    const row = {
      id: newId('dmi'),
      databaseConnectionId: input.databaseConnectionId,
      name: input.name.trim(),
      sql: input.sql,
      downSql: input.downSql,
      status: 'pending' as const,
      appliedAt: null,
      error: null,
      createdAt: nowIso(),
    };
    await this.db.insert(databaseMigrations).values(row);
    return row as unknown as DatabaseMigration;
  }

  async list(databaseConnectionId: string): Promise<DatabaseMigration[]> {
    const rows = await this.db
      .select()
      .from(databaseMigrations)
      .where(eq(databaseMigrations.databaseConnectionId, databaseConnectionId))
      .orderBy(desc(databaseMigrations.createdAt));
    return rows as unknown as DatabaseMigration[];
  }

  async markApplied(id: string, error: string | null): Promise<void> {
    await this.db
      .update(databaseMigrations)
      .set({ status: error ? 'failed' : 'applied', appliedAt: error ? null : nowIso(), error })
      .where(eq(databaseMigrations.id, id));
  }

  /** 执行一条迁移：调用适配器的 applyMigration（事务 + 幂等表） */
  async apply(adapter: { applyMigration: (items: { name: string; sql: string; downSql: string }[]) => Promise<{ applied: string[]; failed: { name: string; error: string }[] }> }, migration: DatabaseMigration): Promise<{ ok: boolean; message: string }> {
    const res = await adapter.applyMigration([{ name: migration.name, sql: migration.sql, downSql: migration.downSql }]);
    if (res.failed.length > 0) {
      const err = res.failed[0]?.error ?? '未知错误';
      await this.markApplied(migration.id, err);
      return { ok: false, message: err };
    }
    await this.markApplied(migration.id, null);
    return { ok: true, message: `迁移 ${migration.name} 已应用` };
  }

  /** 回滚：先静态校验 down 脚本，再执行，成功后标记 rolled-back */
  async rollback(adapter: { applyMigration: (items: { name: string; sql: string; downSql: string }[]) => Promise<{ applied: string[]; failed: { name: string; error: string }[] }> }, migration: DatabaseMigration): Promise<{ ok: boolean; message: string }> {
    if (!migration.downSql?.trim()) return { ok: false, message: '该迁移没有回滚脚本，无法回滚' };
    if (migration.status !== 'applied') return { ok: false, message: `只有已应用的迁移才能回滚（当前状态：${migration.status}）` };
    for (const stmt of splitStatements(migration.downSql)) {
      const inspection = PostgresAdapter.inspect(stmt);
      if (!inspection.safe) return { ok: false, message: `回滚脚本被安全策略拒绝：${inspection.reason}` };
    }
    const res = await adapter.applyMigration([
      { name: `rollback:${migration.name}`, sql: migration.downSql, downSql: migration.sql },
    ]);
    if (res.failed.length > 0) {
      const err = res.failed[0]?.error ?? '未知错误';
      await this.db.update(databaseMigrations).set({ error: `回滚失败：${err}`, status: 'failed' }).where(eq(databaseMigrations.id, migration.id));
      return { ok: false, message: err };
    }
    await this.db
      .update(databaseMigrations)
      .set({ status: 'rolled-back', error: null })
      .where(and(eq(databaseMigrations.id, migration.id)));
    return { ok: true, message: `迁移 ${migration.name} 已回滚` };
  }

  async get(id: string): Promise<DatabaseMigration | null> {
    const rows = await this.db.select().from(databaseMigrations).where(eq(databaseMigrations.id, id)).limit(1);
    return (rows[0] as unknown as DatabaseMigration) ?? null;
  }

  /** 回滚计划（UI 预检用）：返回将被执行的 SQL，便于用户二次确认 */
  rollbackPreview(migration: DatabaseMigration): { name: string; sql: string; dangerous: boolean } {
    return {
      name: migration.name,
      sql: migration.downSql,
      dangerous: /drop\s+table|delete\s+from|alter\s+table/i.test(migration.downSql),
    };
  }
}

function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));
}

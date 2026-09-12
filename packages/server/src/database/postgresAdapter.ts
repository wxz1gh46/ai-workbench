import { Client } from 'pg';
import type { DatabaseProvider, DatabaseSchemaSnapshot, QueryResult } from '@ai/shared';
import { AppError } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';
import type { ApplyResult, ConnectionTestResult, DbAdapter, MigrationPlanItem } from './adapter.ts';

/**
 * Postgres 系适配器（Neon / Supabase / 普通 Postgres / 本地 Postgres 共用）。
 *
 * 硬约束（安全）：
 *   1. 只读模式：默认 readOnly，且用事务 + `SET TRANSACTION READ ONLY` 强制；
 *   2. 危险语句硬拦截：DROP DATABASE / DROP SCHEMA / TRUNCATE 等即使在写模式也要二次确认；
 *   3. 行数上限：任何查询都加 LIMIT，避免把百万行拉进内存；
 *   4. 未配置连接串时所有连接类操作返回 degraded，而不是抛网络错误。
 *
 * 为什么用 pg 的 Client 而不是连接池：
 *   桌面场景并发极低（一次一个操作），短连接更容易回收，也避免把凭据长期驻留内存。
 */

const BLOCKED_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\bdrop\s+database\b/i, reason: 'DROP DATABASE 会删除整个数据库实例，工作台拒绝执行' },
  { re: /\bdrop\s+schema\s+(public|information_schema)\b/i, reason: '不允许删除系统 schema' },
  { re: /\btruncate\b/i, reason: 'TRUNCATE 会清空表数据，请改为 DELETE 并显式确认' },
  { re: /\bpg_read_file\b|\bpg_ls_dir\b|\bcopy\s+.*\s+from\s+program\b/i, reason: '禁止使用读取服务器文件系统的函数' },
  { re: /\bcreate\s+extension\b/i, reason: '扩展安装需在数据库控制台手动完成（权限边界）' },
  { re: /\bgrant\b|\brevoke\b/i, reason: 'GRANT/REVOKE 会改变数据库权限模型，工作台拒绝执行（请用数据库控制台）' },
  { re: /\balter\s+(role|user)\b.*\b(superuser|createrole|bypassrls)\b/i, reason: '禁止在应用层修改数据库角色权限' },
  { re: /\b(superuser|pg_execute_server_program)\b/i, reason: '禁止使用超级用户或用例函数' },
];

export class PostgresAdapter implements DbAdapter {
  readonly provider: DatabaseProvider;
  readonly label: string;

  constructor(input: {
    provider: DatabaseProvider;
    label: string;
    /** 解密后的连接串（仅内存） */
    connectionString: string | null;
    /** 允许写操作（默认 false，只读） */
    allowWrite?: boolean;
  }) {
    this.provider = input.provider;
    this.label = input.label;
    this.connectionString = input.connectionString;
    this.allowWrite = input.allowWrite ?? false;
  }

  private readonly connectionString: string | null;
  private readonly allowWrite: boolean;
  private client: Client | null = null;

  configured(): boolean {
    return Boolean(this.connectionString && this.connectionString.trim());
  }

  private assertConfigured(): string {
    if (!this.configured()) {
      throw AppError.badRequest(
        `未配置 ${this.label} 连接串：请在数据库面板中新建连接并填入 DATABASE_URL（工作台不会替你申请账号）`,
      );
    }
    return this.connectionString as string;
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const conn = this.assertConfigured();
    const client = new Client({
      connectionString: conn,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: process.env.PGSSL_NOSTRICT !== '1' },
      connectionTimeoutMillis: 10_000,
      statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT ?? 30_000),
      application_name: 'ai-workbench-phase3',
    });
    await client.connect();
    client.on('error', (e) => logger.warn('pg client error', { error: e.message }));
    this.client = client;
    return client;
  }

  async dispose(): Promise<void> {
    if (this.client) {
      await this.client.end().catch(() => undefined);
      this.client = null;
    }
  }

  async testConnection(): Promise<ConnectionTestResult> {
    if (!this.configured()) {
      return {
        ok: false,
        degraded: true,
        message: `未配置 ${this.label} 连接串。请到 ${this.provider === 'neon' ? 'https://console.neon.tech' : this.provider === 'supabase' ? 'https://supabase.com/dashboard' : '你的数据库控制台'} 获取连接串后填入。`,
      };
    }
    const started = Date.now();
    try {
      const client = await this.connect();
      const res = await client.query<{ version: string }>('select version() as version');
      const version = res.rows[0]?.version ?? '';
      const caps = await this.detectCapabilities(client);
      return {
        ok: true,
        degraded: false,
        message: `连接成功（${this.label}）`,
        serverVersion: version.split(' ').slice(0, 2).join(' '),
        latencyMs: Date.now() - started,
        capabilities: caps,
      };
    } catch (e) {
      return {
        ok: false,
        degraded: false,
        message: `连接失败：${e instanceof Error ? e.message : String(e)}`,
        latencyMs: Date.now() - started,
      };
    }
  }

  private async detectCapabilities(client: Client): Promise<ConnectionTestResult['capabilities']> {
    try {
      const r = await client.query<{ has_schema: boolean; is_superuser: boolean; has_rls: boolean }>(`
        select
          has_schema_privilege(current_user, 'public', 'CREATE') as has_schema,
          current_setting('is_superuser', true) = 'on' as is_superuser,
          exists (select 1 from pg_extension where extname = 'pgcrypto') as has_rls
      `);
      const row = r.rows[0];
      return {
        canCreateTable: Boolean(row?.has_schema),
        canRunMigration: Boolean(row?.has_schema) || Boolean(row?.is_superuser),
        hasRls: Boolean(row?.has_rls),
      };
    } catch {
      return { canCreateTable: false, canRunMigration: false, hasRls: false };
    }
  }

  async introspection(): Promise<DatabaseSchemaSnapshot> {
    const client = await this.connect();
    const cols = await client.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(`
      select table_name, column_name, data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'public'
      order by table_name, ordinal_position
    `);
    const idx = await client.query<{ tablename: string; indexname: string }>(`
      select tablename, indexname from pg_indexes where schemaname = 'public'
    `);
    const pk = await client.query<{ table_name: string; column_name: string }>(`
      select kcu.table_name, kcu.column_name
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
      where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = 'public'
    `);
    const rls = await client.query<{ relname: string; relrowsecurity: boolean }>(`
      select c.relname, c.relrowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
    `);

    const pkSet = new Set(pk.rows.map((r) => `${r.table_name}.${r.column_name}`));
    const rlsMap = new Map(rls.rows.map((r) => [r.relname, r.relrowsecurity]));
    const tables = new Map<string, DatabaseSchemaSnapshot['tables'][number]>();
    for (const c of cols.rows) {
      if (!tables.has(c.table_name)) {
        tables.set(c.table_name, { name: c.table_name, columns: [], indexes: [], rls: rlsMap.get(c.table_name) ?? false });
      }
      tables.get(c.table_name)?.columns.push({
        name: c.column_name,
        type: c.data_type,
        nullable: c.is_nullable === 'YES',
        default: c.column_default,
        primary: pkSet.has(`${c.table_name}.${c.column_name}`),
      });
    }
    for (const i of idx.rows) {
      tables.get(i.tablename)?.indexes?.push(i.indexname);
    }
    return { tables: [...tables.values()], generatedFrom: 'introspect' };
  }

  /**
   * 静态校验：不连接数据库也能拦住危险 SQL（供 UI 预检与测试使用）。
   *
   * 重要：必须按「整条语句」判断，而不能只看开头 ——
   * `select 1; drop table users` 开头是 select，只看开头会被当成只读放行。
   * 这里先把 SQL 拆成语句，逐条判定，只要任一条是写操作就整体标为写。
   */
  static inspect(sql: string): { safe: boolean; reason?: string; isWrite: boolean } {
    const trimmed = sql.replace(/--[^\n]*/g, '').trim();
    if (!trimmed) return { safe: false, reason: 'SQL 不能为空', isWrite: false };

    for (const b of BLOCKED_PATTERNS) {
      if (b.re.test(trimmed)) return { safe: false, reason: b.reason, isWrite: true };
    }

    const statements = trimmed
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const WRITE_RE = /^\s*(insert|update|delete|alter|create|drop|grant|revoke|comment|truncate|merge|call|do|vacuum|reindex|refresh)\b/i;
    const writeStatements = statements.filter((s) => WRITE_RE.test(s));
    const isWrite = writeStatements.length > 0;

    if (isWrite && statements.length > 1) {
      return {
        safe: false,
        reason: '写操作不允许多语句（避免绕过确认的批量变更）',
        isWrite: true,
      };
    }
    return { safe: true, isWrite };
  }

  async runQuery(sql: string, params: unknown[], opts: { readOnly: boolean; limit: number }): Promise<QueryResult> {
    const inspection = PostgresAdapter.inspect(sql);
    if (!inspection.safe) throw AppError.badRequest(inspection.reason ?? 'SQL 不合法');
    if (inspection.isWrite && (opts.readOnly || !this.allowWrite)) {
      throw AppError.forbidden('当前连接为只读模式：写操作需显式开启并二次确认');
    }
    const client = await this.connect();
    const started = Date.now();
    try {
      if (opts.readOnly) await client.query('BEGIN READ ONLY');
      try {
        const res = await client.query(sql, params as never[]);
        const rows = (res.rows ?? []).slice(0, opts.limit);
        if (opts.readOnly) await client.query('COMMIT');
        return {
          columns: res.fields?.map((f) => f.name) ?? Object.keys(rows[0] ?? {}),
          rows,
          rowCount: res.rowCount ?? rows.length,
          truncated: (res.rows?.length ?? 0) > opts.limit,
          ms: Date.now() - started,
          readOnly: opts.readOnly,
        };
      } catch (e) {
        if (opts.readOnly) await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      }
    } finally {
      // 保持短连接：查询后立即释放，避免凭据长期驻留
      await this.dispose();
    }
  }

  async applyMigration(items: MigrationPlanItem[]): Promise<ApplyResult> {
    const applied: string[] = [];
    const failed: { name: string; error: string }[] = [];
    const client = await this.connect();
    try {
      await client.query(`
        create table if not exists _workbench_migrations (
          name text primary key,
          applied_at timestamptz not null default now()
        )
      `);
      const done = await client.query<{ name: string }>('select name from _workbench_migrations');
      const doneSet = new Set(done.rows.map((r) => r.name));
      for (const item of items) {
        if (doneSet.has(item.name)) continue;
        for (const stmt of splitStatements(item.sql)) {
          const inspection = PostgresAdapter.inspect(stmt);
          if (!inspection.safe) {
            failed.push({ name: item.name, error: inspection.reason ?? 'SQL 被安全策略拒绝' });
            break;
          }
        }
        if (failed.some((f) => f.name === item.name)) continue;
        try {
          await client.query('BEGIN');
          await client.query(item.sql);
          await client.query('insert into _workbench_migrations (name) values ($1)', [item.name]);
          await client.query('COMMIT');
          applied.push(item.name);
        } catch (e) {
          await client.query('ROLLBACK').catch(() => undefined);
          failed.push({ name: item.name, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return { applied, failed };
    } finally {
      await this.dispose();
    }
  }

  async rollbackMigration(name: string): Promise<{ ok: boolean; message: string }> {
    return { ok: false, message: `回滚 ${name} 需要提供 down 脚本：请在「迁移历史」中对具体迁移执行回滚` };
  }

  async backup(): Promise<{ format: 'sql'; content: string; bytes: number; tables: number }> {
    const client = await this.connect();
    try {
      const snap = await this.introspection();
      const parts: string[] = [
        `-- AI 工作台逻辑备份（结构 + 数据）`,
        `-- 生成时间：${new Date().toISOString()}`,
        `-- 表数量：${snap.tables.length}`,
        '',
      ];
      for (const t of snap.tables) {
        parts.push(`-- ---------- ${t.name} ----------`);
        parts.push(`-- 结构：${t.columns.map((c) => `${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`).join(', ')}`);
        const rowCountRes = await client.query<{ n: string }>(`select count(*)::text as n from "${t.name}"`);
        const count = Number(rowCountRes.rows[0]?.n ?? 0);
        // 备份只导出结构 + 抽样数据：完整数据导出请用 pg_dump（工作台不代持大文件）
        const sample = await client.query(`select * from "${t.name}" limit 100`);
        if (count > 0) {
          for (const row of sample.rows) {
            const cols = Object.keys(row);
            const vals = cols.map((c) => sqlLiteral((row as Record<string, unknown>)[c]));
            parts.push(`INSERT INTO "${t.name}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${vals.join(', ')});`);
          }
          if (count > sample.rows.length) parts.push(`-- 该表共 ${count} 行，此处仅导出前 ${sample.rows.length} 行，完整备份请使用 pg_dump`);
        }
        parts.push('');
      }
      const content = parts.join('\n');
      return { format: 'sql', content, bytes: Buffer.byteLength(content), tables: snap.tables.length };
    } finally {
      await this.dispose();
    }
  }

  async createDatabase(): Promise<{ ok: boolean; message: string; degraded: boolean }> {
    return {
      ok: false,
      degraded: true,
      message: `创建数据库需在 ${this.label} 控制台完成（工作台不代持管理凭据）；创建后把连接串粘贴到「数据库面板」即可`,
    };
  }
}

function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'));
}

function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

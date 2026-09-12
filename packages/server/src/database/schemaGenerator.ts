import type { DatabaseSchemaSnapshot, WebsitePlan } from '@ai/shared';
import { AppError } from '../utils/errors.ts';

/**
 * Schema 生成器（Step 2）。
 *
 * 输入：网站需求解析结果（WebsitePlan.entities）
 * 输出：
 *   - DatabaseSchemaSnapshot（给 UI 展示 + 落库快照）
 *   - Postgres DDL（用于迁移执行器）
 *   - down DDL（回滚）
 *
 * 设计原则：
 *   - 纯函数、无 IO → 可单测、无凭据也能生成；
 *   - 主键统一 uuid + gen_random_uuid()（Neon / Supabase 都内置 pgcrypto）；
 *   - 时间列统一 timestamptz（跨时区安全，避免 timestamp 的隐式时区坑）。
 */

const TYPE_MAP: Record<string, string> = {
  uuid: 'uuid',
  text: 'text',
  string: 'text',
  varchar: 'text',
  integer: 'integer',
  int: 'integer',
  bigint: 'bigint',
  numeric: 'numeric(14,2)',
  decimal: 'numeric(14,2)',
  real: 'real',
  double: 'double precision',
  boolean: 'boolean',
  bool: 'boolean',
  timestamptz: 'timestamptz',
  datetime: 'timestamptz',
  timestamp: 'timestamptz',
  date: 'date',
  json: 'jsonb',
  jsonb: 'jsonb',
};

export function mapType(input: string): string {
  const key = input.trim().toLowerCase();
  const mapped = TYPE_MAP[key];
  if (!mapped) throw AppError.badRequest(`不支持的列类型: ${input}（支持：${Object.keys(TYPE_MAP).join(', ')}）`);
  return mapped;
}

export function generateSchema(plan: WebsitePlan, opts: { withRls?: boolean } = {}): { snapshot: DatabaseSchemaSnapshot; up: string; down: string } {
  if (!plan.entities || plan.entities.length === 0) {
    return {
      snapshot: { tables: [], generatedFrom: 'requirement', note: '该需求不含数据实体，无需数据库' },
      up: '-- 无需数据库变更\n',
      down: '-- 无需回滚\n',
    };
  }

  const up: string[] = [
    '-- 由 AI 工作台根据需求生成的 Schema',
    `-- 生成时间：${new Date().toISOString()}`,
    '-- 幂等：全部 IF NOT EXISTS，可重复执行',
    '',
    'create extension if not exists "pgcrypto";',
    '',
  ];
  const snapshot: DatabaseSchemaSnapshot = { tables: [], generatedFrom: 'requirement' };
  const created: string[] = [];

  for (const entity of plan.entities) {
    const table = entity.name;
    const cols: string[] = [];
    for (const c of entity.columns) {
      const type = mapType(c.type);
      const parts = [`  "${c.name}" ${type}`];
      if (c.primary) parts.push('primary key default gen_random_uuid()');
      else if (!c.nullable) parts.push('not null');
      if (!c.primary && c.name.endsWith('_at') && !c.nullable) parts.push('default now()');
      cols.push(parts.join(' '));
    }
    // 外键（many-to-one）
    for (const rel of entity.relations ?? []) {
      if (rel.type !== 'many-to-one') continue;
      const localCol = `${rel.to.replace(/s$/, '')}_id`;
      const refEntity = plan.entities.find((e) => e.name === rel.to);
      const refPk = refEntity?.columns.find((c) => c.primary)?.name ?? 'id';
      if (!entity.columns.some((c) => c.name === localCol)) {
        cols.push(`  "${localCol}" uuid references "${rel.to}"("${refPk}") on delete cascade`);
      }
    }
    up.push(`create table if not exists "${table}" (\n${cols.join(',\n')}\n);`);
    up.push(`create index if not exists "${table}_created_idx" on "${table}" ((created_at)) ;`.replace(' ((created_at))', ' ("created_at")'));
    if (opts.withRls) {
      up.push(`alter table "${table}" enable row level security;`);
      up.push(`drop policy if exists "${table}_service_all" on "${table}";`);
      up.push(`create policy "${table}_service_all" on "${table}" for all to service_role using (true) with check (true);`);
    }
    up.push('');
    created.push(table);
    snapshot.tables.push({
      name: table,
      columns: entity.columns.map((c) => ({ name: c.name, type: mapType(c.type), nullable: c.nullable, primary: c.primary ?? false })),
      indexes: [`${table}_created_idx`],
      rls: Boolean(opts.withRls),
    });
  }

  const down = ['-- 回滚：按依赖倒序删除', ...[...created].reverse().map((t) => `drop table if exists "${t}" cascade;`), ''].join('\n');
  return { snapshot, up: up.join('\n'), down };
}

/** 生成迁移名：可读且有序 */
export function migrationName(index: number, label: string): string {
  const safe = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return `${String(index).padStart(4, '0')}_${safe || 'init'}`;
}

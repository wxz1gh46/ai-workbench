import type { DatabaseProvider, DatabaseSchemaSnapshot, QueryResult } from '@ai/shared';

/**
 * 数据库适配器接口（Step 2）。
 *
 * 设计要点：
 *   1. 统一 DbAdapter，Neon / Supabase / 普通 Postgres / 本地 SQLite 各自实现；
 *   2. 无凭据时必须能「离线工作」：
 *      - testConnection 返回结构化结果，不抛网络异常；
 *      - generateSchema / planMigration 等纯计算能力不依赖连接；
 *   3. 所有「写」操作必须声明 readOnly=false，由上层闸门与审计拦截。
 */

export interface DbTarget {
  provider: DatabaseProvider;
  /** 脱敏后的连接标识（用于显示与审计，绝不含密码） */
  label: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  /** 未配置凭据时为 true */
  degraded: boolean;
  serverVersion?: string;
  latencyMs?: number;
  /** 能力探测结果 */
  capabilities?: {
    canCreateTable: boolean;
    canRunMigration: boolean;
    hasRls: boolean;
  };
}

export interface MigrationPlanItem {
  name: string;
  sql: string;
  downSql: string;
}

export interface ApplyResult {
  applied: string[];
  failed: { name: string; error: string }[];
}

export interface DbAdapter {
  readonly provider: DatabaseProvider;
  readonly label: string;
  /** 连接串是否可用（凭据由用户手动配置） */
  configured(): boolean;
  testConnection(): Promise<ConnectionTestResult>;
  introspection(): Promise<DatabaseSchemaSnapshot>;
  runQuery(sql: string, params: unknown[], opts: { readOnly: boolean; limit: number }): Promise<QueryResult>;
  applyMigration(items: MigrationPlanItem[]): Promise<ApplyResult>;
  rollbackMigration(name: string): Promise<{ ok: boolean; message: string }>;
  backup(): Promise<{ format: 'sql'; content: string; bytes: number; tables: number }>;
  dispose(): Promise<void>;
}

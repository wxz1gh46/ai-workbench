import type { DatabaseProvider } from '@ai/shared';
import { AppError } from '../utils/errors.ts';
import type { DbAdapter } from './adapter.ts';
import { PostgresAdapter } from './postgresAdapter.ts';
import { NeonAdapter } from './neonAdapter.ts';
import { SupabaseAdapter } from './supabaseAdapter.ts';

/**
 * 适配器工厂。
 *
 * 注意 allowWrite 的默认值：false。
 * 「只读优先」是 Phase 3 的安全底线 —— 用户必须显式在查询控制台勾选
 * 「允许写操作」并二次确认，才可能执行 INSERT/UPDATE/DELETE。
 */
export function createAdapter(input: {
  provider: DatabaseProvider;
  connectionString: string | null;
  allowWrite?: boolean;
  branch?: string;
}): DbAdapter {
  switch (input.provider) {
    case 'neon':
      return new NeonAdapter(input.connectionString, { allowWrite: input.allowWrite, branch: input.branch });
    case 'supabase':
      return new SupabaseAdapter(input.connectionString, { allowWrite: input.allowWrite });
    case 'postgres':
      return new PostgresAdapter({
        provider: 'postgres',
        label: 'PostgreSQL',
        connectionString: input.connectionString,
        allowWrite: input.allowWrite,
      });
    case 'sqlite':
      return new PostgresAdapter({
        provider: 'sqlite',
        label: 'SQLite（不支持的远端类型：请使用本地工作区数据库）',
        connectionString: null,
        allowWrite: false,
      });
    default:
      throw AppError.badRequest(`不支持的数据库类型: ${String(input.provider)}`);
  }
}

export function supportedProviders(): { provider: DatabaseProvider; label: string; needs: string[]; docs: string }[] {
  return [
    {
      provider: 'neon',
      label: 'Neon',
      needs: ['DATABASE_URL（连接串，必填）', 'NEON_API_KEY（可选，用于列项目/分支）'],
      docs: 'https://console.neon.tech → Connection Details',
    },
    {
      provider: 'supabase',
      label: 'Supabase',
      needs: ['DATABASE_URL（Postgres 连接串，必填）', 'SUPABASE_ACCESS_TOKEN（可选，用于列项目）'],
      docs: 'https://supabase.com/dashboard → Project Settings → Database',
    },
    {
      provider: 'postgres',
      label: 'PostgreSQL（自建/其他云）',
      needs: ['DATABASE_URL'],
      docs: '你的数据库服务商控制台',
    },
  ];
}

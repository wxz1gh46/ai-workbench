import type { DatabaseProvider, DatabaseSchemaSnapshot } from '@ai/shared';
import { resolveProviderToken } from '../security/secrets.ts';
import { PostgresAdapter } from './postgresAdapter.ts';

/**
 * Supabase 适配器（Step 2）。
 *
 * 与 Neon 的差异：
 *   1. Supabase 提供 PostgREST（RESTful 数据 API）与 Realtime，本适配器仍走
 *      原生 Postgres 连接串（更通用，且能直接执行 DDL / 迁移）；
 *   2. RLS 是 Supabase 的核心安全模型：默认所有表都是「拒绝所有」，
 *      必须显式写 policy。因此 generateRlsPolicies() 是本适配器的关键能力；
 *   3. Supabase 有 service_role（绕过 RLS，绝不可下发到前端）与 anon
 *      （受 RLS 约束）两把钥匙 —— 工作台只在服务端使用 service_role。
 *
 * 安全：
 *   - SUPABASE_SERVICE_ROLE_KEY 只允许存放在环境变量/加密配置中，且审计只记录用途；
 *   - 生成的 RLS 策略一律「默认拒绝 + 显式放行」。
 */
export class SupabaseAdapter extends PostgresAdapter {
  override readonly provider: DatabaseProvider = 'supabase';

  constructor(connectionString: string | null, opts: { allowWrite?: boolean } = {}) {
    super({ provider: 'supabase', label: 'Supabase', connectionString, allowWrite: opts.allowWrite });
  }

  static hasApiToken(): boolean {
    return Boolean(resolveProviderToken('supabase'));
  }

  /**
   * 为表生成 RLS 策略 SQL。
   *
   * 默认策略（最小权限）：
   *   - 所有人（anon）只能 SELECT 标记为「公开读」的表；
   *   - 写操作只允许 authenticated 用户；
   *   - service_role 天然绕过 RLS（服务端专用，不下发前端）。
   */
  static generateRlsPolicies(tables: { name: string; publicRead?: boolean; ownerColumn?: string }[]): string {
    const out: string[] = [
      '-- 由 AI 工作台生成的 Supabase RLS 策略',
      '-- 原则：默认拒绝 + 显式放行；service_role 绕过 RLS（仅服务端持有）',
      '',
    ];
    for (const t of tables) {
      out.push(`alter table if exists public."${t.name}" enable row level security;`);
      if (t.publicRead) {
        out.push(`drop policy if exists "${t.name}_public_read" on public."${t.name}";`);
        out.push(`create policy "${t.name}_public_read" on public."${t.name}" for select using (true);`);
      }
      out.push(`drop policy if exists "${t.name}_auth_write" on public."${t.name}";`);
      out.push(
        `create policy "${t.name}_auth_write" on public."${t.name}" for all to authenticated using (true) with check (true);`,
      );
      out.push('');
    }
    return out.join('\n');
  }

  async introspectionWithRls(): Promise<DatabaseSchemaSnapshot> {
    return super.introspection();
  }

  /** Supabase 项目/表管理（需 SUPABASE_ACCESS_TOKEN，可选） */
  async listProjects(): Promise<{ ok: boolean; degraded: boolean; message: string; projects: { id: string; name: string; region: string }[] }> {
    const token = resolveProviderToken('supabase');
    if (!token) {
      return {
        ok: false,
        degraded: true,
        message: '未配置 SUPABASE_ACCESS_TOKEN：请到 https://supabase.com/dashboard/account/tokens 创建后用环境变量配置',
        projects: [],
      };
    }
    try {
      const res = await fetch('https://api.supabase.com/v1/projects', {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return { ok: false, degraded: false, message: `Supabase API 返回 HTTP ${res.status}`, projects: [] };
      const json = (await res.json()) as { id: string; name: string; region: string }[];
      return {
        ok: true,
        degraded: false,
        message: `找到 ${json.length} 个 Supabase 项目`,
        projects: json.map((p) => ({ id: p.id, name: p.name, region: p.region })),
      };
    } catch (e) {
      return { ok: false, degraded: false, message: `Supabase API 调用失败：${e instanceof Error ? e.message : String(e)}`, projects: [] };
    }
  }
}

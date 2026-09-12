import type { DatabaseProvider } from '@ai/shared';
import { resolveProviderToken } from '../security/secrets.ts';
import { PostgresAdapter } from './postgresAdapter.ts';

/**
 * Neon 适配器（Step 2）。
 *
 * 与 Supabase 的差异（这三点决定了它们的字段与权限模型不同）：
 *   1. Neon 是「纯 Postgres」，分支（branch）是它的一等公民：一个项目可以有
 *      main / dev / preview 多个分支，各分支独立连接串 → 工作台按 branch 管理；
 *   2. Neon 支持 Serverless 驱动（HTTP 查询），本地桌面端用普通 pg 即可；
 *   3. Neon 无内置 RLS 策略引擎，RLS 需要自己写 policy（Supabase 则是平台托管）。
 *
 * 凭据边界：
 *   - 连接串（DATABASE_URL）由用户从 Neon 控制台复制，加密存储；
 *   - NEON_API_KEY 仅用于「列项目 / 列分支」这类管理操作，可选；
 *   - 工作台不会代用户创建账号或申请 API Key。
 */
export class NeonAdapter extends PostgresAdapter {
  override readonly provider: DatabaseProvider = 'neon';

  constructor(connectionString: string | null, opts: { allowWrite?: boolean; branch?: string } = {}) {
    super({
      provider: 'neon',
      label: opts.branch ? `Neon (${opts.branch})` : 'Neon',
      connectionString,
      allowWrite: opts.allowWrite,
    });
    this.branch = opts.branch ?? 'main';
  }

  private readonly branch: string;

  static hasApiKey(): boolean {
    return Boolean(resolveProviderToken('neon'));
  }

  /** 需要 NEON_API_KEY 的管理能力（可选） */
  async listProjects(): Promise<{ ok: boolean; degraded: boolean; message: string; projects: { id: string; name: string; branches: string[] }[] }> {
    const key = resolveProviderToken('neon');
    if (!key) {
      return {
        ok: false,
        degraded: true,
        message: '未配置 NEON_API_KEY：无法通过 API 列项目，请到 https://console.neon.tech 手动复制连接串',
        projects: [],
      };
    }
    try {
      const res = await fetch('https://console.neon.tech/api/v2/projects', {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      });
      if (!res.ok) return { ok: false, degraded: false, message: `Neon API 返回 HTTP ${res.status}`, projects: [] };
      const json = (await res.json()) as { projects?: { id: string; name: string }[] };
      const projects: { id: string; name: string; branches: string[] }[] = [];
      for (const p of json.projects ?? []) {
        const br = await fetch(`https://console.neon.tech/api/v2/projects/${p.id}/branches`, {
          headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        });
        const brJson = br.ok ? ((await br.json()) as { branches?: { name?: string }[] }) : { branches: [] };
        projects.push({ id: p.id, name: p.name, branches: (brJson.branches ?? []).map((b) => b.name ?? '') });
      }
      return { ok: true, degraded: false, message: `找到 ${projects.length} 个 Neon 项目`, projects };
    } catch (e) {
      return { ok: false, degraded: false, message: `Neon API 调用失败：${e instanceof Error ? e.message : String(e)}`, projects: [] };
    }
  }

  branchName(): string {
    return this.branch;
  }
}

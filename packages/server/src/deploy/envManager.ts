import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { websiteProjects } from '../db/schema/index.ts';
import { AppError } from '../utils/errors.ts';
import { maskSecret, seal, unseal } from '../security/secrets.ts';
import { newId, nowIso } from '../utils/ids.ts';

/**
 * 环境变量管理（Step 3）。
 *
 * 存储设计：
 *   - 值一律 AES-256-GCM 加密后落库（key 为 workspace 级密钥）；
 *   - 变量名是明文（便于 UI 展示与冲突校验），但值永不返回给前端；
 *   - 注入部署时在内存中解密，且只把「变量名」写审计日志。
 *
 * 前端看到的形如：
 *   [{ key: 'DATABASE_URL', masked: '****nLcA', secretRef: 'envvar:xxx' }]
 */
export interface EnvVarRecord {
  key: string;
  /** 加密后的值 */
  encrypted: string;
  secretRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnvVarPublic {
  key: string;
  masked: string;
  secretRef: string;
  updatedAt: string;
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class EnvManager {
  constructor(private readonly db: Db) {}

  async list(websiteProjectId: string): Promise<{ public: EnvVarPublic[]; raw: EnvVarRecord[] }> {
    const rows = await this.db.select().from(websiteProjects).where(eq(websiteProjects.id, websiteProjectId)).limit(1);
    const project = rows[0];
    if (!project) throw AppError.notFound(`网站项目不存在: ${websiteProjectId}`);
    const stored = (project.plan as { envVars?: EnvVarRecord[] })?.envVars ?? [];
    const pub: EnvVarPublic[] = [];
    for (const item of stored) {
      let valuePreview = '';
      try {
        const v = unseal<string>(item.encrypted);
        valuePreview = typeof v === 'string' ? maskSecret(v) : '';
      } catch {
        valuePreview = '<解密失败：密钥可能已变更>';
      }
      pub.push({ key: item.key, masked: valuePreview, secretRef: item.secretRef, updatedAt: item.updatedAt });
    }
    return { public: pub, raw: stored };
  }

  /** 写入/覆盖一批变量。返回写入的变量名（不含值） */
  async set(websiteProjectId: string, vars: { key: string; value: string }[]): Promise<{ keys: string[]; replaced: string[] }> {
    const rows = await this.db.select().from(websiteProjects).where(eq(websiteProjects.id, websiteProjectId)).limit(1);
    const project = rows[0];
    if (!project) throw AppError.notFound(`网站项目不存在: ${websiteProjectId}`);

    for (const v of vars) {
      if (!KEY_RE.test(v.key)) throw AppError.badRequest(`环境变量名不合法（只允许字母/数字/下划线，且不以数字开头）: ${v.key}`);
      if (v.value.length > 8000) throw AppError.badRequest(`环境变量 ${v.key} 过长（上限 8000 字符）`);
    }

    const plan = (project.plan ?? {}) as Record<string, unknown>;
    const stored: EnvVarRecord[] = (plan.envVars as EnvVarRecord[]) ?? [];
    const replaced: string[] = [];
    const now = nowIso();
    for (const v of vars) {
      const idx = stored.findIndex((x) => x.key === v.key);
      const record: EnvVarRecord = {
        key: v.key,
        encrypted: seal(v.value),
        secretRef: `envvar:${newId('ev')}`,
        createdAt: idx >= 0 ? (stored[idx] as EnvVarRecord).createdAt : now,
        updatedAt: now,
      };
      if (idx >= 0) {
        replaced.push(v.key);
        stored[idx] = record;
      } else {
        stored.push(record);
      }
    }
    await this.db
      .update(websiteProjects)
      .set({ plan: { ...plan, envVars: stored } as never, updatedAt: now })
      .where(eq(websiteProjects.id, websiteProjectId));
    return { keys: vars.map((v) => v.key), replaced };
  }

  async remove(websiteProjectId: string, key: string): Promise<void> {
    const rows = await this.db.select().from(websiteProjects).where(eq(websiteProjects.id, websiteProjectId)).limit(1);
    const project = rows[0];
    if (!project) throw AppError.notFound(`网站项目不存在: ${websiteProjectId}`);
    const plan = (project.plan ?? {}) as Record<string, unknown>;
    const stored: EnvVarRecord[] = (plan.envVars as EnvVarRecord[]) ?? [];
    const next = stored.filter((x) => x.key !== key);
    await this.db
      .update(websiteProjects)
      .set({ plan: { ...plan, envVars: next } as never, updatedAt: nowIso() })
      .where(eq(websiteProjects.id, websiteProjectId));
  }

  /** 解密出用于注入部署的键值对（仅内存中短暂存在） */
  async resolveForDeploy(websiteProjectId: string): Promise<Record<string, string>> {
    const { raw } = await this.list(websiteProjectId);
    const out: Record<string, string> = {};
    for (const item of raw) {
      try {
        const v = unseal<string>(item.encrypted);
        if (typeof v === 'string') out[item.key] = v;
      } catch {
        // 单个变量解密失败不应阻断部署，但必须显式告警（由调用方日志体现）
      }
    }
    return out;
  }

  /** 供审计使用：只返回变量名 */
  async keys(websiteProjectId: string): Promise<string[]> {
    const { raw } = await this.list(websiteProjectId);
    return raw.map((r) => r.key);
  }
}

export async function findProject(db: Db, websiteProjectId: string) {
  const rows = await db
    .select()
    .from(websiteProjects)
    .where(and(eq(websiteProjects.id, websiteProjectId)))
    .limit(1);
  return rows[0] ?? null;
}

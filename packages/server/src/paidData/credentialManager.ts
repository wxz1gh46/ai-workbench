import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { paidDataCredentials } from '../db/schema/index.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';
import { maskSecret, seal, unseal } from '../security/secrets.ts';
import { findProvider, requiredCredentialKeys } from './providerRegistry.ts';

/**
 * 付费数据凭据管理（Phase 4 Step 2）。
 *
 * 安全设计（每一处都是刻意的）：
 *   - 落库只有密文（AES-256-GCM），字段名单独存，便于 UI 展示「已配置哪些字段」
 *   - 接口永不返回明文；只返回 fieldNames + status
 *   - 允许与已存凭据「合并更新」：只填一个字段时不会把其它字段清空
 *     （否则用户只想改 token，结果 appSecret 被清空 → 表现为「突然查不了了」）
 *   - 外部传入时不做任何日志回显（只记录 providerId 与字段名）
 */

export interface SaveCredentialsInput {
  workspaceId: string;
  providerId: string;
  credentials: Record<string, string>;
  /** true 时用新值整体替换；false（默认）时与已有值合并 */
  replace?: boolean;
}

export class CredentialManager {
  constructor(private readonly db: Db) {}

  async save(input: SaveCredentialsInput) {
    const spec = findProvider(input.providerId);
    if (!spec) throw AppError.notFound(`未知的付费数据源：${input.providerId}`);

    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.credentials ?? {})) {
      if (typeof v === 'string' && v.trim()) cleaned[k] = v.trim();
    }

    const existing = await this.getRow(input.workspaceId, input.providerId);
    let merged = cleaned;
    if (existing && !input.replace) {
      const prev = unseal<Record<string, string>>(existing.encryptedConfig) ?? {};
      merged = { ...prev, ...cleaned };
    }

    const known = new Set(spec.credentialFields.map((f) => f.key));
    const unknown = Object.keys(merged).filter((k) => !known.has(k));
    if (unknown.length > 0) {
      // 拒绝未知字段：避免用户把凭据写到「不会被使用」的字段上，还以为配置成功了
      throw AppError.badRequest(`${spec.name} 不支持以下凭据字段：${unknown.join(', ')}（可用：${[...known].join(', ')}）`);
    }

    const now = nowIso();
    const encrypted = seal(merged);
    const fieldNames = Object.keys(merged).sort();

    if (existing) {
      await this.db
        .update(paidDataCredentials)
        .set({ encryptedConfig: encrypted, fieldNames: fieldNames as never, status: 'configured', lastError: null, updatedAt: now } as never)
        .where(eq(paidDataCredentials.id, existing.id));
    } else {
      await this.db.insert(paidDataCredentials).values({
        id: newId('pdc'),
        workspaceId: input.workspaceId,
        providerId: input.providerId,
        encryptedConfig: encrypted,
        fieldNames: fieldNames as never,
        status: 'configured',
        lastVerifiedAt: null,
        lastError: null,
        createdAt: now,
        updatedAt: now,
      } as never);
    }
    logger.info('paid data credentials saved', { providerId: input.providerId, fields: fieldNames });

    return {
      providerId: input.providerId,
      status: 'configured' as const,
      fieldNames,
      requiredMissing: requiredCredentialKeys(input.providerId).filter((k) => !merged[k]),
      /** 仅用于「让用户确认填的是哪一串」，绝不返回明文 */
      masked: Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, maskSecret(v)])),
    };
  }

  /** 内部使用：解密后的凭据（只允许 QueryRunner / 连通性测试调用） */
  async resolve(workspaceId: string, providerId: string): Promise<Record<string, string>> {
    const row = await this.getRow(workspaceId, providerId);
    if (!row) return {};
    try {
      return unseal<Record<string, string>>(row.encryptedConfig) ?? {};
    } catch (e) {
      // 密钥变更导致解密失败：明确告知，而不是当成「没配置」
      logger.error('paid data credential decrypt failed', { providerId, error: e instanceof Error ? e.message : String(e) });
      throw AppError.internal(
        `${findProvider(providerId)?.name ?? providerId} 凭据解密失败（通常是 WORKBENCH_SECRET_KEY 变更）。请重新填写凭据。`,
      );
    }
  }

  async remove(workspaceId: string, providerId: string) {
    const row = await this.getRow(workspaceId, providerId);
    if (!row) throw AppError.notFound(`未配置凭据：${providerId}`);
    await this.db.delete(paidDataCredentials).where(eq(paidDataCredentials.id, row.id));
    return { removed: providerId };
  }

  async list(workspaceId: string) {
    const rows = (await this.db.select().from(paidDataCredentials).where(eq(paidDataCredentials.workspaceId, workspaceId))) as unknown as CredentialRow[];
    return rows.map((r) => ({
      providerId: r.providerId,
      status: r.status,
      fieldNames: (r.fieldNames ?? []) as string[],
      lastVerifiedAt: r.lastVerifiedAt,
      lastError: r.lastError,
      updatedAt: r.updatedAt,
    }));
  }

  async markVerified(workspaceId: string, providerId: string, ok: boolean, error?: string) {
    const now = nowIso();
    await this.db
      .update(paidDataCredentials)
      .set({ status: ok ? 'verified' : 'error', lastVerifiedAt: now, lastError: ok ? null : error ?? 'unknown', updatedAt: now } as never)
      .where(and(eq(paidDataCredentials.workspaceId, workspaceId), eq(paidDataCredentials.providerId, providerId)));
  }

  private async getRow(workspaceId: string, providerId: string) {
    const rows = (await this.db
      .select()
      .from(paidDataCredentials)
      .where(and(eq(paidDataCredentials.workspaceId, workspaceId), eq(paidDataCredentials.providerId, providerId)))) as unknown as CredentialRow[];
    return rows[0] ?? null;
  }
}

export type CredentialRow = typeof paidDataCredentials.$inferSelect;

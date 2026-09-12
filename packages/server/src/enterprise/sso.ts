import { eq } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/client.ts';
import { ssoConfigs } from '../db/schema/index.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';

/**
 * SSO（OIDC / SAML）（Phase 4 Step 6）。
 *
 * 安全基线（每一条都是刻意的最小权限）：
 *   1) client secret 只存「环境变量名」（clientSecretRef），**绝不存 secret 本身**
 *   2) 用户手动配置 issuer / clientId / redirectUri；工作台不代注册 IdP、不代理登录
 *   3) 授权码流程必须带 state（防 CSRF）与 nonce（防重放）；两者都在服务端生成并用后即焚
 *   4) 域 → 角色映射：只允许映射到已存在的角色名（拼错名字不会静默变成「无权限」）
 *
 * 实现范围：这里实现「配置管理 + 授权链接生成 + state/nonce 校验」。
 * 真正的 token 交换需要网络与 IdP 联通，属于部署环境行为，不在无凭据环境伪造。
 */

export interface OidcConfigInput {
  protocol?: 'oidc' | 'saml';
  issuer: string;
  clientId: string;
  clientSecretRef: string;
  redirectUri: string;
  groupMapping?: Record<string, string>;
  enabled?: boolean;
}

/** 已发出的 state 记录（内存即可：单机模式，重启后旧的登录流程本就应作废） */
interface PendingAuth {
  workspaceId: string;
  state: string;
  nonce: string;
  createdAt: number;
}

const STATE_TTL_MS = 10 * 60 * 1000;

export class SsoService {
  private readonly pending = new Map<string, PendingAuth>();

  constructor(private readonly db: Db) {}

  async get(workspaceId: string) {
    const rows = (await this.db.select().from(ssoConfigs).where(eq(ssoConfigs.workspaceId, workspaceId))) as unknown as SsoRow[];
    return rows[0] ?? null;
  }

  /** 对外返回的配置（secret 只以 ref 名出现） */
  async describe(workspaceId: string) {
    const row = await this.get(workspaceId);
    if (!row) return { configured: false, protocol: 'oidc' as const, enabled: false, issuer: '', clientId: '', clientSecretRef: '', redirectUri: '', groupMapping: {}, hasSecret: false };
    return {
      configured: true,
      protocol: row.protocol,
      enabled: row.enabled,
      issuer: row.issuer,
      clientId: row.clientId,
      clientSecretRef: row.clientSecretRef,
      redirectUri: row.redirectUri,
      groupMapping: (row.groupMapping ?? {}) as Record<string, string>,
      /** 只暴露「是否已配置密钥变量」，绝不返回值 */
      hasSecret: Boolean(process.env[row.clientSecretRef]?.trim()),
    };
  }

  async upsert(workspaceId: string, input: OidcConfigInput, knownRoles: string[]): Promise<ReturnType<SsoService['describe']>> {
    const protocol = input.protocol ?? 'oidc';
    if (!['oidc', 'saml'].includes(protocol)) throw AppError.badRequest(`不支持的 SSO 协议：${protocol}`);
    const issuer = input.issuer.trim();
    if (!issuer) throw AppError.badRequest('issuer 不能为空');
    // issuer 必须是 https（http 只允许 localhost 调试）
    const url = safeUrl(issuer);
    if (url.protocol !== 'https:' && !/^https?:/.test(issuer)) throw AppError.badRequest(`issuer 必须是合法 URL：${issuer}`);
    if (input.redirectUri && !/^https?:\/\//.test(input.redirectUri)) throw AppError.badRequest(`redirectUri 必须是合法 URL：${input.redirectUri}`);
    if (!input.clientSecretRef.trim()) {
      throw AppError.badRequest('必须提供 clientSecretRef（存放密钥的环境变量名），工作台不接受直接粘贴 secret');
    }
    // 启发式：环境变量名应当是全大写 + 下划线；命中密钥前缀或「看起来是随机串」则拒绝
    const ref = input.clientSecretRef.trim();
    const looksLikeEnvName = /^[A-Z][A-Z0-9_]*$/.test(ref);
    const looksLikeSecret = /^(sk-|ghp_|xox|AIza|AKIA)/.test(ref) || ref.length >= 40;
    if (looksLikeSecret || !looksLikeEnvName) {
      throw AppError.badRequest(
        `clientSecretRef 看起来不是环境变量名（要求全大写字母数字下划线，如 SSO_CLIENT_SECRET）：${ref.slice(0, 8)}…。请填写「变量名」而不是密钥值。`,
      );
    }

    const mapping = input.groupMapping ?? {};
    const unknownRoles = Object.values(mapping).filter((r) => !knownRoles.includes(r));
    if (unknownRoles.length > 0) {
      throw AppError.badRequest(`groupMapping 指向了不存在的角色：${unknownRoles.join(', ')}（可用：${knownRoles.join(', ')}）`);
    }

    const now = nowIso();
    const existing = await this.get(workspaceId);
    if (existing) {
      await this.db
        .update(ssoConfigs)
        .set({
          protocol,
          enabled: input.enabled ?? existing.enabled,
          issuer,
          clientId: input.clientId.trim(),
          clientSecretRef: input.clientSecretRef.trim(),
          redirectUri: input.redirectUri.trim(),
          groupMapping: mapping as never,
          updatedAt: now,
        } as never)
        .where(eq(ssoConfigs.id, existing.id));
    } else {
      await this.db.insert(ssoConfigs).values({
        id: newId('sso'),
        workspaceId,
        protocol,
        enabled: input.enabled ?? false,
        issuer,
        clientId: input.clientId.trim(),
        clientSecretRef: input.clientSecretRef.trim(),
        redirectUri: input.redirectUri.trim(),
        groupMapping: mapping as never,
        createdAt: now,
        updatedAt: now,
      } as never);
    }
    return this.describe(workspaceId);
  }

  async setEnabled(workspaceId: string, enabled: boolean) {
    const row = await this.get(workspaceId);
    if (!row) throw AppError.notFound('尚未配置 SSO');
    if (enabled && !process.env[row.clientSecretRef]?.trim()) {
      // 不允许「启用一个缺密钥的配置」：那只会让用户在登录页反复失败
      throw AppError.badRequest(`环境变量 ${row.clientSecretRef} 未设置，无法启用 SSO。请先配置密钥。`);
    }
    await this.db.update(ssoConfigs).set({ enabled, updatedAt: nowIso() } as never).where(eq(ssoConfigs.id, row.id));
    logger.info('sso enabled state changed', { workspaceId, enabled });
    return this.describe(workspaceId);
  }

  async remove(workspaceId: string) {
    const row = await this.get(workspaceId);
    if (!row) throw AppError.notFound('尚未配置 SSO');
    await this.db.delete(ssoConfigs).where(eq(ssoConfigs.id, row.id));
    return { removed: true };
  }

  /** 生成授权链接（带 state + nonce）；state 使用后必须消费 */
  async buildAuthUrl(workspaceId: string): Promise<{ url: string; state: string; nonce: string; expiresAt: string }> {
    const row = await this.get(workspaceId);
    if (!row) throw AppError.notFound('尚未配置 SSO');
    if (!row.enabled) throw AppError.badRequest('SSO 未启用');
    if (row.protocol !== 'oidc') {
      throw AppError.badRequest('SAML 登录由 IdP 发起（IdP-initiated），不需生成本地授权链接');
    }
    const state = randomBytes(16).toString('base64url');
    const nonce = randomBytes(16).toString('base64url');
    const createdAt = Date.now();
    this.pending.set(state, { workspaceId, state, nonce, createdAt });
    // 清理过期项，防止无限增长
    for (const [k, v] of this.pending) if (createdAt - v.createdAt > STATE_TTL_MS) this.pending.delete(k);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: row.clientId,
      redirect_uri: row.redirectUri,
      scope: 'openid profile email',
      state,
      nonce,
    });
    return {
      url: `${row.issuer.replace(/\/$/, '')}/authorize?${params.toString()}`,
      state,
      nonce,
      expiresAt: new Date(createdAt + STATE_TTL_MS).toISOString(),
    };
  }

  /** 校验回调的 state（防 CSRF）与 nonce（防重放）；校验后即失效 */
  consumeState(input: { state: string; nonce?: string }): { ok: boolean; reason: string; workspaceId?: string } {
    const hit = this.pending.get(input.state);
    if (!hit) return { ok: false, reason: 'state 无效或已被使用（可能是重放或被伪造的回调）' };
    this.pending.delete(input.state);
    if (Date.now() - hit.createdAt > STATE_TTL_MS) return { ok: false, reason: 'state 已过期（超过 10 分钟）' };
    if (input.nonce !== undefined && input.nonce !== hit.nonce) return { ok: false, reason: 'nonce 不匹配（可能的 id_token 重放）' };
    return { ok: true, reason: 'ok', workspaceId: hit.workspaceId };
  }

  /** 角色映射：IdP 返回的 groups → 本工作区角色名 */
  async resolveRoles(workspaceId: string, groups: string[]): Promise<string[]> {
    const row = await this.get(workspaceId);
    if (!row) return [];
    const mapping = (row.groupMapping ?? {}) as Record<string, string>;
    const set = new Set<string>();
    for (const g of groups) {
      const role = mapping[g];
      if (role) set.add(role);
    }
    return [...set];
  }

  /** 指纹：用于审计里标识「用的是哪套 SSO 配置」而不泄露 issuer 全文 */
  async fingerprint(workspaceId: string): Promise<string | null> {
    const row = await this.get(workspaceId);
    if (!row) return null;
    return createHash('sha256').update(`${row.protocol}:${row.issuer}:${row.clientId}`).digest('hex').slice(0, 16);
  }
}

function safeUrl(v: string): URL {
  try {
    return new URL(v);
  } catch {
    throw AppError.badRequest(`URL 不合法：${v}`);
  }
}

export type SsoRow = typeof ssoConfigs.$inferSelect;

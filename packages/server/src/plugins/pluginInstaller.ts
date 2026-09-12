import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { pluginGrants, pluginInstallations, pluginPermissions, pluginVersions, plugins } from '../db/schema/index.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';
import { findManifest, PLUGIN_MARKET } from './pluginMarket.ts';
import { assertCompliant, hashManifest, verifySignature, type PluginManifest } from './pluginManifest.ts';

/**
 * 插件安装器（Phase 4 Step 1）。
 *
 * 安装流程（每一步都可单独回滚）：
 *   1) 从市场取 manifest → 合规校验（assertCompliant）
 *   2) 签名校验（有 signature 时必须匹配；无签名标记为 unsigned，UI 上要显示）
 *   3) 写 plugins（既有表，保持 Phase 1 兼容）→ plugin_installations → plugin_versions
 *   4) 写 plugin_permissions（权限声明落库，等待用户逐项授权）
 *
 * 更新流程：比对 manifestHash，不一致则视为「内容已变更」，
 * 需要用户重新确认权限（不能静默把新权限当成默认同意 —— 这是权限提升漏洞）。
 */

export interface InstallResult {
  installationId: string;
  pluginId: string;
  name: string;
  version: string;
  signed: boolean;
  manifestHash: string;
  requiresUserAuth: boolean;
  permissions: { id: string; scope: string; description: string; sensitive: boolean; required: boolean }[];
  secretRefs: string[];
  /** 已授权的权限点（新装为空） */
  grantedScopes: string[];
}

export class PluginInstaller {
  constructor(private readonly db: Db) {}

  /** 市场浏览 / 搜索（不触库） */
  browse(input: { q?: string; kind?: string; requiresAuth?: boolean } = {}): PluginManifest[] {
    const q = (input.q ?? '').trim().toLowerCase();
    return PLUGIN_MARKET.filter((p) => {
      if (input.kind && p.kind !== input.kind) return false;
      if (input.requiresAuth !== undefined && p.requiresUserAuth !== input.requiresAuth) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.description.toLowerCase().includes(q) ||
        p.author.toLowerCase().includes(q) ||
        p.tools.some((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
      );
    });
  }

  detail(name: string) {
    const manifest = findManifest(name);
    if (!manifest) throw AppError.notFound(`插件市场中不存在: ${name}`);
    const sig = verifySignature(manifest);
    return { manifest, signature: sig, marketSize: PLUGIN_MARKET.length };
  }

  async install(workspaceId: string, name: string): Promise<InstallResult> {
    const manifest = findManifest(name);
    if (!manifest) throw AppError.notFound(`插件市场中不存在: ${name}`);
    assertCompliant(manifest);
    const sig = verifySignature(manifest);

    const now = nowIso();
    const manifestHash = sig.hash;

    // 1) 既有 plugins 表（Phase 1 兼容层）：name 唯一
    const existingPluginRows = (await this.db.select().from(plugins).where(eq(plugins.workspaceId, workspaceId))) as unknown as PluginRow[];
    let plugin = existingPluginRows.find((p) => p.name === manifest.name);
    if (!plugin) {
      plugin = {
        id: newId('plg'),
        workspaceId,
        name: manifest.name,
        version: manifest.version,
        kind: manifest.kind,
        source: manifest.source,
        status: 'installed',
        permissions: manifest.permissions.map((p) => ({ scope: p.scope, description: p.description, sensitive: p.sensitive })),
        requiresUserAuth: manifest.requiresUserAuth,
        secretRefs: manifest.secretRefs,
        sandbox: manifest.sandbox,
        config: manifest.config ?? {},
        createdAt: now,
        updatedAt: now,
      } as unknown as PluginRow;
      await this.db.insert(plugins).values(plugin as never);
    } else {
      await this.db
        .update(plugins)
        .set({ version: manifest.version, updatedAt: now, status: 'installed' } as never)
        .where(eq(plugins.id, plugin.id));
    }

    // 2) 安装记录（含 manifest 快照 + 哈希）
    const instRows = (await this.db.select().from(pluginInstallations).where(eq(pluginInstallations.pluginId, plugin.id))) as unknown as InstallationRow[];
    let installation = instRows[0];
    if (!installation) {
      installation = {
        id: newId('plgi'),
        workspaceId,
        pluginId: plugin.id,
        version: manifest.version,
        status: 'installed',
        manifest: manifest as unknown as Record<string, unknown>,
        manifestHash,
        installedAt: now,
        updatedAt: now,
      } as unknown as InstallationRow;
      await this.db.insert(pluginInstallations).values(installation as never);
    } else {
      // 已安装：比对哈希，内容变更则回到 installed（需要重新授权）
      const changed = installation.manifestHash !== manifestHash;
      await this.db
        .update(pluginInstallations)
        .set({
          version: manifest.version,
          manifest: manifest as unknown as Record<string, unknown>,
          manifestHash,
          status: changed ? 'installed' : installation.status,
          updatedAt: now,
        } as never)
        .where(eq(pluginInstallations.id, installation.id));
      if (changed) {
        // 权限提升保护：撤销全部授权，强制用户重新逐项确认
        await this.revokeAll(installation.id);
        logger.warn('plugin manifest changed; grants revoked for re-consent', { plugin: manifest.name });
      }
    }

    // 3) 版本记录
    const versionRows = (await this.db.select().from(pluginVersions).where(eq(pluginVersions.pluginId, plugin.id))) as unknown as VersionRow[];
    if (!versionRows.some((v) => v.version === manifest.version && v.hash === manifestHash)) {
      await this.db.insert(pluginVersions).values({
        id: newId('plgv'),
        pluginId: plugin.id,
        version: manifest.version,
        manifest: manifest as unknown as Record<string, unknown>,
        hash: manifestHash,
        releasedAt: now,
      } as never);
    }

    // 4) 权限声明
    const perms = await this.syncPermissions(plugin.id, manifest);
    const granted = await this.grantedScopes(installation.id);

    return {
      installationId: installation.id,
      pluginId: plugin.id,
      name: manifest.name,
      version: manifest.version,
      signed: sig.signed && sig.ok,
      manifestHash,
      requiresUserAuth: manifest.requiresUserAuth,
      permissions: perms,
      secretRefs: manifest.secretRefs,
      grantedScopes: granted,
    };
  }

  /** 卸载：级联删除安装记录 / 授权 / 版本 / 权限（plugins 行也删除，避免「幽灵插件」） */
  async uninstall(workspaceId: string, pluginId: string) {
    const rows = (await this.db.select().from(plugins).where(and(eq(plugins.workspaceId, workspaceId), eq(plugins.id, pluginId)))) as unknown as PluginRow[];
    const plugin = rows[0];
    if (!plugin) throw AppError.notFound(`插件未安装: ${pluginId}`);
    await this.db.delete(plugins).where(eq(plugins.id, pluginId));
    return { removed: pluginId, name: plugin.name };
  }

  /** 更新：重新走 install（内部会比对哈希并撤销旧授权） */
  async update(workspaceId: string, pluginId: string) {
    const rows = (await this.db.select().from(plugins).where(and(eq(plugins.workspaceId, workspaceId), eq(plugins.id, pluginId)))) as unknown as PluginRow[];
    const plugin = rows[0];
    if (!plugin) throw AppError.notFound(`插件未安装: ${pluginId}`);
    const manifest = findManifest(plugin.name);
    if (!manifest) throw AppError.notFound(`插件市场中已不存在: ${plugin.name}`);
    const latest = manifest.version;
    const result = await this.install(workspaceId, plugin.name);
    return { ...result, previousVersion: plugin.version, updated: plugin.version !== latest, latest };
  }

  async listInstalled(workspaceId: string) {
    const rows = (await this.db.select().from(pluginInstallations).where(eq(pluginInstallations.workspaceId, workspaceId))) as unknown as InstallationRow[];
    const pluginsRows = (await this.db.select().from(plugins).where(eq(plugins.workspaceId, workspaceId))) as unknown as PluginRow[];
    const out = [];
    for (const inst of rows) {
      const plugin = pluginsRows.find((p) => p.id === inst.pluginId);
      if (!plugin) continue;
      const perms = await this.permissions(plugin.id);
      const granted = await this.grantedScopes(inst.id);
      const manifest = findManifest(plugin.name);
      out.push({
        installationId: inst.id,
        pluginId: inst.pluginId,
        name: plugin.name,
        version: inst.version,
        status: inst.status,
        manifestHash: inst.manifestHash,
        installedAt: inst.installedAt,
        requiresUserAuth: plugin.requiresUserAuth,
        secretRefs: plugin.secretRefs,
        permissions: perms.map((p) => ({ ...p, granted: granted.includes(p.scope) })),
        grantedScopes: granted,
        latestVersion: manifest?.version ?? inst.version,
        updateAvailable: (manifest?.version ?? inst.version) !== inst.version,
        source: plugin.source,
        kind: plugin.kind,
      });
    }
    return out;
  }

  /* ------------------------------ 授权 ------------------------------ */

  async permissions(pluginId: string) {
    return (await this.db.select().from(pluginPermissions).where(eq(pluginPermissions.pluginId, pluginId))) as unknown as PermissionRow[];
  }

  async grantedScopes(installationId: string): Promise<string[]> {
    const grants = (await this.db.select().from(pluginGrants).where(eq(pluginGrants.installationId, installationId))) as unknown as GrantRow[];
    const active = grants.filter((g) => !g.revokedAt && (!g.expiresAt || g.expiresAt > nowIso()));
    if (active.length === 0) return [];
    const perms = (await this.db.select().from(pluginPermissions)) as unknown as PermissionRow[];
    return active.map((g) => perms.find((p) => p.id === g.permissionId)?.scope ?? '').filter(Boolean);
  }

  /** 逐项授权（可设过期时间）；未声明的权限点直接拒绝 */
  async grant(input: {
    workspaceId: string;
    installationId: string;
    scopes: string[];
    grantedBy?: string;
    expiresAt?: string | null;
  }) {
    const instRows = (await this.db.select().from(pluginInstallations).where(and(eq(pluginInstallations.workspaceId, input.workspaceId), eq(pluginInstallations.id, input.installationId)))) as unknown as InstallationRow[];
    const inst = instRows[0];
    if (!inst) throw AppError.notFound(`安装记录不存在: ${input.installationId}`);
    const perms = await this.permissions(inst.pluginId);
    const byScope = new Map(perms.map((p) => [p.scope, p]));

    const unknown = input.scopes.filter((s) => !byScope.has(s));
    if (unknown.length > 0) {
      // 拒绝未声明权限：否则等于「随便传个 scope 就能拿到权限」
      throw AppError.badRequest(`插件未声明以下权限，不能授权：${unknown.join(', ')}`);
    }

    const now = nowIso();
    const granted: string[] = [];
    for (const scope of input.scopes) {
      const perm = byScope.get(scope)!;
      const existing = (await this.db
        .select()
        .from(pluginGrants)
        .where(and(eq(pluginGrants.installationId, inst.id), eq(pluginGrants.permissionId, perm.id)))) as unknown as GrantRow[];
      const prev = existing[0];
      if (prev) {
        await this.db
          .update(pluginGrants)
          .set({ grantedAt: now, grantedBy: input.grantedBy ?? 'user', expiresAt: input.expiresAt ?? null, revokedAt: null } as never)
          .where(eq(pluginGrants.id, prev.id));
      } else {
        await this.db.insert(pluginGrants).values({
          id: newId('plgg'),
          installationId: inst.id,
          permissionId: perm.id,
          grantedAt: now,
          grantedBy: input.grantedBy ?? 'user',
          expiresAt: input.expiresAt ?? null,
          revokedAt: null,
        } as never);
      }
      granted.push(scope);
    }
    return { granted, grantedScopes: await this.grantedScopes(inst.id) };
  }

  /** 撤销授权（支持按 scope 撤销；不传则全撤） */
  async revoke(input: { workspaceId: string; installationId: string; scopes?: string[] }) {
    const instRows = (await this.db.select().from(pluginInstallations).where(and(eq(pluginInstallations.workspaceId, input.workspaceId), eq(pluginInstallations.id, input.installationId)))) as unknown as InstallationRow[];
    const inst = instRows[0];
    if (!inst) throw AppError.notFound(`安装记录不存在: ${input.installationId}`);
    const perms = await this.permissions(inst.pluginId);
    const targets = perms.filter((p) => !input.scopes || input.scopes.includes(p.scope));
    for (const perm of targets) {
      await this.db
        .update(pluginGrants)
        .set({ revokedAt: nowIso() } as never)
        .where(and(eq(pluginGrants.installationId, inst.id), eq(pluginGrants.permissionId, perm.id)));
    }
    return { revoked: targets.map((t) => t.scope), grantedScopes: await this.grantedScopes(inst.id) };
  }

  private async revokeAll(installationId: string) {
    await this.db.update(pluginGrants).set({ revokedAt: nowIso() } as never).where(eq(pluginGrants.installationId, installationId));
  }

  /** 把 manifest 权限声明同步到 plugin_permissions（幂等） */
  private async syncPermissions(pluginId: string, manifest: PluginManifest) {
    const now = await this.permissions(pluginId);
    const byScope = new Map(now.map((p) => [p.scope, p]));
    for (const decl of manifest.permissions) {
      const prev = byScope.get(decl.scope);
      if (prev) {
        await this.db
          .update(pluginPermissions)
          .set({ description: decl.description, required: decl.required ?? true } as never)
          .where(eq(pluginPermissions.id, prev.id));
      } else {
        await this.db.insert(pluginPermissions).values({
          id: newId('plgp'),
          pluginId,
          scope: decl.scope,
          description: decl.description,
          required: decl.required ?? true,
        } as never);
      }
    }
    const rows = await this.permissions(pluginId);
    // 返回时带上 sensitive（由 manifest 决定，不落库以免与市场定义不一致）
    return rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      description: r.description,
      sensitive: manifest.permissions.find((p) => p.scope === r.scope)?.sensitive ?? false,
      required: r.required,
    }));
  }
}

export type PluginRow = typeof plugins.$inferSelect;
export type InstallationRow = typeof pluginInstallations.$inferSelect;
export type PermissionRow = typeof pluginPermissions.$inferSelect;
export type GrantRow = typeof pluginGrants.$inferSelect;
export type VersionRow = typeof pluginVersions.$inferSelect;
export { hashManifest };

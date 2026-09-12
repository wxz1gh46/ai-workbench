import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { roles, userRoles } from '../db/schema/index.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';

/**
 * RBAC（Phase 4 Step 6）。
 *
 * 权限模型：角色 = 一组权限点（字符串），用户可多角色（权限取并集）。
 *
 * 设计要点：
 *   - 权限点用「资源:动作」命名（plugin:install / paid_data:query），便于扩展与审计
 *   - 内置角色不可删除（否则用户可能把自己锁死，导致工作台无法使用）
 *   - **owner 拥有全部权限**：任何情况下不能出现「谁都无权操作」的死锁状态
 *   - 校验失败抛 403 并明确指出缺哪个权限（不是笼统的「无权限」）
 */

export const PERMISSIONS = {
  'workspace:read': '查看工作区',
  'workspace:write': '修改工作区设置',
  'goal:run': '创建并推进目标',
  'agent:orchestrate': '多 Agent 编排',
  'cluster:manage': '管理集群节点与策略',
  'plugin:read': '浏览插件市场',
  'plugin:install': '安装插件',
  'plugin:grant': '授权插件权限',
  'paid_data:read': '查看付费数据源',
  'paid_data:configure': '配置付费数据源凭据',
  'paid_data:query': '查询付费数据',
  'prompt:read': '查看提示词模板',
  'prompt:write': '创建与编辑提示词',
  'audit:read': '查看审计日志',
  'audit:export': '导出审计日志',
  'compliance:manage': '管理脱敏与保留策略',
  'rbac:manage': '管理角色与权限',
  'sso:manage': '管理 SSO 配置',
  'deploy:run': '部署网站',
  'database:write': '执行数据库写操作',
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export interface BuiltinRole {
  name: string;
  permissions: Permission[];
  description: string;
}

/** 内置角色：owner / admin / operator / member / viewer / auditor */
export const BUILTIN_ROLES: BuiltinRole[] = [
  { name: 'owner', permissions: ALL_PERMISSIONS, description: '拥有全部权限（不可删除，保证系统可用）' },
  {
    name: 'admin',
    permissions: ALL_PERMISSIONS.filter((p) => p !== 'rbac:manage' && p !== 'sso:manage'),
    description: '日常管理（不含角色与 SSO 配置）',
  },
  {
    name: 'operator',
    permissions: ['workspace:read', 'goal:run', 'agent:orchestrate', 'cluster:manage', 'plugin:read', 'paid_data:read', 'paid_data:query', 'prompt:read', 'deploy:run'],
    description: '执行类角色：跑目标、管集群、查数据、发部署',
  },
  {
    name: 'member',
    permissions: ['workspace:read', 'goal:run', 'plugin:read', 'paid_data:read', 'prompt:read', 'prompt:write'],
    description: '普通成员：可跑目标与写提示词，不能碰凭据与集群',
  },
  { name: 'viewer', permissions: ['workspace:read', 'plugin:read', 'paid_data:read', 'prompt:read', 'audit:read'], description: '只读' },
  { name: 'auditor', permissions: ['workspace:read', 'audit:read', 'audit:export', 'compliance:manage'], description: '合规审计：可读审计与导出，不参与业务' },
];

export function isPermission(p: string): p is Permission {
  return p in PERMISSIONS;
}

export class RbacService {
  constructor(private readonly db: Db) {}

  /** 幂等初始化内置角色（启动时调用） */
  async ensureBuiltinRoles(workspaceId: string) {
    const now = nowIso();
    const existing = await this.listRoles(workspaceId);
    for (const def of BUILTIN_ROLES) {
      const found = existing.find((r) => r.name === def.name);
      if (found) {
        // 内置角色的权限随版本升级自动同步（否则新权限永远拿不到）
        if (found.permissions.length !== def.permissions.length) {
          await this.db.update(roles).set({ permissions: def.permissions as never, updatedAt: now } as never).where(eq(roles.id, found.id));
        }
        continue;
      }
      await this.db.insert(roles).values({
        id: newId('role'),
        workspaceId,
        name: def.name,
        permissions: def.permissions as never,
        builtin: true,
        createdAt: now,
        updatedAt: now,
      } as never);
    }
    return this.listRoles(workspaceId);
  }

  async listRoles(workspaceId: string) {
    return (await this.db.select().from(roles).where(eq(roles.workspaceId, workspaceId))) as unknown as RoleRow[];
  }

  async createRole(input: { workspaceId: string; name: string; permissions: string[] }) {
    const name = input.name.trim();
    if (!name) throw AppError.badRequest('角色名不能为空');
    if (/^(owner|admin|operator|member|viewer|auditor)$/i.test(name)) {
      throw AppError.conflict(`不能创建与内置角色同名的角色：${name}`);
    }
    const invalid = input.permissions.filter((p) => !isPermission(p));
    if (invalid.length > 0) throw AppError.badRequest(`存在未知权限点：${invalid.join(', ')}`);
    const existing = await this.listRoles(input.workspaceId);
    if (existing.some((r) => r.name === name)) throw AppError.conflict(`角色已存在：${name}`);
    const now = nowIso();
    const row = { id: newId('role'), workspaceId: input.workspaceId, name, permissions: input.permissions as never, builtin: false, createdAt: now, updatedAt: now };
    await this.db.insert(roles).values(row as never);
    return row as unknown as RoleRow;
  }

  async updateRole(workspaceId: string, nameOrId: string, permissions: string[]) {
    const role = await this.getRole(workspaceId, nameOrId);
    if (role.builtin && role.name === 'owner') {
      throw AppError.forbidden('owner 角色的权限不可修改（必须保留全部权限，否则系统可能被锁死）');
    }
    const invalid = permissions.filter((p) => !isPermission(p));
    if (invalid.length > 0) throw AppError.badRequest(`存在未知权限点：${invalid.join(', ')}`);
    await this.db.update(roles).set({ permissions: permissions as never, updatedAt: nowIso() } as never).where(eq(roles.id, role.id));
    return this.getRole(workspaceId, role.id);
  }

  async deleteRole(workspaceId: string, nameOrId: string) {
    const role = await this.getRole(workspaceId, nameOrId);
    if (role.builtin) throw AppError.forbidden(`内置角色不可删除：${role.name}`);
    const assigned = (await this.db.select().from(userRoles).where(eq(userRoles.roleId, role.id))) as unknown as UserRoleRow[];
    if (assigned.length > 0) throw AppError.conflict(`该角色仍被 ${assigned.length} 个用户使用，请先解除分配`);
    await this.db.delete(roles).where(eq(roles.id, role.id));
    return { removed: role.id, name: role.name };
  }

  async getRole(workspaceId: string, nameOrId: string): Promise<RoleRow> {
    const list = await this.listRoles(workspaceId);
    const role = list.find((r) => r.id === nameOrId || r.name === nameOrId);
    if (!role) throw AppError.notFound(`角色不存在: ${nameOrId}`);
    return role;
  }

  /** 分配角色（幂等） */
  async assign(input: { workspaceId: string; userId: string; roleNameOrId: string }) {
    const role = await this.getRole(input.workspaceId, input.roleNameOrId);
    const existing = (await this.db.select().from(userRoles).where(and(eq(userRoles.workspaceId, input.workspaceId), eq(userRoles.userId, input.userId)))) as unknown as UserRoleRow[];
    if (existing.some((u) => u.roleId === role.id)) {
      return { assigned: false, role: role.name, userId: input.userId, permissions: await this.permissionsOf(input.workspaceId, input.userId) };
    }
    await this.db.insert(userRoles).values({
      id: newId('urole'),
      userId: input.userId,
      roleId: role.id,
      workspaceId: input.workspaceId,
      createdAt: nowIso(),
    } as never);
    logger.info('rbac role assigned', { workspaceId: input.workspaceId, userId: input.userId, role: role.name });
    return { assigned: true, role: role.name, userId: input.userId, permissions: await this.permissionsOf(input.workspaceId, input.userId) };
  }

  async unassign(input: { workspaceId: string; userId: string; roleNameOrId: string }) {
    const role = await this.getRole(input.workspaceId, input.roleNameOrId);
    await this.db.delete(userRoles).where(and(eq(userRoles.workspaceId, input.workspaceId), eq(userRoles.userId, input.userId), eq(userRoles.roleId, role.id)));
    return { unassigned: true, role: role.name, userId: input.userId, permissions: await this.permissionsOf(input.workspaceId, input.userId) };
  }

  async listUserRoles(workspaceId: string) {
    const assignments = (await this.db.select().from(userRoles).where(eq(userRoles.workspaceId, workspaceId))) as unknown as UserRoleRow[];
    const allRoles = await this.listRoles(workspaceId);
    const byUser = new Map<string, { userId: string; roles: string[]; permissions: string[] }>();
    for (const a of assignments) {
      const role = allRoles.find((r) => r.id === a.roleId);
      if (!role) continue;
      const entry = byUser.get(a.userId) ?? { userId: a.userId, roles: [], permissions: [] };
      entry.roles.push(role.name);
      entry.permissions = [...new Set([...entry.permissions, ...(role.permissions as string[])])];
      byUser.set(a.userId, entry);
    }
    return [...byUser.values()];
  }

  /** 某用户的权限并集；无任何角色时返回空（调用方决定是否兜底给 owner） */
  async permissionsOf(workspaceId: string, userId: string): Promise<string[]> {
    const assignments = (await this.db.select().from(userRoles).where(and(eq(userRoles.workspaceId, workspaceId), eq(userRoles.userId, userId)))) as unknown as UserRoleRow[];
    if (assignments.length === 0) return [];
    const allRoles = await this.listRoles(workspaceId);
    const set = new Set<string>();
    for (const a of assignments) {
      const role = allRoles.find((r) => r.id === a.roleId);
      for (const p of (role?.permissions ?? []) as string[]) set.add(p);
    }
    return [...set];
  }

  /**
   * 校验权限。
   * 本地单机模式下如果没有给用户分配任何角色，视为 owner（否则「刚装好就啥都干不了」）。
   * 该兜底只针对「无任何角色」，一旦分配了角色就严格按角色权限执行。
   */
  async check(input: { workspaceId: string; userId: string; permission: Permission }): Promise<{ allowed: boolean; reason: string; granted: string[] }> {
    const assignments = (await this.db.select().from(userRoles).where(and(eq(userRoles.workspaceId, input.workspaceId), eq(userRoles.userId, input.userId)))) as unknown as UserRoleRow[];
    if (assignments.length === 0) {
      return { allowed: true, reason: '本地单机模式：未分配角色的用户按 owner 处理', granted: ALL_PERMISSIONS };
    }
    const granted = await this.permissionsOf(input.workspaceId, input.userId);
    if (granted.includes(input.permission)) return { allowed: true, reason: `已通过角色授予 ${input.permission}`, granted };
    return { allowed: false, reason: `缺少权限 ${input.permission}（${PERMISSIONS[input.permission]}）`, granted };
  }

  /** 强制校验：失败抛 403，message 里带缺失权限名 */
  async enforce(input: { workspaceId: string; userId: string; permission: Permission }): Promise<void> {
    const res = await this.check(input);
    if (!res.allowed) throw AppError.forbidden(res.reason);
  }

  permissionCatalog() {
    return Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label }));
  }
}

export type RoleRow = typeof roles.$inferSelect;
export type UserRoleRow = typeof userRoles.$inferSelect;

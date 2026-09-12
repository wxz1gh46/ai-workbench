import { eq } from 'drizzle-orm';
import { BUILTIN_AGENTS, DEFAULT_WORKSPACE_NAME, type Agent, type User, type Workspace } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { agents, users, workspaces } from '../db/schema/index.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { AppError } from '../utils/errors.ts';

/**
 * 本地单机模式：首次启动自动创建 local 用户 + 默认工作区 + 内置 Agent。
 * rootPath 默认 null，用户在工作区设置里指定后文件工具才可用（安全默认）。
 */
export class WorkspaceService {
  constructor(private readonly db: Db) {}

  async ensureBootstrap(): Promise<{ user: User; workspace: Workspace }> {
    const existing = await this.db.select().from(workspaces).limit(1);
    const first = existing[0];
    if (first) {
      const userRows = await this.db.select().from(users).where(eq(users.id, first.userId)).limit(1);
      const user = userRows[0];
      if (!user) throw AppError.internal('数据不一致：工作区缺少对应用户');
      return { user: user as User, workspace: first as Workspace };
    }

    const now = nowIso();
    const user: User = { id: newId('usr'), name: '本地用户', role: 'owner', createdAt: now };
    const workspace: Workspace = {
      id: newId('ws'),
      userId: user.id,
      name: DEFAULT_WORKSPACE_NAME,
      rootPath: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(users).values(user);
    await this.db.insert(workspaces).values(workspace);
    await this.ensureAgents(workspace.id);
    return { user, workspace };
  }

  /** 幂等创建内置 Agent */
  async ensureAgents(workspaceId: string): Promise<Agent[]> {
    const now = nowIso();
    const existing = await this.db.select().from(agents).where(eq(agents.workspaceId, workspaceId));
    const existingRoles = new Set(existing.map((a) => a.role));
    const toCreate = BUILTIN_AGENTS.filter((a) => !existingRoles.has(a.role)).map((a) => ({
      id: newId('agt'),
      workspaceId,
      name: a.name,
      role: a.role,
      status: 'idle' as const,
      systemPrompt: a.systemPrompt,
      model: null,
      currentTaskId: null,
      clusterNode: null,
      createdAt: now,
      updatedAt: now,
    }));
    if (toCreate.length) await this.db.insert(agents).values(toCreate);
    return this.db.select().from(agents).where(eq(agents.workspaceId, workspaceId)) as Promise<Agent[]>;
  }

  async getById(id: string): Promise<Workspace> {
    const rows = await this.db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
    const ws = rows[0];
    if (!ws) throw AppError.notFound(`工作区不存在: ${id}`);
    return ws as Workspace;
  }

  async updateRootPath(id: string, rootPath: string | null): Promise<Workspace> {
    await this.db.update(workspaces).set({ rootPath, updatedAt: nowIso() }).where(eq(workspaces.id, id));
    return this.getById(id);
  }

  async listAgents(workspaceId: string): Promise<Agent[]> {
    return this.db.select().from(agents).where(eq(agents.workspaceId, workspaceId)) as Promise<Agent[]>;
  }
}

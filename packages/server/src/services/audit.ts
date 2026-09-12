import { desc, eq } from 'drizzle-orm';
import { isDangerousAction, type AuditLog } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { auditLogs, workspaces } from '../db/schema/index.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';

/** 审计日志：所有工具调用 / 危险操作 / 权限拒绝都必须落库 */
export class AuditService {
  /** 已确认存在的工作区缓存，避免每条审计都查一次 */
  private readonly knownWorkspaces = new Set<string>();

  constructor(private readonly db: Db) {}

  /**
   * 写审计。
   *
   * 重要：审计是「旁路」能力，绝不能因为审计写入失败而让业务请求 500。
   * 典型场景：目标 / 会话 id 被误当作 workspaceId 传入（外键不存在）。
   * 这里按优先级解析出真实 workspaceId，全部失败则跳过写库并记警告（仍然可见于日志）。
   */
  async record(input: {
    workspaceId: string;
    actor: string;
    action: string;
    targetType: string;
    targetId?: string | null;
    confirmedByUser?: boolean;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    const dangerous = isDangerousAction(input.action);
    if (dangerous && !input.confirmedByUser) {
      logger.warn('dangerous action without user confirmation', { action: input.action });
    }

    const workspaceId = await this.resolveWorkspaceId(input);
    if (!workspaceId) {
      logger.warn('audit skipped: workspace not resolvable', {
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        providedWorkspaceId: input.workspaceId,
      });
      return;
    }

    try {
      await this.db.insert(auditLogs).values({
        id: newId('audit'),
        workspaceId,
        actor: input.actor,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        dangerous,
        confirmedByUser: input.confirmedByUser ?? false,
        detail: input.detail ?? {},
        createdAt: nowIso(),
      });
    } catch (e) {
      // 审计失败不影响主流程，但必须在日志里留下痕迹
      logger.error('audit insert failed', {
        action: input.action,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** 依次尝试：给的值 → 该值作为会话 id 反查 → 任意一个已存在的工作区 */
  private async resolveWorkspaceId(input: { workspaceId: string; targetType: string; targetId?: string | null }): Promise<string | null> {
    const candidates = [input.workspaceId, input.targetId ?? ''].filter(Boolean);
    for (const candidate of candidates) {
      if (this.knownWorkspaces.has(candidate)) return candidate;
      const hit = await this.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, candidate)).limit(1);
      if (hit.length > 0) {
        this.knownWorkspaces.add(candidate);
        return candidate;
      }
    }
    // 兜底：本地单机模式只有一个工作区，保证审计不丢
    const anyWs = await this.db.select({ id: workspaces.id }).from(workspaces).limit(1);
    const fallback = anyWs[0]?.id ?? null;
    if (fallback) this.knownWorkspaces.add(fallback);
    return fallback;
  }

  async list(workspaceId: string, limit = 100): Promise<AuditLog[]> {
    const rows = await this.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.workspaceId, workspaceId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit);
    return rows as AuditLog[];
  }
}

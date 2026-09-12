import { desc, eq } from 'drizzle-orm';
import { isDangerousAction, type AuditLog } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { auditLogs } from '../db/schema/index.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';

/** 审计日志：所有工具调用 / 危险操作 / 权限拒绝都必须落库 */
export class AuditService {
  constructor(private readonly db: Db) {}

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
    await this.db.insert(auditLogs).values({
      id: newId('audit'),
      workspaceId: input.workspaceId,
      actor: input.actor,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      dangerous,
      confirmedByUser: input.confirmedByUser ?? false,
      detail: input.detail ?? {},
      createdAt: nowIso(),
    });
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

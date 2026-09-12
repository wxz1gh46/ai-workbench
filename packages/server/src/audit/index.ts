import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { dbAudits, deployAudits, scheduleAudits } from '../db/schema/index.ts';
import { isDangerous, type DangerousAction } from '../security/dangerGate.ts';
import { maskSecret } from '../security/secrets.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';

/**
 * Phase 3 分域审计（部署 / 数据库 / 定时）。
 *
 * 与 audit_logs（全局）的关系：
 *   - audit_logs 记录「所有工具调用与用户操作」，是全局总线；
 *   - deploy_audits / db_audits / schedule_audits 记录各自域的完整上下文，
 *     便于「部署历史 / 迁移历史 / 任务历史」页面直接查询，无需二次过滤。
 *
 * 与 AuditService 相同的设计原则：审计是旁路能力，写失败不能影响业务请求。
 */

export interface AuditEntry {
  workspaceId: string;
  action: string;
  actor?: string;
  detail?: Record<string, unknown>;
  confirmedByUser?: boolean;
  deploymentId?: string;
  websiteProjectId?: string;
  databaseConnectionId?: string;
  scheduleId?: string;
}

/** 敏感字段脱敏：避免把 Token/连接串写进审计表 */
const SENSITIVE_KEY = /token|secret|password|pwd|apikey|api_key|authorization|connectionstring|url/i;

export function sanitizeDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (v === null || v === undefined) {
      out[k] = v;
      continue;
    }
    if (SENSITIVE_KEY.test(k)) {
      out[k] = typeof v === 'string' ? maskSecret(v, 4) : '<redacted>';
      continue;
    }
    if (typeof v === 'object' && !Array.isArray(v)) {
      out[k] = sanitizeDetail(v as Record<string, unknown>);
      continue;
    }
    out[k] = v;
  }
  return out;
}

class DomainAuditor {
  constructor(
    private readonly db: Db,
    private readonly table: typeof deployAudits | typeof dbAudits | typeof scheduleAudits,
  ) {}

  async record(entry: AuditEntry & { extra?: Record<string, unknown> }): Promise<void> {
    const dangerous = isDangerous(entry.action) ? (entry.action as DangerousAction) : null;
    if (dangerous && !entry.confirmedByUser) {
      logger.warn('dangerous action recorded without user confirmation', { action: entry.action });
    }
    try {
      await this.db.insert(this.table).values({
        id: newId('audit'),
        workspaceId: entry.workspaceId,
        action: entry.action,
        actor: entry.actor ?? 'user',
        dangerous: dangerous !== null,
        confirmedByUser: entry.confirmedByUser ?? false,
        detail: sanitizeDetail(entry.detail ?? {}),
        deploymentId: entry.deploymentId ?? null,
        websiteProjectId: entry.websiteProjectId ?? null,
        databaseConnectionId: entry.databaseConnectionId ?? null,
        scheduleId: entry.scheduleId ?? null,
        createdAt: nowIso(),
      } as never);
    } catch (e) {
      logger.error('phase3 audit insert failed', {
        action: entry.action,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async list(workspaceId: string, limit = 100) {
    return this.db
      .select()
      .from(this.table)
      .where(eq(this.table.workspaceId, workspaceId))
      .orderBy(desc(this.table.createdAt))
      .limit(limit);
  }
}

export class DeployAuditor extends DomainAuditor {
  constructor(db: Db) {
    super(db, deployAudits);
  }
}
export class DbAuditor extends DomainAuditor {
  constructor(db: Db) {
    super(db, dbAudits);
  }
}
export class ScheduleAuditor extends DomainAuditor {
  constructor(db: Db) {
    super(db, scheduleAudits);
  }
}

export function auditors(db: Db) {
  return {
    deploy: new DeployAuditor(db),
    db: new DbAuditor(db),
    schedule: new ScheduleAuditor(db),
  };
}

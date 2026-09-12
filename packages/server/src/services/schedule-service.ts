import { desc, eq } from 'drizzle-orm';
import type { Schedule } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { scheduleRuns, schedules } from '../db/schema/index.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';

/** 校验 cron 表达式（5 或 6 段，仅做结构校验，执行交给 node-cron） */
export function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5 || parts.length > 6) return false;
  return parts.every((p) => /^[\d*/,\-?#LW]+$/i.test(p));
}

export class ScheduleService {
  constructor(private readonly db: Db) {}

  async create(input: {
    workspaceId: string;
    name: string;
    trigger: Schedule['trigger'];
    expression: string;
    action: Record<string, unknown>;
    channelIds?: string[];
    enabled?: boolean;
    retry?: number;
  }): Promise<Schedule> {
    if (input.trigger === 'cron' && !isValidCron(input.expression)) {
      throw AppError.badRequest(`cron 表达式不合法: ${input.expression}`);
    }
    if (input.trigger === 'interval' && !/^\d+$/.test(input.expression)) {
      throw AppError.badRequest('interval 需要毫秒数字符串，如 "86400000"');
    }
    if (input.trigger === 'once' && Number.isNaN(Date.parse(input.expression))) {
      throw AppError.badRequest('once 需要 ISO 时间字符串');
    }
    const now = nowIso();
    const row = {
      id: newId('sch'),
      workspaceId: input.workspaceId,
      name: input.name,
      trigger: input.trigger,
      expression: input.expression,
      action: input.action,
      channelIds: input.channelIds ?? [],
      enabled: input.enabled ?? true,
      lastRunAt: null,
      nextRunAt: null,
      retry: input.retry ?? 2,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(schedules).values(row);
    logger.info('schedule created', { id: row.id, trigger: row.trigger });
    return row as Schedule;
  }

  async list(workspaceId: string): Promise<Schedule[]> {
    return (await this.db.select().from(schedules).where(eq(schedules.workspaceId, workspaceId))) as Schedule[];
  }

  async setEnabled(id: string, enabled: boolean): Promise<Schedule> {
    await this.db.update(schedules).set({ enabled, updatedAt: nowIso() }).where(eq(schedules.id, id));
    const rows = await this.db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
    const row = rows[0];
    if (!row) throw AppError.notFound(`定时任务不存在: ${id}`);
    return row as Schedule;
  }

  async listRuns(scheduleId: string) {
    return this.db
      .select()
      .from(scheduleRuns)
      .where(eq(scheduleRuns.scheduleId, scheduleId))
      .orderBy(desc(scheduleRuns.startedAt))
      .limit(50);
  }

  /** 记录一次执行结果（由调度器调用） */
  async recordRun(scheduleId: string, status: 'succeeded' | 'failed' | 'skipped', log: string, attempt = 1): Promise<void> {
    await this.db.insert(scheduleRuns).values({
      id: newId('srun'),
      scheduleId,
      status,
      attempt,
      log,
      startedAt: nowIso(),
      finishedAt: nowIso(),
    });
    await this.db.update(schedules).set({ lastRunAt: nowIso(), updatedAt: nowIso() }).where(eq(schedules.id, scheduleId));
  }
}

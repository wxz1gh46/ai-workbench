import { desc, eq } from 'drizzle-orm';
import { EventType, type RetryPolicy, type ScheduleRunRecord, type ScheduleTask, type ScheduleTaskType } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { scheduleRuns, schedules } from '../db/schema/index.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';
import { eventBus } from '../events/bus.ts';
import { CronError, CRON_PRESETS, describe, nextRun, parseCron, validateCron, validateTimezone } from './cronParser.ts';
import { TASK_TEMPLATES, fillTemplate, getTemplate, validateTemplateValues } from './templates.ts';
import { DEFAULT_RETRY, computeDelay, normalizeRetry, withRetry } from '../notify/retryPolicy.ts';
import type { JobRunner, JobResult } from './jobRunner.ts';
import { NotifyService } from '../notify/notifyService.ts';
import { ScheduleAuditor } from '../audit/index.ts';

/**
 * 定时任务服务（Step 5）。
 *
 * 与 Phase 1 的 ScheduleService 的关系：
 *   - 保留原有 schedules/schedule_runs 表（向后兼容）；
 *   - 本服务是 Phase 3 的完整实现：cron 解析 + 时区 + 模板 + 重试策略 +
 *     结构化结果 + 审计 + 通知联动。
 *
 * 并发控制：同一 schedule 同时只允许一个实例在执行（in-flight 集合），
 * 避免「上一次还没跑完，下一次又起来」把目标/部署重复触发。
 */
export class ScheduleManager {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly runner: JobRunner,
  ) {}

  private auditor() {
    return new ScheduleAuditor(this.db);
  }

  /* ---------------------------- CRUD ---------------------------- */

  async create(input: {
    workspaceId: string;
    name: string;
    trigger: 'cron' | 'interval' | 'once';
    expression: string;
    timezone?: string;
    taskType?: ScheduleTaskType;
    taskConfig?: Record<string, unknown>;
    template?: string;
    templateValues?: Record<string, string>;
    channelIds?: string[];
    retryPolicy?: Partial<RetryPolicy>;
    enabled?: boolean;
    actor?: string;
  }): Promise<ScheduleTask> {
    const name = input.name.trim();
    if (!name) throw AppError.badRequest('任务名称不能为空');

    const timezone = input.timezone ?? 'Asia/Shanghai';
    if (!validateTimezone(timezone)) {
      throw AppError.badRequest(`无效的时区：${timezone}（示例：Asia/Shanghai、UTC、America/New_York）`);
    }

    let taskType = input.taskType ?? 'goal';
    let taskConfig = input.taskConfig ?? {};
    let templateName: string | null = null;
    if (input.template) {
      const tpl = getTemplate(input.template);
      if (!tpl) throw AppError.badRequest(`未知任务模板: ${input.template}（可用：${TASK_TEMPLATES.map((t) => t.name).join(', ')}）`);
      const missing = validateTemplateValues(tpl, input.templateValues ?? {});
      if (missing.length > 0) throw AppError.badRequest(`模板参数缺失：${missing.join('、')}`);
      taskType = tpl.taskType;
      taskConfig = { ...fillTemplate(tpl, input.templateValues ?? {}), ...(input.taskConfig ?? {}) };
      templateName = tpl.name;
    }

    this.validateExpression(input.trigger, input.expression);

    const retry = normalizeRetry(input.retryPolicy);
    const now = nowIso();
    const next = this.computeNextRun(input.trigger, input.expression, timezone);
    const row = {
      id: newId('sch'),
      workspaceId: input.workspaceId,
      name,
      trigger: input.trigger,
      expression: input.expression.trim(),
      action: taskConfig,
      channelIds: input.channelIds ?? [],
      enabled: input.enabled ?? true,
      lastRunAt: null,
      nextRunAt: next,
      retry: retry.maxRetry,
      timezone,
      taskType,
      taskConfig,
      template: templateName,
      retryPolicy: retry as unknown as Record<string, unknown>,
      concurrency: 1,
      interruptedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(schedules).values(row as never);

    await this.auditor().record({
      workspaceId: input.workspaceId,
      action: 'schedule.create',
      actor: input.actor ?? 'user',
      scheduleId: row.id,
      confirmedByUser: true,
      detail: { name, trigger: row.trigger, expression: row.expression, timezone, taskType, template: templateName, nextRunAt: next, retry },
    });
    eventBus.publishBuffered(EventType.SCHEDULE_UPDATED, { scheduleId: row.id, action: 'created' }, { workspaceId: input.workspaceId });
    return this.toTask(row as never);
  }

  private validateExpression(trigger: 'cron' | 'interval' | 'once', expression: string): void {
    if (trigger === 'cron') {
      try {
        parseCron(expression);
      } catch (e) {
        throw AppError.badRequest(e instanceof CronError ? e.message : `cron 表达式不合法: ${expression}`);
      }
      return;
    }
    if (trigger === 'interval') {
      const ms = Number(expression);
      if (!Number.isFinite(ms) || ms < 60_000) {
        throw AppError.badRequest('interval 需要毫秒数且不小于 60000（1 分钟），例如 "3600000" 表示每小时');
      }
      return;
    }
    if (trigger === 'once') {
      const t = Date.parse(expression);
      if (Number.isNaN(t)) throw AppError.badRequest('once 需要 ISO 时间字符串，例如 "2026-01-01T09:00:00+08:00"');
      if (t <= Date.now()) throw AppError.badRequest('once 时间必须晚于当前时间');
    }
  }

  private computeNextRun(trigger: 'cron' | 'interval' | 'once', expression: string, timezone: string): string | null {
    try {
      if (trigger === 'cron') return nextRun(expression, new Date(), timezone).toISOString();
      if (trigger === 'interval') return new Date(Date.now() + Number(expression)).toISOString();
      return new Date(expression).toISOString();
    } catch {
      return null;
    }
  }

  async list(workspaceId: string): Promise<ScheduleTask[]> {
    const rows = await this.db.select().from(schedules).where(eq(schedules.workspaceId, workspaceId)).orderBy(desc(schedules.createdAt));
    return rows.map((r) => this.toTask(r as never));
  }

  async get(workspaceId: string, id: string): Promise<ScheduleTask> {
    const rows = await this.db.select().from(schedules).where(eq(schedules.id, id)).limit(1);
    const row = rows[0];
    if (!row || row.workspaceId !== workspaceId) throw AppError.notFound(`定时任务不存在: ${id}`);
    return this.toTask(row as never);
  }

  async update(input: {
    workspaceId: string;
    id: string;
    name?: string;
    expression?: string;
    timezone?: string;
    taskConfig?: Record<string, unknown>;
    channelIds?: string[];
    retryPolicy?: Partial<RetryPolicy>;
    enabled?: boolean;
    actor?: string;
  }): Promise<ScheduleTask> {
    const current = await this.get(input.workspaceId, input.id);
    const timezone = input.timezone ?? current.timezone;
    if (!validateTimezone(timezone)) throw AppError.badRequest(`无效的时区：${timezone}`);
    const expression = input.expression ?? current.expression;
    if (input.expression) this.validateExpression(current.trigger, expression);
    const retry = normalizeRetry({ ...(current.retryPolicy as unknown as RetryPolicy), ...(input.retryPolicy ?? {}) });

    await this.db
      .update(schedules)
      .set({
        name: input.name?.trim() || current.name,
        expression,
        timezone,
        taskConfig: (input.taskConfig ? { ...current.taskConfig, ...input.taskConfig } : current.taskConfig) as never,
        action: (input.taskConfig ? { ...current.taskConfig, ...input.taskConfig } : current.taskConfig) as never,
        channelIds: (input.channelIds ?? current.channelIds) as never,
        retryPolicy: retry as unknown as Record<string, unknown>,
        retry: retry.maxRetry,
        enabled: input.enabled ?? current.enabled,
        nextRunAt: input.enabled === false ? null : this.computeNextRun(current.trigger, expression, timezone),
        updatedAt: nowIso(),
      })
      .where(eq(schedules.id, input.id));

    await this.auditor().record({
      workspaceId: input.workspaceId,
      action: 'schedule.update',
      actor: input.actor ?? 'user',
      scheduleId: input.id,
      confirmedByUser: true,
      detail: { changes: Object.keys(input).filter((k) => !['workspaceId', 'id', 'actor'].includes(k)), enabled: input.enabled ?? current.enabled },
    });
    eventBus.publishBuffered(EventType.SCHEDULE_UPDATED, { scheduleId: input.id, action: 'updated' }, { workspaceId: input.workspaceId });
    return this.get(input.workspaceId, input.id);
  }

  async setEnabled(workspaceId: string, id: string, enabled: boolean): Promise<ScheduleTask> {
    const current = await this.get(workspaceId, id);
    await this.db
      .update(schedules)
      .set({
        enabled,
        nextRunAt: enabled ? this.computeNextRun(current.trigger, current.expression, current.timezone) : null,
        interruptedAt: null,
        updatedAt: nowIso(),
      })
      .where(eq(schedules.id, id));
    await this.auditor().record({
      workspaceId,
      action: enabled ? 'schedule.enable' : 'schedule.disable',
      scheduleId: id,
      confirmedByUser: true,
      detail: { enabled },
    });
    eventBus.publishBuffered(EventType.SCHEDULE_UPDATED, { scheduleId: id, action: enabled ? 'enabled' : 'disabled' }, { workspaceId });
    return this.get(workspaceId, id);
  }

  async remove(input: { workspaceId: string; id: string; actor?: string; confirm: boolean }): Promise<{ ok: true }> {
    await this.get(input.workspaceId, input.id);
    await this.db.delete(schedules).where(eq(schedules.id, input.id));
    await this.auditor().record({
      workspaceId: input.workspaceId,
      action: 'schedule.delete',
      actor: input.actor ?? 'user',
      scheduleId: input.id,
      confirmedByUser: input.confirm,
      detail: { removed: true },
    });
    eventBus.publishBuffered(EventType.SCHEDULE_UPDATED, { scheduleId: input.id, action: 'removed' }, { workspaceId: input.workspaceId });
    logger.info('schedule removed', { id: input.id });
    return { ok: true };
  }

  /* ---------------------------- 执行 ---------------------------- */

  /** 手动触发（trigger='manual'，审计会体现） */
  async runNow(input: { workspaceId: string; id: string; actor?: string; confirm: boolean }): Promise<ScheduleRunRecord> {
    const task = await this.get(input.workspaceId, input.id);
    await this.auditor().record({
      workspaceId: input.workspaceId,
      action: 'schedule.run',
      actor: input.actor ?? 'user',
      scheduleId: input.id,
      confirmedByUser: input.confirm,
      detail: { manual: true, taskType: task.taskType },
    });
    return this.execute(task, 'manual');
  }

  /**
   * 执行任务：写 running 记录 → 带重试执行 → 写终态记录 → 通知 → 审计。
   * 返回最终的执行记录（含结果与错误）。
   */
  async execute(task: ScheduleTask, trigger: 'auto' | 'manual' = 'auto'): Promise<ScheduleRunRecord> {
    if (this.inFlight.has(task.id)) {
      const skipped = await this.recordRun({
        scheduleId: task.id,
        status: 'skipped',
        attempt: 0,
        retryCount: 0,
        log: '上一次执行尚未结束，本次跳过（并发保护）',
        result: null,
        error: 'already-running',
        trigger,
      });
      logger.warn('schedule skipped: already running', { id: task.id });
      return skipped;
    }
    this.inFlight.add(task.id);
    const startedAt = nowIso();
    const retry = normalizeRetry(task.retryPolicy as unknown as RetryPolicy);
    let lastResult: JobResult | null = null;
    let attempts = 0;

    try {
      const { value, attempts: used } = await withRetry(
        async () => {
          const res = await this.runner.execute(task);
          if (!res.ok && res.retryable) throw new Error(res.summary);
          return res;
        },
        { ...retry, maxRetry: retry.maxRetry },
        ({ attempt, error, delayMs }) => {
          eventBus.publishBuffered(
            EventType.SCHEDULE_LOG,
            { scheduleId: task.id, level: 'warn', msg: `第 ${attempt} 次尝试失败：${error}，${delayMs}ms 后重试` },
            { workspaceId: task.workspaceId },
          );
        },
      );
      lastResult = value;
      attempts = used;
    } catch (e) {
      lastResult = {
        ok: false,
        summary: e instanceof Error ? e.message : String(e),
        data: {},
        degraded: false,
        retryable: false,
      };
      attempts = retry.maxRetry + 1;
    } finally {
      this.inFlight.delete(task.id);
    }

    const finished = nowIso();
    const run = await this.recordRun({
      scheduleId: task.id,
      status: lastResult.ok ? 'succeeded' : 'failed',
      attempt: attempts,
      retryCount: Math.max(0, attempts - 1),
      log: `${lastResult.summary}${attempts > 1 ? `（共尝试 ${attempts} 次）` : ''}`,
      result: lastResult.data,
      error: lastResult.ok ? null : lastResult.summary,
      trigger,
      startedAt,
      finishedAt: finished,
    });

    const next = task.enabled ? this.computeNextRun(task.trigger, task.expression, task.timezone) : null;
    await this.db.update(schedules).set({ lastRunAt: finished, nextRunAt: next, updatedAt: finished }).where(eq(schedules.id, task.id));

    eventBus.publishBuffered(
      EventType.SCHEDULE_LOG,
      { scheduleId: task.id, level: lastResult.ok ? 'info' : 'error', msg: lastResult.summary, runId: run.id, status: run.status },
      { workspaceId: task.workspaceId },
    );

    await this.auditor().record({
      workspaceId: task.workspaceId,
      action: 'schedule.execute',
      actor: trigger === 'manual' ? 'user' : 'scheduler',
      scheduleId: task.id,
      confirmedByUser: trigger === 'manual',
      detail: {
        runId: run.id,
        status: run.status,
        attempts,
        taskType: task.taskType,
        summary: lastResult.summary.slice(0, 300),
        degraded: lastResult.degraded,
      },
    });

    // 通知联动（Step 6）
    void this.notify(task, run, lastResult).catch((e) =>
      logger.warn('schedule notify failed', { scheduleId: task.id, error: e instanceof Error ? e.message : String(e) }),
    );

    return run;
  }

  private async notify(task: ScheduleTask, run: ScheduleRunRecord, result: JobResult): Promise<void> {
    const notify = new NotifyService(this.db);
    await notify.dispatch({
      workspaceId: task.workspaceId,
      channelIds: task.channelIds,
      scheduleRunId: run.id,
      message: {
        event: result.ok ? 'schedule' : 'error',
        level: result.ok ? 'success' : 'error',
        title: `${result.ok ? '定时任务完成' : '定时任务失败'}：${task.name}`,
        content: [
          `类型：${task.taskType}`,
          `表达式：${task.expression}（${task.timezone}）`,
          `尝试次数：${run.attempt}`,
          `结果：${result.summary}`,
        ].join('\n'),
      },
    });
  }

  private async recordRun(input: {
    scheduleId: string;
    status: 'running' | 'succeeded' | 'failed' | 'skipped';
    attempt: number;
    retryCount: number;
    log: string;
    result: Record<string, unknown> | null;
    error: string | null;
    trigger: 'auto' | 'manual';
    startedAt?: string;
    finishedAt?: string | null;
  }): Promise<ScheduleRunRecord> {
    const row = {
      id: newId('srun'),
      scheduleId: input.scheduleId,
      status: input.status,
      attempt: input.attempt,
      log: input.log.slice(0, 8000),
      retryCount: input.retryCount,
      result: input.result,
      error: input.error ? input.error.slice(0, 2000) : null,
      trigger: input.trigger,
      startedAt: input.startedAt ?? nowIso(),
      finishedAt: input.finishedAt ?? nowIso(),
    };
    await this.db.insert(scheduleRuns).values(row as never);
    return row as unknown as ScheduleRunRecord;
  }

  async listRuns(workspaceId: string, scheduleId: string, limit = 50): Promise<ScheduleRunRecord[]> {
    await this.get(workspaceId, scheduleId);
    const rows = await this.db
      .select()
      .from(scheduleRuns)
      .where(eq(scheduleRuns.scheduleId, scheduleId))
      .orderBy(desc(scheduleRuns.startedAt))
      .limit(limit);
    return rows as unknown as ScheduleRunRecord[];
  }

  /** 列出「已到期该执行」的任务（调度引擎每 tick 调用） */
  async dueTasks(workspaceId: string, now = new Date()): Promise<ScheduleTask[]> {
    const all = await this.list(workspaceId);
    return all.filter((t) => {
      if (!t.enabled) return false;
      if (!t.nextRunAt) return false;
      return Date.parse(t.nextRunAt) <= now.getTime();
    });
  }

  /** 行 → 领域对象（补默认值，避免老数据缺字段） */
  private toTask(row: {
    id: string;
    workspaceId: string;
    name: string;
    trigger: string;
    expression: string;
    action: unknown;
    channelIds: unknown;
    enabled: boolean;
    lastRunAt: string | null;
    nextRunAt: string | null;
    retry: number;
    timezone?: string;
    taskType?: string;
    taskConfig?: unknown;
    template?: string | null;
    retryPolicy?: unknown;
    concurrency?: number;
    createdAt: string;
    updatedAt: string;
  }): ScheduleTask {
    const retryPolicy = normalizeRetry((row.retryPolicy as Partial<RetryPolicy>) ?? { maxRetry: row.retry ?? 2 });
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      trigger: row.trigger as ScheduleTask['trigger'],
      expression: row.expression,
      timezone: row.timezone ?? 'Asia/Shanghai',
      taskType: (row.taskType ?? 'goal') as ScheduleTaskType,
      taskConfig: ((row.taskConfig ?? row.action ?? {}) as Record<string, unknown>) ?? {},
      template: row.template ?? null,
      enabled: Boolean(row.enabled),
      nextRunAt: row.nextRunAt,
      lastRunAt: row.lastRunAt,
      retryPolicy,
      channelIds: Array.isArray(row.channelIds) ? (row.channelIds as string[]) : [],
      concurrency: row.concurrency ?? 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /* ---------------------------- 元信息 ---------------------------- */

  templates() {
    return TASK_TEMPLATES;
  }

  cronPresets() {
    return CRON_PRESETS;
  }

  /** cron 预览：返回描述 + 后续 5 次执行时间（UI 上让用户确认） */
  previewCron(expression: string, timezone = 'Asia/Shanghai', count = 5): { ok: boolean; error?: string; description?: string; next: string[] } {
    try {
      if (!validateTimezone(timezone)) throw new CronError(`无效的时区：${timezone}`);
      const parsed = parseCron(expression);
      const out: string[] = [];
      let cursor = new Date();
      for (let i = 0; i < count; i += 1) {
        const n = nextRun(expression, cursor, timezone);
        out.push(n.toISOString());
        cursor = n;
      }
      return { ok: true, description: describe(parsed), next: out };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), next: [] };
    }
  }

  /** 供 UI 展示的「距离下次执行」 */
  static humanizeNext(nextRunAt: string | null, now = Date.now()): string {
    if (!nextRunAt) return '未安排';
    const diff = Date.parse(nextRunAt) - now;
    if (Number.isNaN(diff)) return '时间无效';
    if (diff <= 0) return '即将执行';
    const min = Math.floor(diff / 60_000);
    if (min < 60) return `${min} 分钟后`;
    const hour = Math.floor(min / 60);
    if (hour < 24) return `${hour} 小时后`;
    return `${Math.floor(hour / 24)} 天后`;
  }

  static defaultRetry(): RetryPolicy {
    return { ...DEFAULT_RETRY };
  }

  static backoffPreview(policy: Partial<RetryPolicy>, attempts = 4): { attempt: number; delayMs: number }[] {
    const norm = normalizeRetry(policy);
    const out: { attempt: number; delayMs: number }[] = [];
    for (let i = 1; i <= attempts; i += 1) out.push({ attempt: i, delayMs: computeDelay(i, norm) });
    return out;
  }
}

export { validateCron, nextRun, describe };

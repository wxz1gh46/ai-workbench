import cron, { type ScheduledTask } from 'node-cron';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { schedules } from '../db/schema/index.ts';
import { ScheduleService } from './schedule-service.ts';
import { GoalService } from '../agent/goal-service.ts';
import { EventType } from '@ai/shared';
import { eventBus } from '../events/bus.ts';
import { logger } from '../utils/logger.ts';

/**
 * 定时任务调度器（Phase 1 用 node-cron 进程内调度）。
 * Phase 3 换成 BullMQ 持久化队列，接口保持不变。
 *
 * 支持动作类型：
 *   { type: 'goal', objective: '...' }        → 创建一个目标并连续推进
 *   { type: 'noop' }                          → 只发通知（用于外部 webhook 触发）
 */
export function startScheduler(db: Db): () => void {
  const scheduleService = new ScheduleService(db);
  const goalService = new GoalService(db);
  const tasks: ScheduledTask[] = [];

  const runAction = async (scheduleId: string): Promise<void> => {
    const rows = await db.select().from(schedules).where(eq(schedules.id, scheduleId)).limit(1);
    const schedule = rows[0];
    if (!schedule || !schedule.enabled) return;
    let attempt = 0;
    const maxAttempts = schedule.retry + 1;
    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        const action = schedule.action as { type?: string; objective?: string };
        if (action.type === 'goal' && action.objective) {
          const goal = await goalService.createGoal({ workspaceId: schedule.workspaceId, objective: action.objective, autoRun: false });
          eventBus.publishBuffered(EventType.SCHEDULE_RUN, { scheduleId, goalId: goal.goal.id, status: 'running' }, {
            workspaceId: schedule.workspaceId,
            goalId: goal.goal.id,
            taskId: null,
          });
          await goalService.advanceUntilFinished(goal.goal.id);
        }
        await scheduleService.recordRun(scheduleId, 'succeeded', `执行成功（第 ${attempt} 次尝试）`, attempt);
        logger.info('schedule executed', { scheduleId, attempt });
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt >= maxAttempts) {
          await scheduleService.recordRun(scheduleId, 'failed', `失败: ${msg}`, attempt);
          logger.error('schedule failed', { scheduleId, error: msg });
          return;
        }
        logger.warn('schedule retry', { scheduleId, attempt, error: msg });
      }
    }
  };

  const load = async () => {
    const all = await db.select().from(schedules);
    for (const s of all) {
      if (!s.enabled) continue;
      if (s.trigger === 'cron' && cron.validate(s.expression)) {
        tasks.push(cron.schedule(s.expression, () => void runAction(s.id)));
        logger.info('cron registered', { id: s.id, expression: s.expression });
      } else if (s.trigger === 'interval') {
        const ms = Number(s.expression);
        if (Number.isFinite(ms) && ms >= 1000) {
          const timer = setInterval(() => void runAction(s.id), ms);
          tasks.push({ stop: () => clearInterval(timer) } as ScheduledTask);
          logger.info('interval registered', { id: s.id, ms });
        }
      } else if (s.trigger === 'once') {
        const at = Date.parse(s.expression);
        const delay = at - Date.now();
        if (delay > 0 && delay < 2 ** 31 - 1) {
          const timer = setTimeout(() => void runAction(s.id), delay);
          tasks.push({ stop: () => clearTimeout(timer) } as ScheduledTask);
        }
      }
    }
  };

  void load().catch((e) => logger.error('scheduler load failed', { error: e instanceof Error ? e.message : String(e) }));

  // 每分钟热加载一次（新建的定时任务无需重启即可生效）
  const reloadTimer = setInterval(() => void load().catch(() => undefined), 60_000);

  return () => {
    clearInterval(reloadTimer);
    for (const t of tasks) t.stop();
  };
}

import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { schedules } from '../db/schema/index.ts';
import { logger } from '../utils/logger.ts';
import { nowIso } from '../utils/ids.ts';
import type { ScheduleManager } from './scheduleService.ts';

/**
 * 调度引擎（Step 5）。
 *
 * 为什么不是「一个任务一个 node-cron 实例」：
 *   1. 任务可能在运行期被创建/修改/删除，逐个注册/反注册容易漏；
 *   2. 需要统一并发控制与错误隔离（某个任务抛错不能影响其他任务）；
 *   3. 需要持久化的 next_run_at（进程重启后能恢复，不丢任务）。
 *
 * 采用「tick + next_run_at」模型：
 *   每 30 秒扫描一次到期任务 → 并发执行（上限可配） → 执行后写回 next_run_at。
 *
 * 重启恢复：进程启动时把 interrupted_at 为 null 且 nextRunAt 早于现在的任务
 * 视为「错过的任务」，不补跑（避免一次启动触发雪崩），但会记录 warning 并在
 * 下次正常时间执行 —— 这是刻意的取舍，宁可漏跑一次也不要突然跑 100 个任务。
 */
export interface ScheduleEngineOptions {
  tickMs?: number;
  maxConcurrent?: number;
}

export class ScheduleEngine {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly tickMs: number;
  private readonly maxConcurrent: number;

  constructor(
    private readonly db: Db,
    private readonly manager: ScheduleManager,
    opts: ScheduleEngineOptions = {},
  ) {
    this.tickMs = opts.tickMs ?? 30_000;
    this.maxConcurrent = opts.maxConcurrent ?? 2;
  }

  /** 启动前处理「错过的任务」：只记录，不补跑 */
  async recoverOnStartup(workspaceId: string): Promise<{ missed: number }> {
    const all = await this.manager.list(workspaceId);
    const now = Date.now();
    let missed = 0;
    for (const t of all) {
      if (!t.enabled || !t.nextRunAt) continue;
      if (Date.parse(t.nextRunAt) < now) {
        missed += 1;
        logger.warn('schedule missed while offline (will run at next scheduled time)', {
          id: t.id,
          name: t.name,
          missedAt: t.nextRunAt,
        });
        await this.db.update(schedules).set({ interruptedAt: nowIso(), updatedAt: nowIso() }).where(eq(schedules.id, t.id));
      }
    }
    if (missed > 0) logger.warn('missed schedules detected', { count: missed });
    return { missed };
  }

  start(workspaceId: string): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick(workspaceId).catch((e) => logger.error('schedule tick failed', { error: e instanceof Error ? e.message : String(e) }));
    }, this.tickMs);
    logger.info('schedule engine started', { workspaceId, tickMs: this.tickMs, maxConcurrent: this.maxConcurrent });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 一轮：找出到期任务并执行（并发上限内） */
  async tick(workspaceId: string, now = new Date()): Promise<{ executed: number; failed: number; skipped: number }> {
    if (this.running) return { executed: 0, failed: 0, skipped: 0 };
    this.running = true;
    try {
      const due = await this.manager.dueTasks(workspaceId, now);
      if (due.length === 0) return { executed: 0, failed: 0, skipped: 0 };

      let executed = 0;
      let failed = 0;
      for (let i = 0; i < due.length; i += this.maxConcurrent) {
        const batch = due.slice(i, i + this.maxConcurrent);
        const results = await Promise.all(
          batch.map(async (task) => {
            try {
              const run = await this.manager.execute(task, 'auto');
              return run.status;
            } catch (e) {
              logger.error('schedule execute threw', { id: task.id, error: e instanceof Error ? e.message : String(e) });
              return 'failed';
            }
          }),
        );
        for (const status of results) {
          if (status === 'succeeded' || status === 'running') executed += 1;
          else if (status === 'failed') failed += 1;
        }
      }
      logger.info('schedule tick done', { workspaceId, due: due.length, executed, failed });
      return { executed, failed, skipped: 0 };
    } finally {
      this.running = false;
    }
  }
}

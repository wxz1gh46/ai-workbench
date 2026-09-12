import { eq } from 'drizzle-orm';
import type { WidgetInstance } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { widgets } from '../db/schema/index.ts';
import { logger } from '../utils/logger.ts';
import type { DashboardService } from './dashboardService.ts';

/**
 * 实时刷新调度（Step 4）。
 *
 * 三种刷新机制并存（这是刻意的设计，不是冗余）：
 *   1. 事件驱动：任何状态变化（task.updated / deploy.status / schedule.log …）
 *      → 立即刷新相关组件，用户感知「实时」；
 *   2. 轮询兜底：按组件配置的 refreshIntervalMs 定时刷新，
 *      防止事件丢失（例如进程重启期间的变化）；
 *   3. 手动刷新：用户点按钮。
 *
 * 性能约束（验收要求「大量小组件不卡顿」）：
 *   - 全局并发上限（默认 4），避免同时打爆数据源；
 *   - 同一组件最小刷新间隔（防抖），避免事件风暴导致重复查询；
 *   - 一轮刷新整体超时（默认 10s），超时的组件跳过并在下一轮补上。
 */

export interface RefreshSchedulerOptions {
  maxConcurrent?: number;
  minIntervalMs?: number;
  roundTimeoutMs?: number;
}

export class RefreshScheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly lastRefresh = new Map<string, number>();
  private readonly maxConcurrent: number;
  private readonly minIntervalMs: number;
  private readonly roundTimeoutMs: number;
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly dashboards: DashboardService,
    opts: RefreshSchedulerOptions = {},
  ) {
    this.maxConcurrent = opts.maxConcurrent ?? 4;
    this.minIntervalMs = opts.minIntervalMs ?? 1500;
    this.roundTimeoutMs = opts.roundTimeoutMs ?? 10_000;
  }

  /** 启动轮询（按组件的最小 refreshIntervalMs 作为 tick） */
  start(workspaceId: string, tickMs = 3000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick(workspaceId).catch((e) => logger.warn('refresh tick failed', { error: e instanceof Error ? e.message : String(e) }));
    }, tickMs);
    logger.info('widget refresh scheduler started', { workspaceId, tickMs, maxConcurrent: this.maxConcurrent });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 一轮：找出「到期该刷新」的组件，按并发上限分批执行。
   *
   * 首次刷新宽限期（真实踩坑）：
   * 刚创建的组件 lastRefresh 为 0，如果直接比较会「立刻到期」，
   * 于是 200 个新建组件会在第一次 tick 全部同时刷新，把数据源打满。
   * 因此以「组件创建时间」作为首刷基准，并要求至少间隔 minIntervalMs。
   */
  async tick(workspaceId: string, now = Date.now()): Promise<{ refreshed: number; skipped: number; degraded: number }> {
    if (this.running) return { refreshed: 0, skipped: 0, degraded: 0 };
    this.running = true;
    try {
      const all = (await this.db.select().from(widgets).where(eq(widgets.workspaceId, workspaceId))) as unknown as WidgetInstance[];
      const due = all.filter((w) => {
        if (!w.enabled) return false;
        const createdAt = Date.parse(w.createdAt ?? '') || 0;
        const last = this.lastRefresh.get(w.id) ?? createdAt;
        return now - last >= Math.max(w.refreshIntervalMs, this.minIntervalMs);
      });
      if (due.length === 0) return { refreshed: 0, skipped: all.length, degraded: 0 };

      let refreshed = 0;
      let degraded = 0;
      const deadline = Date.now() + this.roundTimeoutMs;
      for (let i = 0; i < due.length; i += this.maxConcurrent) {
        if (Date.now() > deadline) {
          logger.warn('refresh round timeout, remaining widgets deferred', { remaining: due.length - i });
          break;
        }
        const batch = due.slice(i, i + this.maxConcurrent);
        const results = await Promise.all(
          batch.map(async (w) => {
            try {
              const data = await this.dashboards.refreshWidget({ workspaceId, widgetId: w.id });
              this.lastRefresh.set(w.id, Date.now());
              return data;
            } catch (e) {
              logger.warn('widget refresh failed', { widgetId: w.id, error: e instanceof Error ? e.message : String(e) });
              return null;
            }
          }),
        );
        refreshed += results.filter(Boolean).length;
        degraded += results.filter((r) => r?.degraded).length;
      }
      return { refreshed, skipped: all.length - due.length, degraded };
    } finally {
      this.running = false;
    }
  }

  /** 事件驱动刷新：只刷与事件相关的组件类型 */
  async refreshByType(workspaceId: string, types: WidgetInstance['type'][], label: string): Promise<number> {
    const all = (await this.db.select().from(widgets).where(eq(widgets.workspaceId, workspaceId))) as unknown as WidgetInstance[];
    const targets = all.filter((w) => w.enabled && types.includes(w.type));
    if (targets.length === 0) return 0;
    const now = Date.now();
    let n = 0;
    for (const w of targets) {
      const last = this.lastRefresh.get(w.id) ?? 0;
      if (now - last < this.minIntervalMs) continue; // 防抖
      try {
        await this.dashboards.refreshWidget({ workspaceId, widgetId: w.id });
        this.lastRefresh.set(w.id, Date.now());
        n += 1;
      } catch (e) {
        logger.debug('event-driven refresh failed', { widgetId: w.id, label, error: e instanceof Error ? e.message : String(e) });
      }
    }
    if (n > 0) logger.debug('event-driven refresh done', { label, count: n });
    return n;
  }

  /** 强制刷新单个组件（跳过防抖，供手动刷新与测试使用） */
  async forceRefresh(workspaceId: string, widgetId: string): Promise<void> {
    await this.dashboards.refreshWidget({ workspaceId, widgetId });
    this.lastRefresh.set(widgetId, Date.now());
  }

  /** 内部状态（测试用） */
  lastRefreshAt(widgetId: string): number {
    return this.lastRefresh.get(widgetId) ?? 0;
  }
}

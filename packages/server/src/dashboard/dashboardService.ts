import { and, desc, eq } from 'drizzle-orm';
import { EventType, type Dashboard, type Widget, type WidgetInstance, type WidgetKind, type WidgetRenderData } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { dashboards, widgetDataSources, widgets } from '../db/schema/index.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';
import { eventBus } from '../events/bus.ts';
import { getWidgetSpec, inferWidget, WIDGET_REGISTRY } from './widgetRegistry.ts';
import { WidgetDataSources, type QueryExecutor } from './dataSource.ts';
import { applySnapshot, compact, findFreeSlot, snapshotLayout, validateBoard, validateLayout, type LayoutItem } from './layoutEngine.ts';

/**
 * 看板服务（Step 4）。
 *
 * 能力：
 *   - 看板 CRUD（含布局快照历史 → 布局可回滚）
 *   - 自然语言创建小组件
 *   - 拖拽布局持久化（服务端校验 + 紧凑化）
 *   - 实时刷新（单组件刷新 / 整板刷新）
 *   - 固定到桌面（pinnedToDesktop，由 Tauri 前端消费）
 *
 * 缓存策略：
 *   widget_data_sources.last_value 缓存最近一次结果 + last_refreshed_at。
 *   前端首屏直接读缓存（不卡），随后按 refresh_interval_ms 拉新。
 */
export class DashboardService {
  private readonly sources: WidgetDataSources;

  constructor(
    private readonly db: Db,
    queryExecutor?: QueryExecutor,
  ) {
    this.sources = new WidgetDataSources(db, queryExecutor);
  }

  /* ---------------------------- 看板 ---------------------------- */

  static registry() {
    return WIDGET_REGISTRY;
  }

  async ensureDefault(workspaceId: string): Promise<Dashboard> {
    const existing = await this.db.select().from(dashboards).where(eq(dashboards.workspaceId, workspaceId)).limit(1);
    if (existing[0]) return existing[0] as unknown as Dashboard;
    const now = nowIso();
    const row = {
      id: newId('dsh'),
      workspaceId,
      name: '我的看板',
      description: '默认看板：可以用自然语言添加小组件',
      layoutJson: {} as Record<string, unknown>,
      layoutHistory: [] as { at: string; layout: Record<string, unknown> }[],
      isDefault: true,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(dashboards).values(row);
    return row as unknown as Dashboard;
  }

  async create(input: { workspaceId: string; name: string; description?: string }): Promise<Dashboard> {
    const name = input.name.trim();
    if (!name) throw AppError.badRequest('看板名称不能为空');
    const now = nowIso();
    const row = {
      id: newId('dsh'),
      workspaceId: input.workspaceId,
      name,
      description: input.description ?? '',
      layoutJson: {} as Record<string, unknown>,
      layoutHistory: [] as { at: string; layout: Record<string, unknown> }[],
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(dashboards).values(row);
    return row as unknown as Dashboard;
  }

  async listDashboards(workspaceId: string): Promise<Dashboard[]> {
    await this.ensureDefault(workspaceId);
    const rows = await this.db.select().from(dashboards).where(eq(dashboards.workspaceId, workspaceId)).orderBy(desc(dashboards.createdAt));
    return rows as unknown as Dashboard[];
  }

  async getDashboard(workspaceId: string, id: string): Promise<{ dashboard: Dashboard; widgets: WidgetInstance[] }> {
    const rows = await this.db.select().from(dashboards).where(eq(dashboards.id, id)).limit(1);
    const dash = rows[0];
    if (!dash || dash.workspaceId !== workspaceId) throw AppError.notFound(`看板不存在: ${id}`);
    const list = await this.db.select().from(widgets).where(eq(widgets.dashboardId, id)).orderBy(widgets.position);
    return { dashboard: dash as unknown as Dashboard, widgets: list as unknown as WidgetInstance[] };
  }

  async renameDashboard(workspaceId: string, id: string, name: string): Promise<Dashboard> {
    const { dashboard } = await this.getDashboard(workspaceId, id);
    if (!name.trim()) throw AppError.badRequest('看板名称不能为空');
    await this.db.update(dashboards).set({ name: name.trim(), updatedAt: nowIso() }).where(eq(dashboards.id, dashboard.id));
    return (await this.getDashboard(workspaceId, id)).dashboard;
  }

  async deleteDashboard(workspaceId: string, id: string): Promise<{ ok: true; widgetsRemoved: number }> {
    const { dashboard, widgets: list } = await this.getDashboard(workspaceId, id);
    for (const w of list) await this.db.delete(widgets).where(eq(widgets.id, w.id));
    await this.db.delete(dashboards).where(eq(dashboards.id, dashboard.id));
    logger.info('dashboard deleted', { id, widgets: list.length });
    return { ok: true, widgetsRemoved: list.length };
  }

  /* --------------------------- 小组件 --------------------------- */

  /** 自然语言创建 */
  async createFromNaturalLanguage(input: {
    workspaceId: string;
    naturalLanguage: string;
    dashboardId?: string;
    layoutOverride?: { x: number; y: number; w: number; h: number };
  }): Promise<{ widget: WidgetInstance; inference: ReturnType<typeof inferWidget> }> {
    const dash = input.dashboardId
      ? await this.getDashboard(input.workspaceId, input.dashboardId)
      : { dashboard: await this.ensureDefault(input.workspaceId), widgets: [] as WidgetInstance[] };

    const inference = inferWidget(input.naturalLanguage);
    const spec = getWidgetSpec(inference.type);
    return { widget: await this.createWidget({ ...input, dashboardId: dash.dashboard.id, type: inference.type, title: inference.title, config: inference.config }), inference, spec } as never;
  }

  /** 直接创建（指定类型） */
  async createWidget(input: {
    workspaceId: string;
    dashboardId?: string;
    type: WidgetKind;
    title?: string;
    config?: Record<string, unknown>;
    naturalLanguage?: string;
    layout?: { x: number; y: number; w: number; h: number };
    pinnedToDesktop?: boolean;
    refreshIntervalMs?: number;
  }): Promise<WidgetInstance> {
    const spec = getWidgetSpec(input.type);
    if (!spec) throw AppError.badRequest(`未知组件类型: ${input.type}（可用：${WIDGET_REGISTRY.map((w) => w.type).join(', ')}）`);

    const dashboardId = input.dashboardId ?? (await this.ensureDefault(input.workspaceId)).id;
    const existing = await this.db.select().from(widgets).where(eq(widgets.dashboardId, dashboardId));
    const layoutItems: LayoutItem[] = existing.map((w) => ({ id: w.id, ...(w.layout as { x: number; y: number; w: number; h: number }) }));

    let layout = input.layout ?? findFreeSlot(layoutItems, spec.defaultSize);
    const valid = validateLayout(layout);
    if (!valid.ok && !input.layout) {
      layout = findFreeSlot(layoutItems, spec.defaultSize);
    } else if (!valid.ok) {
      throw AppError.badRequest(valid.reason ?? '布局不合法');
    }
    if (layoutItems.some((e) => e.x < layout.x + layout.w && e.x + e.w > layout.x && e.y < layout.y + layout.h && e.y + e.h > layout.y)) {
      if (!input.layout) layout = findFreeSlot(layoutItems, spec.defaultSize);
      else throw AppError.badRequest('布局与已有组件重叠：请调整位置');
    }

    const now = nowIso();
    const row = {
      id: newId('wdg'),
      workspaceId: input.workspaceId,
      dashboardId,
      type: input.type,
      title: (input.title ?? spec.label).slice(0, 80),
      naturalLanguage: input.naturalLanguage ?? null,
      layout,
      config: input.config ?? {},
      pinnedToDesktop: input.pinnedToDesktop ?? false,
      refreshIntervalMs: input.refreshIntervalMs ?? WidgetDataSources.recommendedInterval(input.type),
      position: existing.length,
      size: layout.w >= 8 ? 'lg' : layout.w >= 5 ? 'md' : 'sm',
      dataSource: spec.dataSource,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(widgets).values(row);

    await this.db.insert(widgetDataSources).values({
      id: newId('wds'),
      widgetId: row.id,
      type: spec.dataSource,
      configJson: { widgetType: input.type, ...(row.config as Record<string, unknown>) },
      lastValue: null,
      lastRefreshedAt: null,
      lastError: null,
      createdAt: now,
    });

    eventBus.publishBuffered(EventType.WIDGET_UPDATED, { widgetId: row.id, action: 'created', dashboardId }, { workspaceId: input.workspaceId });
    logger.info('widget created', { id: row.id, type: row.type, dashboardId });
    return row as unknown as WidgetInstance;
  }

  async updateWidget(input: {
    workspaceId: string;
    widgetId: string;
    title?: string;
    config?: Record<string, unknown>;
    layout?: { x: number; y: number; w: number; h: number };
    pinnedToDesktop?: boolean;
    refreshIntervalMs?: number;
    enabled?: boolean;
  }): Promise<WidgetInstance> {
    const current = await this.getWidget(input.workspaceId, input.widgetId);
    if (input.layout) {
      const valid = validateLayout(input.layout);
      if (!valid.ok) throw AppError.badRequest(valid.reason ?? '布局不合法');
      const siblings = await this.db.select().from(widgets).where(eq(widgets.dashboardId, current.dashboardId));
      const conflicts = siblings.filter((w) => {
        if (w.id === current.id) return false;
        const l = w.layout as { x: number; y: number; w: number; h: number };
        const n = input.layout as { x: number; y: number; w: number; h: number };
        return l.x < n.x + n.w && l.x + l.w > n.x && l.y < n.y + n.h && l.y + l.h > n.y;
      });
      if (conflicts.length > 0) throw AppError.badRequest(`布局与组件 ${conflicts.map((c) => c.id).join(', ')} 重叠`);
    }
    const layout = input.layout ?? (current.layout as { x: number; y: number; w: number; h: number });
    await this.db
      .update(widgets)
      .set({
        title: input.title?.trim() || current.title,
        config: (input.config ? { ...(current.config as Record<string, unknown>), ...input.config } : current.config) as never,
        layout: layout as never,
        size: layout.w >= 8 ? 'lg' : layout.w >= 5 ? 'md' : 'sm',
        pinnedToDesktop: input.pinnedToDesktop ?? current.pinnedToDesktop,
        refreshIntervalMs: input.refreshIntervalMs ?? current.refreshIntervalMs,
        enabled: input.enabled ?? current.enabled,
        updatedAt: nowIso(),
      })
      .where(eq(widgets.id, current.id));

    eventBus.publishBuffered(EventType.WIDGET_UPDATED, { widgetId: current.id, action: 'updated' }, { workspaceId: input.workspaceId });
    return this.getWidget(input.workspaceId, current.id);
  }

  async getWidget(workspaceId: string, widgetId: string): Promise<WidgetInstance> {
    const rows = await this.db.select().from(widgets).where(eq(widgets.id, widgetId)).limit(1);
    const row = rows[0];
    if (!row || row.workspaceId !== workspaceId) throw AppError.notFound(`小组件不存在: ${widgetId}`);
    return row as unknown as WidgetInstance;
  }

  async removeWidget(workspaceId: string, widgetId: string): Promise<void> {
    await this.getWidget(workspaceId, widgetId);
    await this.db.delete(widgetDataSources).where(eq(widgetDataSources.widgetId, widgetId));
    await this.db.delete(widgets).where(eq(widgets.id, widgetId));
    eventBus.publishBuffered(EventType.WIDGET_UPDATED, { widgetId, action: 'removed' }, { workspaceId });
  }

  async setPinned(workspaceId: string, widgetId: string, pinned: boolean): Promise<WidgetInstance> {
    return this.updateWidget({ workspaceId, widgetId, pinnedToDesktop: pinned });
  }

  async listPinned(workspaceId: string): Promise<WidgetInstance[]> {
    const rows = await this.db.select().from(widgets).where(eq(widgets.workspaceId, workspaceId));
    return rows.filter((w) => w.pinnedToDesktop && w.enabled) as unknown as WidgetInstance[];
  }

  /* --------------------------- 布局 --------------------------- */

  /** 批量保存拖拽后的布局（前端 React Grid Layout 的 onLayoutChange） */
  async saveLayout(input: {
    workspaceId: string;
    dashboardId: string;
    items: { id: string; x: number; y: number; w: number; h: number }[];
    compact?: boolean;
  }): Promise<{ dashboard: Dashboard; widgets: WidgetInstance[]; issues: { id: string; reason: string }[] }> {
    const { dashboard, widgets: current } = await this.getDashboard(input.workspaceId, input.dashboardId);
    const ids = new Set(current.map((w) => w.id));
    const items: LayoutItem[] = input.items.filter((i) => ids.has(i.id));

    const finalItems = input.compact === false ? items : compact(items);
    const check = validateBoard(finalItems);
    if (!check.ok) {
      // 不静默接受非法布局：返回问题清单让前端提示用户
      throw AppError.badRequest(`布局不合法：${check.issues.map((i) => `${i.id} ${i.reason}`).join('；')}`);
    }

    // 保存快照（保留最近 20 个）→ 支持布局回滚
    const history = [...((dashboard.layoutHistory as unknown as { at: string; layout: Record<string, unknown> }[]) ?? [])];
    history.push(snapshotLayout(current.map((w) => ({ id: w.id, ...(w.layout as { x: number; y: number; w: number; h: number }) }))) as unknown as { at: string; layout: Record<string, unknown> });
    const trimmed = history.slice(-20);

    for (const item of finalItems) {
      await this.db.update(widgets).set({ layout: { x: item.x, y: item.y, w: item.w, h: item.h } as never, updatedAt: nowIso() }).where(eq(widgets.id, item.id));
    }
    const layoutMap: Record<string, unknown> = {};
    for (const i of finalItems) layoutMap[i.id] = { x: i.x, y: i.y, w: i.w, h: i.h };
    await this.db
      .update(dashboards)
      .set({ layoutJson: layoutMap as never, layoutHistory: trimmed as never, updatedAt: nowIso() })
      .where(eq(dashboards.id, dashboard.id));

    eventBus.publishBuffered(EventType.DASHBOARD_UPDATED, { dashboardId: dashboard.id, widgets: finalItems.length }, { workspaceId: input.workspaceId });
    const fresh = await this.getDashboard(input.workspaceId, input.dashboardId);
    return { ...fresh, issues: [] };
  }

  /** 布局回滚：恢复上一版（或指定索引） */
  async rollbackLayout(workspaceId: string, dashboardId: string, index?: number): Promise<{ dashboard: Dashboard; widgets: WidgetInstance[] }> {
    const { dashboard, widgets: current } = await this.getDashboard(workspaceId, dashboardId);
    const history = ((dashboard.layoutHistory as unknown as { at: string; layout: Record<string, unknown> }[]) ?? []).slice();
    if (history.length === 0) throw AppError.badRequest('没有可回滚的布局历史（保存两次布局后才有历史）');
    const target = index === undefined ? history[history.length - 1] : history[Math.max(0, Math.min(index, history.length - 1))];
    if (!target) throw AppError.badRequest('指定的历史版本不存在');

    const restored = applySnapshot(
      current.map((w) => ({ id: w.id, ...(w.layout as { x: number; y: number; w: number; h: number }) })),
      target as unknown as { at: string; layout: Record<string, { x: number; y: number; w: number; h: number }> },
    );
    for (const item of restored) {
      await this.db.update(widgets).set({ layout: { x: item.x, y: item.y, w: item.w, h: item.h } as never, updatedAt: nowIso() }).where(eq(widgets.id, item.id));
    }
    // 回滚后把当前版本也压入历史，保证可以「再回滚回去」
    history.push(snapshotLayout(current.map((w) => ({ id: w.id, ...(w.layout as { x: number; y: number; w: number; h: number }) }))) as unknown as { at: string; layout: Record<string, unknown> });
    await this.db
      .update(dashboards)
      .set({ layoutHistory: history.slice(-20) as never, updatedAt: nowIso() })
      .where(eq(dashboards.id, dashboard.id));

    logger.info('layout rolled back', { dashboardId, at: target.at });
    return this.getDashboard(workspaceId, dashboardId);
  }

  /* --------------------------- 刷新 --------------------------- */

  /** 刷新单个组件（结果写缓存 + 推事件） */
  async refreshWidget(input: { workspaceId: string; widgetId: string }): Promise<WidgetRenderData> {
    const widget = await this.getWidget(input.workspaceId, input.widgetId);
    const data = await this.sources.fetch({
      workspaceId: input.workspaceId,
      widgetId: widget.id,
      type: widget.type as WidgetKind,
      config: (widget.config ?? {}) as Record<string, unknown>,
    });

    const rows = await this.db.select().from(widgetDataSources).where(eq(widgetDataSources.widgetId, widget.id)).limit(1);
    const now = nowIso();
    if (rows[0]) {
      await this.db
        .update(widgetDataSources)
        .set({
          lastValue: data.payload as never,
          lastRefreshedAt: now,
          lastError: data.error ?? null,
          configJson: { widgetType: widget.type, ...(widget.config as Record<string, unknown>) } as never,
        })
        .where(eq(widgetDataSources.id, rows[0].id));
    } else {
      await this.db.insert(widgetDataSources).values({
        id: newId('wds'),
        widgetId: widget.id,
        type: widget.dataSource as 'local-db',
        configJson: { widgetType: widget.type } as never,
        lastValue: data.payload as never,
        lastRefreshedAt: now,
        lastError: data.error ?? null,
        createdAt: now,
      });
    }

    eventBus.publishBuffered(
      EventType.WIDGET_REFRESHED,
      { widgetId: widget.id, type: widget.type, degraded: data.degraded, error: data.error ?? null },
      { workspaceId: input.workspaceId },
    );
    return data;
  }

  /** 刷新整个看板（并发 + 单点失败隔离） */
  async refreshDashboard(input: { workspaceId: string; dashboardId: string }): Promise<{ results: WidgetRenderData[]; degraded: number }> {
    const { widgets: list } = await this.getDashboard(input.workspaceId, input.dashboardId);
    const enabled = list.filter((w) => w.enabled);
    const settled = await Promise.all(
      enabled.map(async (w) => {
        try {
          return await this.refreshWidget({ workspaceId: input.workspaceId, widgetId: w.id });
        } catch (e) {
          return {
            widgetId: w.id,
            type: w.type as WidgetKind,
            refreshedAt: nowIso(),
            degraded: true,
            error: e instanceof Error ? e.message : String(e),
            payload: null,
          };
        }
      }),
    );
    return { results: settled, degraded: settled.filter((r) => r.degraded).length };
  }

  /** 读缓存（首屏用，避免所有组件同时打数据源） */
  async cachedWidgetData(workspaceId: string, dashboardId: string): Promise<WidgetRenderData[]> {
    const { widgets: list } = await this.getDashboard(workspaceId, dashboardId);
    const out: WidgetRenderData[] = [];
    for (const w of list) {
      const rows = await this.db
        .select()
        .from(widgetDataSources)
        .where(and(eq(widgetDataSources.widgetId, w.id)))
        .limit(1);
      const cache = rows[0];
      out.push({
        widgetId: w.id,
        type: w.type as WidgetKind,
        refreshedAt: cache?.lastRefreshedAt ?? w.createdAt,
        degraded: Boolean(cache?.lastError),
        error: cache?.lastError ?? undefined,
        payload: cache?.lastValue ?? null,
      });
    }
    return out;
  }
}

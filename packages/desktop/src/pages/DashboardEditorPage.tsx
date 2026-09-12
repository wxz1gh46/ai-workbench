import { useCallback, useEffect, useState } from 'react';
import { Responsive, WidthProvider, type Layout } from 'react-grid-layout';
import type { Dashboard, WidgetInstance, WidgetRenderData, WidgetSpec } from '@ai/shared';
import { api } from '@/lib/api';
import { describeError, useAppStore } from '@/stores/app-store';
import { Badge, Button, Empty, Panel } from '@/components/ui';
import { triggerConfirm } from '@/lib/confirm';
import { WidgetCard } from '@/components/phase3/WidgetCard';
import { WidgetGallery } from '@/components/phase3/WidgetGallery';

const ResponsiveGrid = WidthProvider(Responsive);

/**
 * 看板编辑器（Step 7）。
 *
 * 技术要点：
 *   - react-grid-layout 负责拖拽/缩放，onLayoutChange 后防抖保存到服务端；
 *   - 服务端会做布局校验（重叠/越界），因此这里要处理「保存失败」并回滚 UI；
 *   - 定时刷新（默认 15s）只重取「已缓存数据」，不触发远端查询，
 *     避免所有组件同时打数据源（真正的刷新由服务端 RefreshScheduler 按各自间隔驱动）。
 */
export function DashboardEditorPage() {
  const workspace = useAppStore((s) => s.workspace);
  const pushToast = useAppStore((s) => s.pushToast);

  const [boards, setBoards] = useState<Dashboard[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [widgets, setWidgets] = useState<WidgetInstance[]>([]);
  const [data, setData] = useState<Record<string, WidgetRenderData>>({});
  const [specs, setSpecs] = useState<WidgetSpec[]>([]);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  const loadBoards = useCallback(async () => {
    if (!workspace) return;
    const res = await api.listDashboards(workspace.id);
    setBoards(res.dashboards);
    setSelected((prev) => prev ?? res.dashboards[0]?.id ?? null);
  }, [workspace]);

  const loadBoard = useCallback(async () => {
    if (!workspace || !selected) return;
    const res = await api.getDashboardV3(selected, workspace.id);
    setWidgets(res.widgets);
    const map: Record<string, WidgetRenderData> = {};
    for (const d of res.data) map[d.widgetId] = d;
    setData(map);
  }, [workspace, selected]);

  useEffect(() => {
    void api.widgetRegistry().then((r) => setSpecs(r.widgets)).catch(() => undefined);
  }, []);

  useEffect(() => {
    void loadBoards().catch(() => undefined);
  }, [loadBoards]);

  useEffect(() => {
    void loadBoard().catch(() => undefined);
  }, [loadBoard]);

  // 轮询刷新：只重读缓存（服务端 RefreshScheduler 负责真正刷新）
  useEffect(() => {
    if (!workspace || !selected) return;
    const timer = setInterval(() => {
      void api
        .getDashboardV3(selected, workspace.id)
        .then((res) => {
          const map: Record<string, WidgetRenderData> = {};
          for (const d of res.data) map[d.widgetId] = d;
          setData(map);
        })
        .catch(() => undefined);
    }, 15_000);
    return () => clearInterval(timer);
  }, [workspace, selected]);

  async function guard(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  const persistLayout = useCallback(
    async (layout: Layout[]) => {
      if (!workspace || !selected) return;
      try {
        const res = await api.saveDashboardLayout(
          selected,
          workspace.id,
          layout.map((l) => ({ id: l.i, x: l.x, y: l.y, w: l.w, h: l.h })),
        );
        setWidgets(res.widgets);
        setDirty(false);
      } catch (e) {
        pushToast({ level: 'error', message: `布局保存失败：${describeError(e)}` });
        // 保存失败必须回滚 UI，否则用户以为已经保存了
        await loadBoard();
      }
    },
    [workspace, selected, pushToast, loadBoard],
  );

  if (!workspace) return <Empty>正在加载工作区…</Empty>;

  const layout: Layout[] = widgets.map((w) => ({ i: w.id, x: w.layout.x, y: w.layout.y, w: w.layout.w, h: w.layout.h, minW: 2, minH: 2 }));

  return (
    <div className="grid h-full grid-cols-[260px_1fr] gap-3">
      <div className="flex min-h-0 flex-col gap-3">
        <Panel title="看板">
          <div className="space-y-2">
            <div className="flex gap-1">
              <select value={selected ?? ''} onChange={(e) => setSelected(e.target.value)} className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-[11px]">
                {boards.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
              <Button
                disabled={busy}
                onClick={() =>
                  guard(async () => {
                    const name = `看板 ${boards.length + 1}`;
                    const r = await api.createDashboard({ workspaceId: workspace.id, name });
                    await loadBoards();
                    setSelected(r.dashboard.id);
                  })
                }
              >
                新建
              </Button>
            </div>
            <div className="flex gap-1">
              <Button disabled={busy || dirty} onClick={() => void rollbackLayout()}>
                布局回滚
              </Button>
              <Button
                disabled={busy || !selected}
                onClick={() =>
                  guard(async () => {
                    const r = await api.refreshDashboard(selected as string, workspace.id);
                    await loadBoard();
                    pushToast({ level: r.degraded > 0 ? 'warn' : 'success', message: `已刷新 ${r.results.length} 个组件${r.degraded > 0 ? `（${r.degraded} 个降级）` : ''}` });
                  })
                }
              >
                刷新全部
              </Button>
            </div>
            {dirty && <p className="text-[10px] text-amber-400">布局已修改，正在保存…</p>}
          </div>
        </Panel>

        <Panel title="组件库" className="min-h-0 flex-1">
          <WidgetGallery
            specs={specs}
            busy={busy}
            onCreateFromNL={(text) =>
              guard(async () => {
                const r = await api.createWidgetV3(selected as string, workspace.id, { naturalLanguage: text });
                await loadBoard();
                pushToast({
                  level: r.inference?.degraded ? 'warn' : 'success',
                  message: r.inference ? `已添加「${r.widget.title}」（识别类型 ${r.widget.type}，置信度 ${(r.inference.confidence * 100).toFixed(0)}%）` : '已添加组件',
                });
              })
            }
            onCreateByType={(type) =>
              guard(async () => {
                await api.createWidgetV3(selected as string, workspace.id, { type });
                await loadBoard();
                pushToast({ level: 'success', message: '已添加组件' });
              })
            }
          />
        </Panel>
      </div>

      <Panel
        title={`看板编辑（${widgets.length} 个组件）`}
        actions={<Badge tone="info">拖拽可调整位置与大小</Badge>}
      >
        {widgets.length === 0 ? (
          <Empty>还没有小组件。用左侧「自然语言」或「组件库」添加。</Empty>
        ) : (
          <ResponsiveGrid
            className="layout"
            layouts={{ lg: layout, md: layout, sm: layout }}
            breakpoints={{ lg: 1200, md: 900, sm: 600 }}
            cols={{ lg: 12, md: 12, sm: 12 }}
            rowHeight={56}
            margin={[10, 10]}
            draggableHandle="header"
            onLayoutChange={(l) => {
              setDirty(true);
              void persistLayout(l);
            }}
          >
            {widgets.map((w) => (
              <div key={w.id} data-grid={{ i: w.id, x: w.layout.x, y: w.layout.y, w: w.layout.w, h: w.layout.h, minW: 2, minH: 2 }}>
                <WidgetCard
                  widget={w}
                  data={data[w.id] ?? null}
                  busy={busy}
                  onRefresh={() =>
                    guard(async () => {
                      const d = await api.refreshWidgetV3(w.id, workspace.id);
                      setData((prev) => ({ ...prev, [w.id]: d }));
                      if (d.degraded && d.error) pushToast({ level: 'warn', message: d.error });
                    })
                  }
                  onTogglePin={() =>
                    guard(async () => {
                      const r = await api.pinWidget(w.id, workspace.id, !w.pinnedToDesktop);
                      setWidgets((prev) => prev.map((x) => (x.id === w.id ? r.widget : x)));
                      pushToast({ level: 'success', message: r.widget.pinnedToDesktop ? '已固定到桌面' : '已取消固定' });
                    })
                  }
                  onDelete={() => {
                    if (!triggerConfirm(`确认删除小组件「${w.title}」？`)) return;
                    void guard(async () => {
                      await api.deleteWidgetV3(w.id, workspace.id);
                      await loadBoard();
                    });
                  }}
                />
              </div>
            ))}
          </ResponsiveGrid>
        )}
      </Panel>
    </div>
  );

  async function rollbackLayout() {
    if (!workspace || !selected) return;
    await guard(async () => {
      const res = await api.rollbackDashboardLayout(selected, workspace.id);
      setWidgets(res.widgets);
      pushToast({ level: 'success', message: '布局已回滚到上一版' });
    });
  }
}

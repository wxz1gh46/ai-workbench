import { useEffect, useState } from 'react';
import GridLayout, { type Layout } from 'react-grid-layout';
import type { Widget } from '@ai/shared';
import { api } from '@/lib/api';
import { describeError, useAppStore } from '@/stores/app-store';
import { Badge, Button, Empty, Panel } from '@/components/ui';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

/** 看板：自然语言创建小组件 + 拖拽布局，布局变更即时持久化 */
export function DashboardPage() {
  const workspace = useAppStore((s) => s.workspace);
  const tasks = useAppStore((s) => s.tasks);
  const agents = useAppStore((s) => s.agents);
  const agentStatus = useAppStore((s) => s.agentStatus);
  const logs = useAppStore((s) => s.logs);
  const pushToast = useAppStore((s) => s.pushToast);
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [nl, setNl] = useState('');

  useEffect(() => {
    if (!workspace) return;
    void api
      .listWidgets(workspace.id)
      .then((r) => setWidgets(r.widgets))
      .catch(() => undefined);
  }, [workspace]);

  async function create() {
    if (!workspace || !nl.trim()) return;
    try {
      const { widget } = await api.createWidget(workspace.id, nl.trim());
      setWidgets((w) => [...w, widget]);
      setNl('');
      pushToast({ level: 'success', message: `已创建小组件：${widget.title}` });
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    }
  }

  async function remove(id: string) {
    await api.removeWidget(id);
    setWidgets((w) => w.filter((x) => x.id !== id));
  }

  function onLayoutChange(layout: Layout[]) {
    setWidgets((ws) =>
      ws.map((w) => {
        const l = layout.find((x) => x.i === w.id);
        return l ? { ...w, layout: { x: l.x, y: l.y, w: l.w, h: l.h } } : w;
      }),
    );
    for (const l of layout) void api.moveWidget(l.i, { x: l.x, y: l.y, w: l.w, h: l.h }).catch(() => undefined);
  }

  return (
    <div className="flex h-full flex-col gap-3">
      <Panel title="用一句话创建小组件">
        <div className="flex gap-2">
          <input
            value={nl}
            onChange={(e) => setNl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void create()}
            placeholder="例如：显示所有 Agent 的运行状态 / 看网站监控 / 任务进度"
            className="flex-1 rounded border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-brand"
          />
          <Button variant="primary" onClick={() => void create()} disabled={!nl.trim()}>
            创建
          </Button>
        </div>
      </Panel>

      <Panel title="看板" className="min-h-0 flex-1">
        {widgets.length === 0 ? (
          <Empty>还没有小组件。用上面的输入框描述你想要的卡片。</Empty>
        ) : (
          <GridLayout
            className="layout"
            layout={widgets.map((w) => ({ i: w.id, ...w.layout, minW: 3, minH: 3 }))}
            cols={12}
            rowHeight={48}
            width={1200}
            onLayoutChange={onLayoutChange}
            draggableHandle=".drag-handle"
          >
            {widgets.map((w) => (
              <div key={w.id} className="overflow-hidden rounded border border-border bg-panel">
                <div className="drag-handle flex cursor-move items-center justify-between border-b border-border px-2 py-1">
                  <span className="text-xs">{w.title}</span>
                  <span className="flex items-center gap-1">
                    <Badge>{w.type}</Badge>
                    <Button variant="ghost" onClick={() => void remove(w.id)}>
                      ×
                    </Button>
                  </span>
                </div>
                <div className="h-[calc(100%-26px)] overflow-auto p-2 text-xs text-muted">
                  {renderWidget(w, { tasks, agents, agentStatus, logs })}
                </div>
              </div>
            ))}
          </GridLayout>
        )}
      </Panel>
    </div>
  );
}

interface WidgetData {
  tasks: { id: string; title: string; status: string; progress: number }[];
  agents: { id: string; name: string; role: string }[];
  agentStatus: Record<string, { status: string; currentTaskId: string | null }>;
  logs: { level: string; msg: string; at: string }[];
}

function renderWidget(w: Widget, data: WidgetData) {
  switch (w.type) {
    case 'task-progress':
      return data.tasks.length === 0 ? (
        <span>暂无任务</span>
      ) : (
        <ul className="space-y-1">
          {data.tasks.slice(0, 8).map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2">
              <span className="truncate">{t.title}</span>
              <span className={t.status === 'succeeded' ? 'text-emerald-400' : 'text-brand'}>{t.status}</span>
            </li>
          ))}
        </ul>
      );
    case 'agent-status':
      return (
        <ul className="space-y-1">
          {data.agents.map((a) => {
            const live = data.agentStatus[a.id];
            const status = live?.status ?? 'idle';
            return (
              <li key={a.id} className="flex items-center justify-between gap-2">
                <span className="truncate">{a.name}</span>
                <span className={status === 'busy' ? 'text-brand' : 'text-muted'}>{status}</span>
              </li>
            );
          })}
        </ul>
      );
    case 'website-monitor':
      return <span>Phase 3 交付：部署后在此显示可用性、响应时间与最近部署记录。</span>;
    case 'schedule-calendar':
      return <span>打开「定时任务」页查看 cron 调度与执行日志。</span>;
    case 'file-generator':
      return <span>打开「文件」页生成 docx / xlsx / pptx / pdf。</span>;
    case 'db-query':
      return <span>Phase 3 交付：配置 Neon / Supabase 后可直接跑查询。</span>;
    case 'prompt-shortcut':
      return <span>打开「提示词」页进行生成与优化。</span>;
    default:
      return <span>{w.naturalLanguage ?? '未知小组件'}</span>;
  }
}

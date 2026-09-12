import type { WidgetInstance, WidgetRenderData } from '@ai/shared';
import { Badge, Button } from '@/components/ui';

/**
 * 单个小组件卡片。
 *
 * 数据渲染策略：按 type 分派到具体的渲染器，每个渲染器只关心自己的 payload 形状。
 * 未知 payload / degraded 时明确显示原因，而不是渲染空白（用户会以为组件坏了）。
 */
export function WidgetCard({
  widget,
  data,
  onRefresh,
  onDelete,
  onTogglePin,
  busy,
}: {
  widget: WidgetInstance;
  data: WidgetRenderData | null;
  onRefresh: () => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  onTogglePin: () => void | Promise<void>;
  busy?: boolean;
}) {
  return (
    <div className="flex h-full flex-col rounded border border-border bg-panel">
      <header className="flex items-center justify-between gap-1 border-b border-border px-2 py-1">
        <div className="min-w-0">
          <div className="truncate text-[11px] font-medium">{widget.title}</div>
          <div className="text-[9px] text-muted">{widget.type}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {widget.pinnedToDesktop && <Badge tone="info">已固定</Badge>}
          <Button variant="ghost" title="刷新" onClick={() => void onRefresh()} disabled={busy}>
            ↻
          </Button>
          <Button variant="ghost" title={widget.pinnedToDesktop ? '取消固定' : '固定到桌面'} onClick={() => void onTogglePin()} disabled={busy}>
            {widget.pinnedToDesktop ? '★' : '☆'}
          </Button>
          <Button variant="ghost" title="删除" onClick={() => void onDelete()} disabled={busy}>
            ✕
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-2 text-[11px]">
        {!data ? (
          <p className="text-muted">尚未加载…</p>
        ) : data.degraded && data.error ? (
          <div className="space-y-1">
            <Badge tone="warn">降级</Badge>
            <p className="text-[10px] text-amber-300">{data.error}</p>
          </div>
        ) : (
          <WidgetBody type={widget.type} payload={data.payload} />
        )}
      </div>
      {data && (
        <footer className="border-t border-border px-2 py-0.5 text-[9px] text-muted">
          {new Date(data.refreshedAt).toLocaleTimeString()}
          {data.degraded ? ' · 降级' : ''}
        </footer>
      )}
    </div>
  );
}

function WidgetBody({ type, payload }: { type: string; payload: unknown }) {
  switch (type) {
    case 'task-progress':
      return <TaskProgress payload={payload as TaskProgressPayload} />;
    case 'agent-status':
      return <AgentStatus payload={payload as AgentStatusPayload} />;
    case 'file-list':
      return <FileList payload={payload as FileListPayload} />;
    case 'website-status':
      return <WebsiteStatus payload={payload as WebsiteStatusPayload} />;
    case 'schedule-status':
      return <ScheduleStatus payload={payload as ScheduleStatusPayload} />;
    case 'data-query':
      return <DataQuery payload={payload as DataQueryPayload} />;
    case 'prompt-template':
      return <PromptList payload={payload as PromptListPayload} />;
    default:
      return <pre className="text-[10px]">{JSON.stringify(payload, null, 2)}</pre>;
  }
}

interface TaskProgressPayload {
  goal: { id: string; title: string; status: string; progress: number } | null;
  total: number;
  done: number;
  running: number;
  blocked: number;
  progress: number;
  blockers?: { id: string; title: string; error: string | null }[];
}

function TaskProgress({ payload }: { payload: TaskProgressPayload }) {
  if (!payload?.goal) return <p className="text-muted">暂无目标</p>;
  return (
    <div className="space-y-1">
      <div className="truncate">{payload.goal.title}</div>
      <div className="h-1.5 w-full overflow-hidden rounded bg-bg">
        <div className="h-full bg-brand" style={{ width: `${payload.progress}%` }} />
      </div>
      <div className="flex gap-2 text-[10px] text-muted">
        <span>总计 {payload.total}</span>
        <span className="text-emerald-400">完成 {payload.done}</span>
        <span className="text-brand">进行 {payload.running}</span>
        <span className="text-rose-400">阻塞 {payload.blocked}</span>
      </div>
      {(payload.blockers?.length ?? 0) > 0 && (
        <ul className="space-y-0.5 text-[10px] text-rose-300">
          {payload.blockers?.slice(0, 3).map((b) => (
            <li key={b.id} className="truncate">
              ⚠ {b.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface AgentStatusPayload {
  total: number;
  busy: number;
  idle: number;
  error: number;
  agents: { id: string; name: string; role: string; status: string }[];
}

function AgentStatus({ payload }: { payload: AgentStatusPayload }) {
  if (!payload?.agents) return <p className="text-muted">暂无 Agent</p>;
  const tone = (s: string) => (s === 'busy' ? 'text-brand' : s === 'error' ? 'text-rose-400' : 'text-muted');
  return (
    <div className="space-y-1">
      <div className="flex gap-2 text-[10px] text-muted">
        <span>共 {payload.total}</span>
        <span className="text-brand">忙碌 {payload.busy}</span>
        <span>空闲 {payload.idle}</span>
        {payload.error > 0 && <span className="text-rose-400">异常 {payload.error}</span>}
      </div>
      <ul className="space-y-0.5">
        {payload.agents.slice(0, 6).map((a) => (
          <li key={a.id} className="flex items-center justify-between gap-2">
            <span className="truncate">
              {a.name} <span className="text-[9px] text-muted">{a.role}</span>
            </span>
            <span className={`text-[9px] ${tone(a.status)}`}>{a.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface FileListPayload {
  total: number;
  files: { id: string; name: string; path: string; size: number; version: number }[];
}

function FileList({ payload }: { payload: FileListPayload }) {
  if (!payload?.files) return <p className="text-muted">暂无文件</p>;
  return (
    <ul className="space-y-0.5">
      {payload.files.map((f) => (
        <li key={f.id} className="flex items-center justify-between gap-2">
          <span className="truncate" title={f.path}>
            {f.name}
          </span>
          <span className="shrink-0 text-[9px] text-muted">
            v{f.version} · {Math.max(1, Math.round(f.size / 1024))}KB
          </span>
        </li>
      ))}
      {payload.files.length === 0 && <li className="text-muted">暂无文件</li>}
    </ul>
  );
}

interface WebsiteStatusPayload {
  projects: { id: string; name: string; url: string | null; status: string; deployStatus: string; provider: string | null }[];
}

function WebsiteStatus({ payload }: { payload: WebsiteStatusPayload }) {
  if (!payload?.projects?.length) return <p className="text-muted">还没有网站项目</p>;
  const tone = (s: string) => (s === 'deployed' ? 'ok' : s === 'failed' ? 'error' : 'warn');
  return (
    <ul className="space-y-1">
      {payload.projects.map((p) => (
        <li key={p.id} className="rounded border border-border bg-bg p-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate">{p.name}</span>
            <Badge tone={tone(p.deployStatus) as 'ok'}>{p.deployStatus}</Badge>
          </div>
          {p.url && (
            <a href={p.url} target="_blank" rel="noreferrer" className="block truncate text-[10px] text-brand hover:underline">
              {p.url}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

interface ScheduleStatusPayload {
  total: number;
  schedules: { id: string; name: string; expression: string; timezone: string; enabled: boolean; nextRunAt: string | null; lastStatus: string }[];
}

function ScheduleStatus({ payload }: { payload: ScheduleStatusPayload }) {
  if (!payload?.schedules?.length) return <p className="text-muted">还没有定时任务</p>;
  return (
    <ul className="space-y-1">
      {payload.schedules.map((s) => (
        <li key={s.id} className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate">{s.name}</div>
            <div className="font-mono text-[9px] text-muted">
              {s.expression} · {s.timezone}
            </div>
          </div>
          <div className="shrink-0 text-right text-[9px]">
            <Badge tone={s.enabled ? 'ok' : 'default'}>{s.enabled ? '启用' : '停用'}</Badge>
            <div className="text-muted">
              {s.nextRunAt ? new Date(s.nextRunAt).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

interface DataQueryPayload {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  ms: number;
}

function DataQuery({ payload }: { payload: DataQueryPayload }) {
  if (!payload?.columns) return <p className="text-muted">未返回数据</p>;
  return (
    <div className="space-y-1">
      <div className="text-[9px] text-muted">
        {payload.rowCount} 行 · {payload.ms}ms {payload.truncated ? '· 已截断' : ''}
      </div>
      <div className="overflow-auto">
        <table className="w-full text-[10px]">
          <thead>
            <tr className="text-muted">
              {payload.columns.map((c) => (
                <th key={c} className="whitespace-nowrap px-1 text-left">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="font-mono">
            {payload.rows.slice(0, 10).map((r, i) => (
              <tr key={i}>
                {payload.columns.map((c) => (
                  <td key={c} className="max-w-[140px] truncate px-1">
                    {String(r[c] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface PromptListPayload {
  total: number;
  templates: { id: string; name: string; tags: string[] }[];
}

function PromptList({ payload }: { payload: PromptListPayload }) {
  if (!payload?.templates?.length) return <p className="text-muted">还没有提示词模板</p>;
  return (
    <ul className="space-y-0.5">
      {payload.templates.map((t) => (
        <li key={t.id} className="truncate">
          {t.name} {t.tags.length > 0 && <span className="text-[9px] text-muted">#{t.tags.join(' #')}</span>}
        </li>
      ))}
    </ul>
  );
}

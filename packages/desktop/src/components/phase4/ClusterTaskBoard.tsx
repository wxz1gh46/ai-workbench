import type { ClusterTaskInfo } from '@ai/shared';
import { Badge, Empty } from '@/components/ui';

/** 集群任务看板：按状态分列展示，失败任务必须能直接看到错误原因。 */
const COLUMNS: { key: ClusterTaskInfo['status']; label: string }[] = [
  { key: 'queued', label: '排队' },
  { key: 'running', label: '执行中' },
  { key: 'succeeded', label: '成功' },
  { key: 'failed', label: '失败' },
  { key: 'cancelled', label: '已取消' },
];

export function ClusterTaskBoard({ tasks, onCancel }: { tasks: ClusterTaskInfo[]; onCancel?: (id: string) => void }) {
  if (tasks.length === 0) return <Empty>还没有集群任务。分发一个分片任务后会出现在这里。</Empty>;
  return (
    <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {COLUMNS.map((col) => {
        const items = tasks.filter((t) => t.status === col.key);
        return (
          <section key={col.key} className="rounded-lg border border-border bg-panel p-2">
            <header className="mb-1 flex items-center justify-between text-[11px]">
              <span className="text-fg">{col.label}</span>
              <Badge tone="default">{items.length}</Badge>
            </header>
            <ul className="space-y-1">
              {items.slice(0, 20).map((t) => (
                <li key={t.id} className="rounded border border-border bg-bg px-1.5 py-1 text-[10px]">
                  <div className="truncate text-fg">{t.taskId ?? t.id}</div>
                  <div className="text-muted">
                    节点 {t.assignedNodeId ? t.assignedNodeId.slice(-6) : '—'}
                  </div>
                  {t.error && <div className="text-rose-300">{t.error.slice(0, 40)}</div>}
                  {onCancel && (t.status === 'queued' || t.status === 'running') && (
                    <button type="button" className="mt-0.5 text-rose-300 underline" onClick={() => onCancel(t.id)}>
                      取消
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

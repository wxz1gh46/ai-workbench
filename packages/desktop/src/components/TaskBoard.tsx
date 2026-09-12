import type { TaskBoard as TaskBoardData, TaskBoardCard } from '@ai/shared';
import { Badge } from '@/components/ui';
import { triggerConfirm } from '@/lib/confirm';
import { truncate } from '@/lib/utils';

const COLUMNS: { key: keyof TaskBoardData['columns']; label: string }[] = [
  { key: 'todo', label: '待办' },
  { key: 'running', label: '进行中' },
  { key: 'blocked', label: '阻塞' },
  { key: 'done', label: '已完成' },
];

/** 任务看板（Step 4 UI）：待办 / 进行中 / 阻塞 / 已完成，支持取消与改派 */
export function TaskBoard({
  board,
  agents,
  onCancel,
  onAssign,
}: {
  board: TaskBoardData;
  agents: { id: string; name: string; role: string }[];
  onCancel: (taskId: string) => void;
  onAssign: (taskId: string, agentId: string, preempt: boolean) => void;
}) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {COLUMNS.map((col) => {
        const cards = (board.columns[col.key] ?? []) as unknown as TaskBoardCard[];
        return (
          <div key={col.key} className="flex min-h-0 flex-col rounded border border-border bg-bg/30">
            <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
              <span className="text-[11px] font-medium">{col.label}</span>
              <span className="text-[10px] text-muted">{cards.length}</span>
            </div>
            <ul className="min-h-[60px] flex-1 space-y-1 p-1.5">
              {cards.length === 0 && <li className="py-2 text-center text-[10px] text-muted">空</li>}
              {cards.map((c) => (
                <li key={c.taskId} className="rounded border border-border bg-panel p-1.5">
                  <div className="flex items-start justify-between gap-1">
                    <span className="text-[11px] leading-tight">{truncate(c.title, 34)}</span>
                    <Badge tone={c.status === 'succeeded' ? 'ok' : c.status === 'blocked' ? 'warn' : c.status === 'failed' ? 'error' : 'info'}>{c.status}</Badge>
                  </div>
                  <div className="mt-1 space-y-0.5 text-[10px] text-muted">
                    <div>角色：{c.agentRole}</div>
                    <div>执行：{c.assigneeName ?? c.assigneeAgentId ?? '未分配'}</div>
                    <div>
                      尝试 {c.attempts}/{c.maxAttempts}
                      {c.tokensUsed ? ` · ${c.tokensUsed} token` : ''}
                    </div>
                    {c.blockedReason && <div className="text-amber-400">原因：{truncate(c.blockedReason, 40)}</div>}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {col.key !== 'done' && (
                      <button
                        className="rounded border border-border px-1.5 py-0.5 text-[10px] hover:border-rose-500/50 hover:text-rose-300"
                        onClick={() => {
                          if (triggerConfirm(`确认取消任务「${c.title}」？`)) onCancel(c.taskId);
                        }}
                      >
                        取消
                      </button>
                    )}
                    {agents.slice(0, 3).map((a) => (
                      <button
                        key={a.id}
                        title={`改派给 ${a.name}`}
                        className="rounded border border-border px-1.5 py-0.5 text-[10px] hover:border-brand/50 hover:text-brand"
                        onClick={() => {
                          const preempt = col.key === 'running';
                          if (!preempt || triggerConfirm(`任务正在执行，确认抢占并改派给「${a.name}」？`)) {
                            onAssign(c.taskId, a.id, preempt);
                          }
                        }}
                      >
                        →{truncate(a.role, 8)}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

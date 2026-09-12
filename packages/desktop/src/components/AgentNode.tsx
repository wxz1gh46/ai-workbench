import type { Agent, AgentMessage } from '@ai/shared';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/utils';

const STATUS_TONE: Record<string, 'ok' | 'info' | 'error' | 'default'> = {
  idle: 'ok',
  busy: 'info',
  error: 'error',
  offline: 'default',
};

/**
 * Agent 节点图（Step 3/4 UI）。
 * 展示角色、状态、当前任务、所在节点，以及该 Agent 的最近消息（消息流）。
 */
export function AgentNode({
  agent,
  status,
  currentTaskTitle,
  messages,
  selected,
  onSelect,
}: {
  agent: Agent;
  status: Agent['status'];
  currentTaskTitle: string | null;
  messages: AgentMessage[];
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col gap-1 rounded border px-2 py-2 text-left transition-colors',
        selected ? 'border-brand bg-brand/10' : status === 'busy' ? 'border-brand/50 bg-brand/5' : 'border-border hover:border-brand/40',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium">{agent.name}</span>
        <Badge tone={STATUS_TONE[status] ?? 'default'}>{status}</Badge>
      </div>
      <div className="text-[10px] text-muted">角色：{agent.role}</div>
      <div className="truncate text-[10px] text-muted" title={currentTaskTitle ?? '空闲'}>
        当前任务：{currentTaskTitle ?? '空闲'}
      </div>
      {agent.clusterNode && <div className="text-[10px] text-muted">节点：{agent.clusterNode}</div>}
      {agent.model && <div className="text-[10px] text-muted">模型：{agent.model}</div>}
      {messages.length > 0 && (
        <div className="mt-0.5 space-y-0.5 border-t border-border pt-1">
          {messages.slice(-2).map((m) => (
            <div key={m.id} className="truncate text-[10px] text-muted" title={m.content || m.topic}>
              <span className="text-brand/80">›</span> {m.content || m.topic}
            </div>
          ))}
        </div>
      )}
    </button>
  );
}

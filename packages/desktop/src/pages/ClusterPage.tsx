import { useAppStore } from '@/stores/app-store';
import { Badge, Empty, Panel } from '@/components/ui';

/**
 * Agent 集群视图。
 * Phase 1 展示稳定的「节点 + 状态 + 当前任务 + 事件流」；
 * Phase 4 的分布式集群（跨机调度、实验性降级）在此页扩展。
 */
export function ClusterPage() {
  const agents = useAppStore((s) => s.agents);
  const agentStatus = useAppStore((s) => s.agentStatus);
  const tasks = useAppStore((s) => s.tasks);
  const logs = useAppStore((s) => s.logs);

  return (
    <div className="grid h-full grid-cols-[1fr_360px] gap-3">
      <Panel title={`Agent 节点（${agents.length}）`} actions={<Badge tone="info">集群模式 Phase 4 交付</Badge>}>
        {agents.length === 0 ? (
          <Empty>暂无 Agent</Empty>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {agents.map((a) => {
              const live = agentStatus[a.id];
              const status = live?.status ?? a.status;
              const task = tasks.find((t) => t.id === (live?.currentTaskId ?? a.currentTaskId));
              return (
                <div
                  key={a.id}
                  className={`rounded border px-2 py-2 ${status === 'busy' ? 'border-brand/60 bg-brand/5' : 'border-border'}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">{a.name}</span>
                    <Badge tone={status === 'busy' ? 'info' : status === 'error' ? 'error' : 'ok'}>{status}</Badge>
                  </div>
                  <div className="mt-1 text-[10px] text-muted">角色：{a.role}</div>
                  <div className="text-[10px] text-muted">
                    当前任务：{task ? task.title : '空闲'}
                  </div>
                  {a.clusterNode && <div className="text-[10px] text-muted">节点：{a.clusterNode}</div>}
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <Panel title="实时事件流">
        {logs.length === 0 ? (
          <Empty>暂无事件</Empty>
        ) : (
          <ul className="space-y-1">
            {[...logs].reverse().map((l, i) => (
              <li key={`${l.at}-${i}`} className="text-[11px] text-muted">
                <span className="text-muted">{new Date(l.at).toLocaleTimeString()} </span>
                <span className={l.level === 'error' ? 'text-rose-400' : l.level === 'warn' ? 'text-amber-400' : 'text-fg'}>{l.msg}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

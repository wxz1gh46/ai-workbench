import type { ClusterNodeInfo } from '@ai/shared';
import { Badge, Button } from '@/components/ui';

/** 集群节点卡片。资源占用与心跳状态一眼可见，便于定位「哪个节点卡住了」。 */
export function ClusterNodeCard({
  node,
  busy,
  onHeartbeat,
  onRemove,
  onElect,
}: {
  node: ClusterNodeInfo & { metrics?: { cpu: number; memory: number; gpu: number; disk: number; network: number } | null };
  busy?: boolean;
  onHeartbeat?: () => void;
  onRemove?: () => void;
  onElect?: () => void;
}) {
  const tone = node.status === 'online' ? 'ok' : node.status === 'offline' ? 'error' : 'warn';
  return (
    <article className="flex flex-col gap-2 rounded-lg border border-border bg-panel p-3">
      <header className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-sm font-medium text-fg">{node.name}</h3>
          <Badge tone={tone}>{node.status}</Badge>
          <Badge tone={node.role === 'leader' ? 'info' : 'default'}>{node.role}</Badge>
        </div>
        <span className="shrink-0 text-[11px] text-muted">
          {node.host}:{node.port}
        </span>
      </header>

      <ul className="space-y-0.5 text-[11px] text-muted">
        <li>
          心跳：{node.lastHeartbeat ? new Date(node.lastHeartbeat).toLocaleTimeString() : '从未'}
          {node.heartbeatMiss > 0 && <span className="text-amber-400"> （丢失 {node.heartbeatMiss} 次）</span>}
        </li>
        <li>
          资源声明：{Object.entries(node.resources).map(([k, v]) => `${k}=${v}`).join(' · ') || '—'}
        </li>
        {node.metrics && (
          <li>
            当前：CPU {node.metrics.cpu}% · 内存 {node.metrics.memory}% · GPU {node.metrics.gpu}% · 磁盘 {node.metrics.disk}%
          </li>
        )}
        {Object.keys(node.labels).length > 0 && <li>标签：{Object.entries(node.labels).map(([k, v]) => `${k}=${v}`).join(' · ')}</li>}
      </ul>

      <footer className="mt-auto flex justify-end gap-1">
        {onHeartbeat && <Button variant="ghost" onClick={onHeartbeat} disabled={busy}>发心跳</Button>}
        {onElect && <Button onClick={onElect} disabled={busy}>设为 leader</Button>}
        {onRemove && <Button variant="danger" onClick={onRemove} disabled={busy}>移除</Button>}
      </footer>
    </article>
  );
}

import type { ClusterStatus } from '@ai/shared';

/**
 * 集群健康概览（纯 SVG，不引入图表库）。
 * 用条形图展示「在线/离线/错误」与「分片状态分布」，让「集群是否健康」一眼可判。
 */
export function ClusterHealthChart({ status }: { status: ClusterStatus }) {
  const shardParts = [
    { key: 'succeeded', value: status.shardStats.succeeded, color: 'fill-emerald-500' },
    { key: 'running', value: status.shardStats.running + status.shardStats.assigned, color: 'fill-sky-500' },
    { key: 'pending', value: status.shardStats.pending, color: 'fill-slate-500' },
    { key: 'failed', value: status.shardStats.failed, color: 'fill-rose-500' },
    { key: 'reassigned', value: status.shardStats.reassigned, color: 'fill-amber-500' },
  ];
  const total = Math.max(1, shardParts.reduce((s, p) => s + p.value, 0));
  let x = 0;

  return (
    <div className="space-y-2 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted">在线节点</span>
        <strong className="text-fg">{status.online}</strong>
        <span className="text-muted">/ {status.nodes.length}</span>
        <span className="mx-2 h-3 w-px bg-border" />
        <span className="text-muted">term</span>
        <strong className="text-fg">{status.term}</strong>
        <span className="text-muted">leader</span>
        <strong className="text-fg">{status.leader?.name ?? '（无）'}</strong>
        {status.degraded && <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-amber-300">已降级单机：{status.degradeReason}</span>}
      </div>

      <div>
        <p className="mb-0.5 text-muted">分片分布（共 {total}）</p>
        <svg viewBox="0 0 300 16" className="h-4 w-full" role="img" aria-label="分片状态分布">
          <rect x="0" y="0" width="300" height="16" className="fill-panel" />
          {shardParts.map((p) => {
            const w = (p.value / total) * 300;
            const rect = <rect key={p.key} x={x} y="0" width={Math.max(0, w)} height="16" className={p.color} />;
            x += w;
            return rect;
          })}
        </svg>
        <ul className="mt-1 flex flex-wrap gap-2 text-muted">
          {shardParts.map((p) => (
            <li key={p.key}>{p.key}: {p.value}</li>
          ))}
        </ul>
      </div>

      <ul className="flex flex-wrap gap-2 text-muted">
        <li>任务 排队 {status.taskStats.queued}</li>
        <li>执行 {status.taskStats.running}</li>
        <li>成功 {status.taskStats.succeeded}</li>
        <li>失败 {status.taskStats.failed}</li>
      </ul>
    </div>
  );
}

import type { ScheduleRunRecord } from '@ai/shared';
import { Badge, Empty } from '@/components/ui';

/**
 * 定时任务执行历史。
 *
 * 展示重点：状态、尝试次数（含重试）、耗时、错误原文、结构化结果。
 * 「为什么失败 / 重试了几次」要一眼可查 —— 这是 Phase 3 的验收项。
 */
export function JobHistory({
  runs,
  stats,
  onRetry,
  busy,
}: {
  runs: ScheduleRunRecord[];
  stats?: { total: number; succeeded: number; failed: number; successRate: number; avgDurationMs: number };
  onRetry?: () => void | Promise<void>;
  busy?: boolean;
}) {
  if (!runs.length) return <Empty>还没有执行记录</Empty>;

  return (
    <div className="space-y-2">
      {stats && (
        <div className="flex flex-wrap items-center gap-2 text-[10px]">
          <Badge tone={stats.successRate >= 80 ? 'ok' : stats.successRate >= 50 ? 'warn' : 'error'}>成功率 {stats.successRate}%</Badge>
          <span className="text-muted">共 {stats.total} 次</span>
          <span className="text-emerald-400">成功 {stats.succeeded}</span>
          <span className="text-rose-400">失败 {stats.failed}</span>
          <span className="text-muted">平均耗时 {(stats.avgDurationMs / 1000).toFixed(1)}s</span>
        </div>
      )}

      <ul className="space-y-1">
        {runs.map((r) => {
          const duration = r.finishedAt ? Date.parse(r.finishedAt) - Date.parse(r.startedAt) : null;
          return (
            <li key={r.id} className="rounded border border-border bg-bg p-1.5 text-[10px]">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  <Badge tone={r.status === 'succeeded' ? 'ok' : r.status === 'failed' ? 'error' : r.status === 'running' ? 'info' : 'default'}>
                    {r.status}
                  </Badge>
                  <span className="text-muted">{r.trigger === 'manual' ? '手动' : '定时'}</span>
                  {r.retryCount > 0 && <Badge tone="warn">重试 {r.retryCount} 次</Badge>}
                </div>
                <span className="text-muted">{new Date(r.startedAt).toLocaleString('zh-CN', { hour12: false })}</span>
              </div>
              <p className="mt-1 break-all">{r.log}</p>
              {r.error && <p className="mt-0.5 break-all text-rose-400">错误：{r.error}</p>}
              {duration !== null && <p className="mt-0.5 text-muted">耗时 {(duration / 1000).toFixed(1)}s</p>}
            </li>
          );
        })}
      </ul>

      {onRetry && (
        <button onClick={() => void onRetry()} disabled={busy} className="text-[10px] text-brand hover:underline disabled:opacity-40">
          刷新记录
        </button>
      )}
    </div>
  );
}

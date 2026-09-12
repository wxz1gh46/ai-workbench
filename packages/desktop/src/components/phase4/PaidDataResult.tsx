import type { PaidDataQueryRecord } from '@ai/shared';
import { Badge, Empty } from '@/components/ui';

/** 查询历史列表：让用户能看到「查了什么、花了多少、是否降级/被拒」。 */
export function PaidDataResult({ queries, onSelect }: { queries: PaidDataQueryRecord[]; onSelect?: (id: string) => void }) {
  if (queries.length === 0) return <Empty>还没有查询记录。</Empty>;
  return (
    <ul className="space-y-1 text-[11px]">
      {queries.map((q) => (
        <li
          key={q.id}
          className="flex cursor-pointer items-center justify-between gap-2 rounded border border-border bg-panel px-2 py-1 hover:border-brand/50"
          onClick={() => onSelect?.(q.id)}
        >
          <span className="min-w-0 truncate text-fg">
            {q.providerId} · {q.action}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {q.cached && <Badge tone="info">缓存</Badge>}
            {q.degraded && <Badge tone="warn">降级</Badge>}
            <Badge tone={q.status === 'blocked' ? 'error' : q.status === 'failed' ? 'warn' : 'ok'}>{q.status}</Badge>
            <span className="text-muted">{q.rowCount}行 · {q.durationMs}ms</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

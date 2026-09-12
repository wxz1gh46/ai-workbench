import type { TokenBudgetUsage } from '@ai/shared';
import { cn } from '@/lib/utils';

const KIND_LABEL: Record<string, string> = {
  recent: '近期原文',
  summary: '历史摘要',
  facts: '关键事实',
  retrieval: '向量召回',
  file: '文件上下文',
  goal: '目标上下文',
};

const KIND_COLOR: Record<string, string> = {
  recent: 'bg-sky-500',
  summary: 'bg-violet-500',
  facts: 'bg-emerald-500',
  retrieval: 'bg-amber-500',
  file: 'bg-pink-500',
  goal: 'bg-brand',
};

/**
 * Token 预算条（Step 1 UI）。
 * 展示各分区实际占用 / 上限，以及输出预留与是否超限。
 */
export function TokenBudgetBar({ budget, compact }: { budget: TokenBudgetUsage; compact?: boolean }) {
  const inputTotal = budget.total - budget.outputReserve;
  const pct = (n: number) => Math.max(0, Math.min(100, (n / Math.max(1, budget.total)) * 100));

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[10px] text-muted">
        <span>
          Token 预算 {budget.used.toLocaleString()} / {budget.total.toLocaleString()}
        </span>
        <span className={cn(budget.overBudget ? 'text-rose-400' : 'text-muted')}>
          {budget.overBudget ? '⚠️ 超出输入预算' : `输入可用 ${inputTotal.toLocaleString()}`}
        </span>
      </div>
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-bg">
        {Object.entries(budget.byKind).map(([kind, used]) =>
          used > 0 ? <div key={kind} className={cn('h-full', KIND_COLOR[kind])} style={{ width: `${pct(used)}%` }} title={`${KIND_LABEL[kind]}：${used}`} /> : null,
        )}
        <div className="h-full bg-fg/20" style={{ width: `${pct(budget.outputReserve)}%` }} title={`输出预留：${budget.outputReserve}`} />
      </div>
      {!compact && (
        <ul className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-muted">
          {Object.entries(budget.byKind).map(([kind, used]) => (
            <li key={kind} className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1">
                <i className={cn('inline-block h-1.5 w-1.5 rounded-full', KIND_COLOR[kind])} />
                {KIND_LABEL[kind]}
              </span>
              <span>
                {used.toLocaleString()} / {budget.limits[kind as keyof typeof budget.limits].toLocaleString()}
              </span>
            </li>
          ))}
          <li className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1">
              <i className="inline-block h-1.5 w-1.5 rounded-full bg-fg/20" />
              输出预留
            </span>
            <span>{budget.outputReserve.toLocaleString()}</span>
          </li>
        </ul>
      )}
    </div>
  );
}

import type { ProgressNode, ProgressTree as ProgressTreeData } from '@ai/shared';
import { Badge, Progress } from '@/components/ui';
import { cn, taskStatusLabel } from '@/lib/utils';

const TONE: Record<string, 'default' | 'ok' | 'warn' | 'error' | 'info'> = {
  succeeded: 'ok',
  running: 'info',
  ready: 'info',
  blocked: 'warn',
  failed: 'error',
  cancelled: 'default',
  pending: 'default',
};

/**
 * 进度树（Step 2/4 UI）：目标 → 任务 → 子任务。
 * 阻塞项单独高亮，避免用户只看到「卡片变灰」却不知道原因。
 */
export function ProgressTree({ tree, onSelect }: { tree: ProgressTreeData; onSelect?: (taskId: string) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded border border-border bg-bg/40 p-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium">{tree.goal.objective}</span>
          <Badge tone={tree.goal.status === 'completed' ? 'ok' : tree.goal.status === 'failed' ? 'error' : 'info'}>{tree.goal.status}</Badge>
        </div>
        <div className="mt-1.5">
          <Progress value={tree.goal.progress} />
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted">
          <span>进度 {tree.goal.progress}%</span>
          <span>
            轮次 {tree.goal.iterations}/{tree.goal.maxIterations}
          </span>
          <span>
            任务 {tree.summary.succeeded}/{tree.summary.total} 成功
          </span>
          {tree.summary.blocked > 0 && <span className="text-amber-400">阻塞 {tree.summary.blocked}</span>}
          {tree.summary.failed > 0 && <span className="text-rose-400">失败 {tree.summary.failed}</span>}
        </div>
      </div>

      {tree.blockers.length > 0 && (
        <div className="rounded border border-amber-500/40 bg-amber-500/5 p-2">
          <div className="text-[11px] font-medium text-amber-400">阻塞项（{tree.blockers.length}）</div>
          <ul className="mt-1 space-y-0.5 text-[10px] text-amber-200/80">
            {tree.blockers.slice(0, 6).map((b, i) => (
              <li key={i}>· {b}</li>
            ))}
          </ul>
        </div>
      )}

      <ul className="space-y-1">
        {tree.nodes.map((n) => (
          <Node key={n.id} node={n} depth={0} {...(onSelect ? { onSelect } : {})} />
        ))}
      </ul>
    </div>
  );
}

function Node({ node, depth, onSelect }: { node: ProgressNode; depth: number; onSelect?: (taskId: string) => void }) {
  return (
    <li>
      <button
        onClick={() => onSelect?.(node.id)}
        className={cn(
          'flex w-full items-start gap-2 rounded border px-2 py-1.5 text-left text-[11px] transition-colors hover:border-brand/40',
          node.status === 'blocked' ? 'border-amber-500/40 bg-amber-500/5' : 'border-border',
        )}
        style={{ marginLeft: depth * 12 }}
      >
        <Badge tone={TONE[node.status] ?? 'default'}>{taskStatusLabel(node.status)}</Badge>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{node.title}</span>
          {node.blockedReason && <span className="mt-0.5 block truncate text-[10px] text-amber-400">原因：{node.blockedReason}</span>}
          {node.outputSummary && <span className="mt-0.5 block truncate text-[10px] text-muted">产出：{node.outputSummary}</span>}
        </span>
        <span className="shrink-0 text-[10px] text-muted">{node.agentRole}</span>
      </button>
      {node.children.length > 0 && (
        <ul className="mt-1 space-y-1">
          {node.children.map((c) => (
            <Node key={c.id} node={c} depth={depth + 1} {...(onSelect ? { onSelect } : {})} />
          ))}
        </ul>
      )}
    </li>
  );
}

import type { PromptOptimizeReport, PromptSections } from '@ai/shared';
import { Badge, Button, Empty } from '@/components/ui';

/** 优化器结果面板：展示规则化问题清单与模型增强说明，避免「优化了什么看不出来」。 */
export function PromptOptimizer({
  report,
  onApply,
  onDiscard,
}: {
  report: PromptOptimizeReport & { rendered: string };
  onApply: (sections: PromptSections) => void;
  onDiscard: () => void;
}) {
  return (
    <div className="space-y-2 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={report.score >= 70 ? 'ok' : report.score >= 40 ? 'warn' : 'error'}>优化后质量分 {report.score}</Badge>
        {report.degraded ? <Badge tone="warn">离线规则优化</Badge> : <Badge tone="info">已用模型增强</Badge>}
        <Button variant="primary" onClick={() => onApply(report.sections as unknown as PromptSections)}>应用到编辑器</Button>
        <Button variant="ghost" onClick={onDiscard}>丢弃</Button>
      </div>

      {report.issues.length === 0 ? (
        <Empty>未发现明显问题（歧义 / 缺失要素 / 结构问题）。</Empty>
      ) : (
        <ul className="space-y-1">
          {report.issues.map((i, idx) => (
            <li key={idx} className="rounded border border-border bg-panel p-2">
              <Badge tone={i.severity === 'high' ? 'error' : i.severity === 'medium' ? 'warn' : 'info'}>{i.severity}</Badge>{' '}
              <span className="text-fg">[{i.section}]</span> {i.detail}
              <p className="mt-0.5 text-muted">建议：{i.suggestion}</p>
            </li>
          ))}
        </ul>
      )}

      {report.notes.length > 0 && (
        <ul className="list-inside list-disc text-muted">
          {report.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}

      <details className="rounded border border-border bg-panel p-2">
        <summary className="cursor-pointer text-muted">优化后的完整提示词</summary>
        <pre className="mt-1 max-h-72 overflow-auto font-mono text-[11px] text-muted">{report.rendered}</pre>
      </details>
    </div>
  );
}

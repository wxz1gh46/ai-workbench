import type { PromptSections, PromptVariableSpec } from '@ai/shared';
import { Badge, Button } from '@/components/ui';

/**
 * 九要素提示词编辑器。
 * 变量一栏可直接填值（用于「一键复制」渲染），未填的必填变量会明确报出。
 */
export function PromptEditor({
  sections,
  onChange,
  variables,
  variableValues,
  onVariableChange,
  score,
  issues,
  onOptimize,
  onCopy,
  busy,
}: {
  sections: Partial<PromptSections>;
  onChange: (s: Partial<PromptSections>) => void;
  variables: PromptVariableSpec[];
  variableValues: Record<string, string>;
  onVariableChange: (name: string, value: string) => void;
  score?: number;
  issues?: { severity: string; section: string; detail: string; suggestion: string }[];
  onOptimize?: () => void;
  onCopy?: () => void;
  busy?: boolean;
}) {
  const keys = Object.keys(sections) as (keyof PromptSections)[];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {score !== undefined && <Badge tone={score >= 70 ? 'ok' : score >= 40 ? 'warn' : 'error'}>质量分 {score}</Badge>}
        {variables.length > 0 && <Badge tone="info">{variables.length} 个变量</Badge>}
        {onOptimize && <Button onClick={onOptimize} disabled={busy}>优化</Button>}
        {onCopy && <Button variant="primary" onClick={onCopy} disabled={busy}>一键复制</Button>}
      </div>

      {(issues ?? []).length > 0 && (
        <ul className="space-y-1">
          {(issues ?? []).map((i, idx) => (
            <li key={idx} className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-300">
              <Badge tone={i.severity === 'high' ? 'error' : i.severity === 'medium' ? 'warn' : 'info'}>{i.severity}</Badge>{' '}
              {i.detail} → {i.suggestion}
            </li>
          ))}
        </ul>
      )}

      {variables.length > 0 && (
        <div className="rounded border border-border bg-panel p-2">
          <p className="mb-1 text-[11px] text-muted">变量（用于渲染 / 一键复制）</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {variables.map((v) => (
              <label key={v.name} className="text-[11px] text-muted">
                <code className="text-fg">{`{{${v.name}}}`}</code>
                {v.required && <span className="text-rose-400"> *</span>}
                <input
                  className="mt-0.5 w-full rounded border border-border bg-bg px-2 py-1 text-xs text-fg"
                  value={variableValues[v.name] ?? v.defaultValue ?? ''}
                  onChange={(e) => onVariableChange(v.name, e.target.value)}
                  placeholder={v.description || v.name}
                />
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="space-y-2">
        {keys.map((k) => (
          <label key={k} className="block text-[11px] text-muted">
            {k}
            <textarea
              className="mt-0.5 h-20 w-full resize-y rounded border border-border bg-panel px-2 py-1 font-mono text-xs text-fg"
              value={sections[k] ?? ''}
              onChange={(e) => onChange({ ...sections, [k]: e.target.value })}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

import { useState } from 'react';
import { PROMPT_SECTION_LABELS, type PromptSections } from '@ai/shared';
import { api } from '@/lib/api';
import { describeError, useAppStore } from '@/stores/app-store';
import { Badge, Button, Panel } from '@/components/ui';

/** 提示词工程：生成 / 优化，输出九要素结构，支持一键复制 */
export function PromptPage() {
  const workspace = useAppStore((s) => s.workspace);
  const pushToast = useAppStore((s) => s.pushToast);
  const [intent, setIntent] = useState('');
  const [sections, setSections] = useState<PromptSections | null>(null);
  const [rendered, setRendered] = useState('');
  const [variables, setVariables] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function optimize() {
    if (!workspace || !intent.trim()) return;
    setBusy(true);
    try {
      const res = await api.optimizePrompt(workspace.id, intent.trim());
      setSections(res.sections);
      setRendered(res.rendered);
      setVariables(res.variables);
      setNotes(res.notes);
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(rendered);
    pushToast({ level: 'success', message: '已复制到剪贴板' });
  }

  return (
    <div className="grid h-full grid-cols-2 gap-3">
      <Panel title="描述你的诉求">
        <div className="space-y-2">
          <textarea
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            rows={6}
            placeholder="例如：让模型帮我审阅财报，重点看现金流与关联交易，输出风险清单"
            className="w-full resize-none rounded border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-brand"
          />
          <Button variant="primary" onClick={() => void optimize()} disabled={busy || !intent.trim()}>
            {busy ? '生成中…' : '生成 / 优化'}
          </Button>
          {notes.length > 0 && (
            <ul className="space-y-0.5 text-[11px] text-amber-400">
              {notes.map((n, i) => (
                <li key={i}>· {n}</li>
              ))}
            </ul>
          )}
        </div>
      </Panel>

      <Panel
        title="结构化提示词（九要素）"
        actions={
          <>
            {variables.length > 0 && <Badge tone="info">{variables.length} 个变量</Badge>}
            <Button onClick={() => void copy()} disabled={!rendered}>
              一键复制
            </Button>
          </>
        }
      >
        {!sections ? (
          <p className="text-xs text-muted">左侧输入诉求后点击生成</p>
        ) : (
          <div className="space-y-2">
            {(Object.keys(PROMPT_SECTION_LABELS) as (keyof PromptSections)[]).map((k) =>
              sections[k] ? (
                <div key={k}>
                  <div className="text-[11px] font-medium text-brand">{PROMPT_SECTION_LABELS[k]}</div>
                  <pre className="whitespace-pre-wrap text-[11px] text-fg">{sections[k]}</pre>
                </div>
              ) : null,
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}

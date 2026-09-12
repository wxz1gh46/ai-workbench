import { useCallback, useEffect, useState } from 'react';
import type { PromptABTestInfo, PromptABTestReport, PromptSections, PromptVariableSpec } from '@ai/shared';
import { api } from '@/lib/api';
import { describeError, useAppStore } from '@/stores/app-store';
import { Badge, Button, Empty, Panel } from '@/components/ui';
import { confirmDanger } from '@/lib/utils';
import { PromptEditor } from '@/components/phase4/PromptEditor';
import { PromptOptimizer } from '@/components/phase4/PromptOptimizer';
import { PromptABTest } from '@/components/phase4/PromptABTest';

const EMPTY: Partial<PromptSections> = {
  role: '',
  task: '',
  context: '',
  steps: '',
  tools: '',
  constraints: '',
  outputFormat: '',
  examples: '',
  acceptance: '',
};

/**
 * 提示词工作台（Phase 4 Step 7）。
 * 流程闭环：模板库 → 生成 → 优化 → 保存版本 → A/B → 复制。
 */
export function PromptWorkbenchPage() {
  const workspace = useAppStore((s) => s.workspace);
  const pushToast = useAppStore((s) => s.pushToast);
  const [library, setLibrary] = useState<{ key: string; name: string; description: string; tags: string[]; variables: PromptVariableSpec[]; filledSections: number }[]>([]);
  const [templates, setTemplates] = useState<{ name: string; version: number; versions: number[]; score: number }[]>([]);
  const [sections, setSections] = useState<Partial<PromptSections>>(EMPTY);
  const [variables, setVariables] = useState<PromptVariableSpec[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [goal, setGoal] = useState('');
  const [name, setName] = useState('我的提示词');
  const [score, setScore] = useState<number | undefined>();
  const [issues, setIssues] = useState<{ severity: string; section: string; detail: string; suggestion: string }[]>([]);
  const [optimizeReport, setOptimizeReport] = useState<(PromptOptimizeReportLike & { rendered: string }) | null>(null);
  const [abTests, setAbTests] = useState<PromptABTestInfo[]>([]);
  const [abReport, setAbReport] = useState<PromptABTestReport | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!workspace) return;
    try {
      const [lib, tpl, ab] = await Promise.all([api.promptLibrary(), api.listPromptsV4(workspace.id), api.listAbTests(workspace.id)]);
      setLibrary(lib.templates);
      setTemplates(tpl.templates);
      setAbTests(ab.tests);
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  useEffect(() => {
    void load();
  }, [load]);

  async function generate() {
    if (!workspace || !goal.trim()) {
      pushToast({ level: 'warn', message: '请先描述你的目标' });
      return;
    }
    setBusy(true);
    try {
      const res = await api.generatePromptV4({ workspaceId: workspace.id, goal });
      setSections(res.sections);
      setVariables(res.variables);
      setOptimizeReport(null);
      setIssues([]);
      pushToast({ level: res.degraded ? 'info' : 'success', message: res.notes.join('；') });
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function optimize() {
    if (!workspace) return;
    setBusy(true);
    try {
      const res = await api.optimizePromptV4({ workspaceId: workspace.id, current: sections });
      setOptimizeReport(res);
      setScore(res.score);
      setIssues(res.issues);
      pushToast({ level: 'success', message: `优化完成（质量分 ${res.score}）` });
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    try {
      const res = await api.copyPrompt(sections, values, name);
      await navigator.clipboard.writeText(res.markdown).catch(() => undefined);
      pushToast({
        level: res.ok ? 'success' : 'warn',
        message: res.ok ? '已复制到剪贴板' : `已复制，但还有未填写的变量：${res.missingRequired.join('、')}`,
      });
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    }
  }

  async function save() {
    if (!workspace) return;
    setBusy(true);
    try {
      const res = await api.savePromptV4({ workspaceId: workspace.id, name, sections });
      pushToast({ level: 'success', message: `已保存 ${res.name} v${res.version}` });
      await load();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function loadTemplate(templateName: string) {
    if (!workspace) return;
    try {
      const res = await api.getPromptV4(templateName, workspace.id);
      setSections(res.sections);
      setVariables(res.variables);
      setScore(res.score);
      setValues({});
      setName(templateName);
      pushToast({ level: 'info', message: `已载入 ${templateName} v${res.version}` });
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    }
  }

  async function useLibrary(key: string, templateName: string) {
    if (!workspace) return;
    try {
      await api.useLibraryTemplate(key, workspace.id, templateName);
      pushToast({ level: 'success', message: `已从模板库创建「${templateName}」` });
      await load();
      await loadTemplate(templateName);
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    }
  }

  async function startAb() {
    if (!workspace) return;
    const tpl = templates.find((t) => t.name === name);
    if (!tpl || tpl.versions.length < 2) {
      pushToast({ level: 'warn', message: '至少保存两个版本后才能做 A/B 测试' });
      return;
    }
    const sorted = [...tpl.versions].sort((a, b) => a - b);
    try {
      await api.createAbTest({ workspaceId: workspace.id, templateName: name, versionA: sorted[sorted.length - 2]!, versionB: sorted[sorted.length - 1]! });
      pushToast({ level: 'success', message: 'A/B 测试已创建' });
      await load();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    }
  }

  async function openAb(id: string) {
    if (!workspace) return;
    try {
      setAbReport(await api.getAbTest(id, workspace.id));
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    }
  }

  async function rollback(version: number) {
    if (!workspace) return;
    if (!confirmDanger(`回滚「${name}」到 v${version}`, '会创建一个新版本（不删除历史），当前内容将被覆盖。')) return;
    try {
      const res = await api.rollbackPromptV4(name, workspace.id, version);
      pushToast({ level: 'success', message: `已回滚，生成 v${res.version}` });
      await load();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    }
  }

  if (!workspace) return <p className="p-4 text-xs text-muted">正在加载工作区…</p>;

  return (
    <div className="grid min-h-0 flex-1 gap-3 p-3 lg:grid-cols-[240px_1fr_300px]">
      <Panel title="模板库">
        <ul className="space-y-1 text-[11px]">
          {library.map((t) => (
            <li key={t.key} className="rounded border border-border bg-bg p-1.5">
              <div className="flex items-center justify-between gap-1">
                <span className="truncate text-fg">{t.name}</span>
                <Badge tone="info">{t.filledSections}/9</Badge>
              </div>
              <p className="text-muted">{t.description}</p>
              <div className="mt-1 flex items-center gap-1">
                <Button variant="primary" onClick={() => useLibrary(t.key, t.name)}>使用</Button>
                {t.variables.length > 0 && <span className="text-muted">{t.variables.length} 变量</span>}
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      <div className="flex min-h-0 flex-col gap-3">
        <Panel
          title="生成 / 编辑"
          actions={
            <div className="flex items-center gap-1">
              <input className="rounded border border-border bg-bg px-2 py-1 text-[11px] text-fg" value={name} onChange={(e) => setName(e.target.value)} placeholder="模板名" />
              <Button onClick={save} disabled={busy}>保存版本</Button>
              <Button onClick={startAb} disabled={busy}>新建 A/B</Button>
            </div>
          }
        >
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <input
                className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-xs text-fg"
                placeholder="描述你的目标，例如：调研储能行业的政策与竞争格局"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
              />
              <Button variant="primary" onClick={generate} disabled={busy}>生成</Button>
            </div>

            <PromptEditor
              sections={sections}
              onChange={setSections}
              variables={variables}
              variableValues={values}
              onVariableChange={(k, v) => setValues((s) => ({ ...s, [k]: v }))}
              {...(score === undefined ? {} : { score })}
              issues={issues}
              onOptimize={optimize}
              onCopy={copy}
              busy={busy}
            />

            {optimizeReport && (
              <PromptOptimizer
                report={optimizeReport}
                onApply={(s) => {
                  setSections(s);
                  setOptimizeReport(null);
                }}
                onDiscard={() => setOptimizeReport(null)}
              />
            )}
          </div>
        </Panel>

        <Panel title="A/B 测试">
          {abReport ? (
            <PromptABTest report={abReport} workspaceId={workspace.id} onChanged={async () => { await openAb(abReport.test.id); await load(); }} />
          ) : abTests.length === 0 ? (
            <Empty>还没有 A/B 测试。保存至少两个版本后可创建。</Empty>
          ) : (
            <ul className="space-y-1 text-[11px]">
              {abTests.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-2 rounded border border-border bg-bg px-2 py-1">
                  <span className="truncate text-fg">{t.name}（v{t.versionA} vs v{t.versionB}）</span>
                  <span className="flex items-center gap-1">
                    <Badge tone={t.status === 'finished' ? 'default' : 'info'}>{t.status}</Badge>
                    <Button variant="ghost" onClick={() => openAb(t.id)}>查看</Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="我的版本">
        {templates.length === 0 ? (
          <Empty>还没有保存任何模板。</Empty>
        ) : (
          <ul className="space-y-1 text-[11px]">
            {templates.map((t) => (
              <li key={t.name} className="rounded border border-border bg-bg p-1.5">
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate text-fg">{t.name}</span>
                  <span className="flex items-center gap-1">
                    <Badge tone={t.score >= 70 ? 'ok' : t.score >= 40 ? 'warn' : 'error'}>{t.score}</Badge>
                    <Badge tone="default">v{t.version}</Badge>
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Button variant="ghost" onClick={() => loadTemplate(t.name)}>载入</Button>
                  {[...t.versions].sort((a, b) => b - a).slice(0, 3).map((v) => (
                    <button
                      key={v}
                      type="button"
                      className="rounded border border-border px-1.5 text-muted hover:border-brand/60"
                      onClick={() => rollback(v)}
                      title={`回滚到 v${v}`}
                    >
                      回滚 v{v}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

type PromptOptimizeReportLike = {
  sections: Record<string, string>;
  variables: PromptVariableSpec[];
  notes: string[];
  issues: { severity: 'low' | 'medium' | 'high'; section: string; detail: string; suggestion: string }[];
  score: number;
  degraded: boolean;
};


import { useEffect, useState } from 'react';
import type { AuditReport, ProgressTree as ProgressTreeData } from '@ai/shared';
import { Badge, Button, Empty, Panel, Progress } from '@/components/ui';
import { ProgressTree } from '@/components/ProgressTree';
import { api } from '@/lib/api';
import { triggerConfirm } from '@/lib/confirm';
import { useAppStore } from '@/stores/app-store';
import { taskStatusColor, taskStatusLabel, truncate } from '@/lib/utils';

const STATUS_TONE: Record<string, 'default' | 'ok' | 'warn' | 'error' | 'info'> = {
  completed: 'ok',
  running: 'info',
  auditing: 'warn',
  failed: 'error',
  cancelled: 'default',
};

export function GoalPage() {
  const { activeGoal, tasks, goals, createGoal, advanceGoal, runGoal, selectGoal, cancelTask } = useAppStore();
  const { pushToast } = useAppStore();
  const [objective, setObjective] = useState('');
  const [autoRun, setAutoRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ProgressTreeData | null>(null);
  const [audit, setAudit] = useState<AuditReport | null>(null);

  async function submit() {
    if (!objective.trim()) return;
    setBusy(true);
    await createGoal(objective.trim(), autoRun);
    setObjective('');
    setBusy(false);
  }

  async function cancelGoal() {
    if (!activeGoal) return;
    try {
      await api.cancelGoal(activeGoal.id);
      pushToast({ level: 'info', message: '目标已取消' });
      await selectGoal(activeGoal.id);
    } catch (e) {
      pushToast({ level: 'error', message: (e as Error).message });
    }
  }

  // 目标变化时拉取进度树与结构化审计（独立于任务列表，便于 UI 展示完成度与验收核对）
  useEffect(() => {
    if (!activeGoal) {
      setProgress(null);
      setAudit(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const [tree, auditRes] = await Promise.all([api.goalProgress(activeGoal.id), api.goalAudit(activeGoal.id)]);
        if (!cancelled) {
          setProgress(tree);
          setAudit(auditRes.audit);
        }
      } catch {
        if (!cancelled) {
          setProgress(null);
          setAudit(null);
        }
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeGoal?.id, activeGoal?.iterations, activeGoal?.status]);

  return (
    <div className="grid h-full grid-cols-[280px_1fr] gap-3">
      <Panel title="目标列表">
        {goals.length === 0 && <Empty>还没有目标</Empty>}
        <ul className="space-y-2">
          {goals.map((g) => (
            <li key={g.id}>
              <button
                onClick={() => void selectGoal(g.id)}
                className={`w-full rounded border px-2 py-1.5 text-left text-xs ${
                  activeGoal?.id === g.id ? 'border-brand/60 bg-brand/10' : 'border-border hover:border-brand/40'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{truncate(g.objective, 40)}</span>
                  <Badge tone={STATUS_TONE[g.status] ?? 'default'}>{g.status}</Badge>
                </div>
                <div className="mt-1.5">
                  <Progress value={g.progress} />
                </div>
              </button>
            </li>
          ))}
        </ul>
      </Panel>

      <div className="flex min-h-0 flex-col gap-3">
        <Panel title="创建目标">
          <div className="flex flex-col gap-2">
            <textarea
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              rows={2}
              placeholder="描述你要达成的目标，例如：调研 2025 年储能行业，输出一份带引用的 20 页报告"
              className="resize-none rounded border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-brand"
            />
            <div className="flex items-center gap-3">
              <Button variant="primary" onClick={() => void submit()} disabled={busy || !objective.trim()}>
                {busy ? '创建中…' : '创建并拆解'}
              </Button>
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} />
                创建后自动连续推进
              </label>
            </div>
          </div>
        </Panel>

        {!activeGoal ? (
          <Panel title="进度树" className="flex-1">
            <Empty>选择或创建一个目标</Empty>
          </Panel>
        ) : (
          <Panel
            title={`进度树 · ${activeGoal.status} · ${activeGoal.progress}%`}
            className="flex-1"
            actions={
              <>
                <Button onClick={() => void advanceGoal()}>推进一轮</Button>
                <Button variant="primary" onClick={() => void runGoal()}>
                  自动跑完
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    if (triggerConfirm('确认取消该目标？未完成的任务会被取消。')) void cancelGoal();
                  }}
                >
                  取消目标
                </Button>
              </>
            }
          >
            <div className="space-y-3">
              {progress ? (
                <ProgressTree tree={progress} />
              ) : (
                <div className="space-y-2">
                  <p className="text-sm">{activeGoal.objective}</p>
                  <Progress value={activeGoal.progress} />
                </div>
              )}

              <div>
                <div className="mb-1 text-xs text-muted">验收标准（同时作为完成审计标准）</div>
                <ul className="list-inside list-disc space-y-0.5 text-xs text-muted">
                  {(progress?.goal.acceptanceCriteria ?? activeGoal.acceptanceCriteria).map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>

              <div>
                <div className="mb-1 text-xs text-muted">任务（{tasks.length}）</div>
                {tasks.length === 0 ? (
                  <Empty>暂无任务</Empty>
                ) : (
                  <ul className="space-y-1.5">
                    {tasks.map((t) => (
                      <li key={t.id} className="rounded border border-border px-2 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs">
                            <span className={taskStatusColor(t.status)}>●</span> {t.title}
                          </span>
                          <div className="flex items-center gap-1.5">
                            <Badge>{t.agentRole}</Badge>
                            <span className={`text-[10px] ${taskStatusColor(t.status)}`}>
                              {taskStatusLabel(t.status)}
                              {t.attempts > 0 ? ` (${t.attempts}/${t.maxAttempts})` : ''}
                            </span>
                            {t.status !== 'succeeded' && t.status !== 'cancelled' && (
                              <Button variant="ghost" onClick={() => void cancelTask(t.id)} title="取消任务">
                                取消
                              </Button>
                            )}
                          </div>
                        </div>
                        {t.dependsOn.length > 0 && <div className="mt-1 text-[10px] text-muted">依赖 {t.dependsOn.length} 个前置任务</div>}
                        {t.reflection && <div className="mt-1 text-[10px] text-amber-300">反思：{truncate(t.reflection, 120)}</div>}
                        {t.error && <div className="mt-1 text-[10px] text-rose-400">{t.error}</div>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {audit && (
                <div>
                  <div className="mb-1 flex items-center gap-2 text-xs">
                    <span className="text-muted">完成审计</span>
                    <Badge tone={audit.passed ? 'ok' : 'error'}>{audit.passed ? '通过' : '未通过'}</Badge>
                    <span className="text-muted">得分 {audit.score}/100</span>
                    {audit.degraded && <Badge tone="warn">离线审计</Badge>}
                  </div>
                  <ul className="space-y-1">
                    {audit.criteria.map((c, i) => (
                      <li key={i} className="rounded border border-border bg-bg/30 px-2 py-1 text-[11px]">
                        <div className="flex items-center gap-1.5">
                          <span className={c.met ? 'text-emerald-400' : 'text-rose-400'}>{c.met ? '☑' : '☐'}</span>
                          <span>{c.criterion}</span>
                        </div>
                        <div className="mt-0.5 text-[10px] text-muted">证据：{c.evidence}</div>
                      </li>
                    ))}
                  </ul>
                  {audit.issues.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5 text-[10px] text-amber-300">
                      {audit.issues.map((i, k) => (
                        <li key={k}>[{i.severity}] {i.detail}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {!audit && activeGoal.blockers.length > 0 && (
                <div>
                  <div className="mb-1 text-xs text-amber-400">阻塞项 / 建议下一步</div>
                  <ul className="list-inside list-disc space-y-0.5 text-xs text-amber-300">
                    {activeGoal.blockers.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                </div>
              )}

              {audit && (
                <details className="rounded border border-border bg-bg/30 p-2">
                  <summary className="cursor-pointer text-[11px] text-muted">查看完整审计报告 Markdown</summary>
                  <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap text-[10px] text-muted">{audit.markdown}</pre>
                </details>
              )}
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}

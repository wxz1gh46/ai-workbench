import { useState } from 'react';
import { Badge, Button, Empty, Panel, Progress } from '@/components/ui';
import { useAppStore } from '@/stores/app-store';
import { taskStatusColor, taskStatusLabel, truncate } from '@/lib/utils';

const STATUS_TONE: Record<string, 'default' | 'ok' | 'warn' | 'error' | 'info'> = {
  completed: 'ok',
  running: 'info',
  auditing: 'warn',
  failed: 'error',
  cancelled: 'default',
};

/**
 * 目标模式页。
 * 目标文本 = 起始指令 + 完成审计标准；展示进度树、阻塞项、审计报告。
 */
export function GoalPage() {
  const { activeGoal, tasks, goals, createGoal, advanceGoal, runGoal, selectGoal, cancelTask } = useAppStore();
  const [objective, setObjective] = useState('');
  const [autoRun, setAutoRun] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!objective.trim()) return;
    setBusy(true);
    await createGoal(objective.trim(), autoRun);
    setObjective('');
    setBusy(false);
  }

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
            title={`进度树 · ${activeGoal.status} · ${activeGoal.progress}% · 第 ${activeGoal.iterations}/${activeGoal.maxIterations} 轮`}
            className="flex-1"
            actions={
              <>
                <Button onClick={() => void advanceGoal()}>推进一轮</Button>
                <Button variant="primary" onClick={() => void runGoal()}>
                  自动跑完
                </Button>
              </>
            }
          >
            <div className="space-y-3">
              <div>
                <div className="mb-1 text-xs text-muted">目标</div>
                <p className="text-sm">{activeGoal.objective}</p>
                <div className="mt-2">
                  <Progress value={activeGoal.progress} />
                </div>
              </div>

              <div>
                <div className="mb-1 text-xs text-muted">验收标准（同时作为完成审计标准）</div>
                <ul className="list-inside list-disc space-y-0.5 text-xs text-muted">
                  {activeGoal.acceptanceCriteria.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>

              <div>
                <div className="mb-1 text-xs text-muted">任务</div>
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
                            <span className={`text-[10px] ${taskStatusColor(t.status)}`}>{taskStatusLabel(t.status)}</span>
                            {(t.status === 'running' || t.status === 'ready' || t.status === 'pending') && (
                              <Button variant="ghost" onClick={() => void cancelTask(t.id)} title="取消任务">
                                取消
                              </Button>
                            )}
                          </div>
                        </div>
                        {t.dependsOn.length > 0 && (
                          <div className="mt-1 text-[10px] text-muted">依赖 {t.dependsOn.length} 个前置任务</div>
                        )}
                        {t.error && <div className="mt-1 text-[10px] text-rose-400">{t.error}</div>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {activeGoal.blockers.length > 0 && (
                <div>
                  <div className="mb-1 text-xs text-amber-400">阻塞项 / 建议下一步</div>
                  <ul className="list-inside list-disc space-y-0.5 text-xs text-amber-300">
                    {activeGoal.blockers.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                </div>
              )}

              {activeGoal.auditReport && (
                <div>
                  <div className="mb-1 text-xs text-muted">完成审计报告</div>
                  <pre className="whitespace-pre-wrap rounded border border-border bg-bg p-2 text-[11px] text-muted">
                    {activeGoal.auditReport}
                  </pre>
                </div>
              )}
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}

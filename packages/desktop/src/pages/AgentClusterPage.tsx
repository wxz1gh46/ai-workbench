import { useEffect, useMemo, useRef, useState } from 'react';
import type { ClusterConfig, Goal, GoalRun, Task, TaskBoard as TaskBoardData } from '@ai/shared';
import { Badge, Button, Empty, Panel } from '@/components/ui';
import { AgentNode } from '@/components/AgentNode';
import { TaskBoard } from '@/components/TaskBoard';
import { api } from '@/lib/api';
import { triggerConfirm } from '@/lib/confirm';
import { useAppStore } from '@/stores/app-store';
import { truncate } from '@/lib/utils';

/**
 * Agent 集群视图（Step 3/4/7 UI）。
 * Agent 节点图 + 消息流时间线 + 任务看板 + 集群模式开关（含实验性降级）。
 */
export function AgentClusterPage() {
  const { workspace, agents, agentStatus, tasks: storeTasks } = useAppStore();
  const [goals, setGoals] = useState<Goal[]>([]);
  const [goalId, setGoalId] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [board, setBoard] = useState<TaskBoardData | null>(null);
  const [runs, setRuns] = useState<GoalRun[]>([]);
  const [messages, setMessages] = useState<{ id: string; kind: string; content: string; fromAgentId: string; topic: string; createdAt: string }[]>([]);
  const [cluster, setCluster] = useState<ClusterConfig | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function loadCluster() {
    if (!workspace) return;
    setCluster((await api.getCluster(workspace.id)).config);
    const { goals: list } = await api.listGoals(workspace.id);
    setGoals(list);
    if (!goalId && list[0]) setGoalId(list[0].id);
  }

  async function loadGoal(id: string) {
    if (!id) return;
    const [detail, b, r, m] = await Promise.all([api.getGoalV2(id), api.goalBoard(id), api.goalRuns(id), api.goalMessages(id)]);
    setTasks(detail.tasks);
    setBoard(b.board);
    setRuns(r.runs);
    setMessages(m.messages as typeof messages);
  }

  useEffect(() => {
    void loadCluster().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  useEffect(() => {
    if (!goalId) return;
    void loadGoal(goalId).catch(() => undefined);
    const timer = setInterval(() => {
      void loadGoal(goalId).catch(() => undefined);
    }, 2500);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length]);

  const stats = useMemo(() => {
    const byStatus = (s: string) => tasks.filter((t) => t.status === s).length;
    return {
      total: tasks.length,
      succeeded: byStatus('succeeded'),
      running: byStatus('running'),
      blocked: byStatus('blocked'),
      failed: byStatus('failed'),
      busyAgents: Object.values(agentStatus).filter((a) => a.status === 'busy').length,
    };
  }, [tasks, agentStatus]);

  async function setMode(mode: ClusterConfig['mode']) {
    if (!workspace) return;
    if (mode === 'cluster' && !triggerConfirm('集群模式为实验性功能（当前仍在单机内模拟多节点）。确认开启？')) return;
    setBusy(true);
    try {
      setCluster((await api.setCluster(workspace.id, { mode })).config);
    } finally {
      setBusy(false);
    }
  }

  async function runGoal() {
    if (!goalId) return;
    setBusy(true);
    try {
      const r = await api.runGoalV2(goalId, cluster?.mode);
      await loadGoal(goalId);
      useAppStore.getState().pushToast({
        level: r.finished ? 'success' : 'info',
        message: r.finished ? '目标已完成并通过审计' : `推进到第 ${r.goal.iterations} 轮（${r.goal.progress}%）`,
      });
    } catch (e) {
      useAppStore.getState().pushToast({ level: 'error', message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full grid-cols-[1fr_360px] gap-3">
      <div className="flex min-h-0 flex-col gap-3">
        <Panel
          title="集群控制"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <select className="rounded border border-border bg-bg px-2 py-1 text-[11px]" value={goalId} onChange={(e) => setGoalId(e.target.value)}>
                {goals.length === 0 && <option value="">（暂无目标）</option>}
                {goals.map((g) => (
                  <option key={g.id} value={g.id}>
                    {truncate(g.objective, 28)}
                  </option>
                ))}
              </select>
              <Button variant="primary" onClick={() => void runGoal()} disabled={busy || !goalId}>
                自主推进
              </Button>
            </div>
          }
        >
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="text-muted">运行模式</span>
            {(['single', 'parallel', 'cluster'] as const).map((m) => (
              <button
                key={m}
                onClick={() => void setMode(m)}
                disabled={busy}
                className={`rounded border px-2 py-0.5 ${cluster?.mode === m ? 'border-brand text-brand' : 'border-border text-muted'}`}
              >
                {m === 'single' ? '单 Agent（降级）' : m === 'parallel' ? '并行（默认）' : '实验性集群'}
              </button>
            ))}
            <label className="flex items-center gap-1 text-[10px] text-muted">
              并发上限
              <input
                type="number"
                min={1}
                max={32}
                className="w-14 rounded border border-border bg-bg px-1 py-0.5 text-[10px]"
                value={cluster?.maxParallel ?? 4}
                onChange={(e) => {
                  if (!workspace) return;
                  void api.setCluster(workspace.id, { maxParallel: Number(e.target.value) }).then((r) => setCluster(r.config));
                }}
              />
            </label>
            {cluster?.experimental && <Badge tone="warn">实验性功能已开启</Badge>}
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-muted">
            <span>任务 {stats.total}</span>
            <span className="text-emerald-400">成功 {stats.succeeded}</span>
            <span className="text-brand">执行中 {stats.running}</span>
            <span className="text-amber-400">阻塞 {stats.blocked}</span>
            <span className="text-rose-400">失败 {stats.failed}</span>
            <span>忙碌 Agent {stats.busyAgents}</span>
            <span>轮次 {runs.length}</span>
          </div>
          {tasks.length === 0 && storeTasks.length > 0 && <p className="mt-1 text-[10px] text-muted">提示：当前目标暂无任务，或该目标已由 Phase 1 接口创建。</p>}
        </Panel>

        <Panel title={`Agent 节点（${agents.length}）`}>
          {agents.length === 0 ? (
            <Empty>暂无 Agent</Empty>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {agents.map((a) => {
                const live = agentStatus[a.id];
                const status = live?.status ?? a.status;
                const task = tasks.find((t) => t.id === (live?.currentTaskId ?? a.currentTaskId));
                return (
                  <AgentNode
                    key={a.id}
                    agent={a}
                    status={status}
                    currentTaskTitle={task?.title ?? null}
                    messages={messages.filter((m) => m.fromAgentId === a.id) as never}
                    selected={selectedAgent === a.id}
                    onSelect={() => setSelectedAgent(a.id)}
                  />
                );
              })}
            </div>
          )}
        </Panel>

        <Panel title="任务看板">
          {!board ? (
            <Empty>选择目标后显示</Empty>
          ) : (
            <TaskBoard
              board={board}
              agents={agents.map((a) => ({ id: a.id, name: a.name, role: a.role }))}
              onCancel={(taskId) => void api.cancelTask(taskId).then(() => loadGoal(goalId))}
              onAssign={(taskId, agentId, preempt) => void api.assignTask(taskId, agentId, preempt).then(() => loadGoal(goalId))}
            />
          )}
        </Panel>
      </div>

      <div className="flex min-h-0 flex-col gap-3">
        <Panel title={`消息流（${messages.length}）`}>
          <div ref={scrollRef} className="max-h-64 space-y-1 overflow-auto">
            {messages.length === 0 ? (
              <Empty>暂无 Agent 消息</Empty>
            ) : (
              messages.map((m) => {
                const from = agents.find((a) => a.id === m.fromAgentId);
                return (
                  <div key={m.id} className="rounded border border-border bg-bg/30 px-2 py-1 text-[10px]">
                    <div className="flex items-center justify-between gap-2 text-muted">
                      <span className="text-brand/90">
                        {from?.name ?? m.fromAgentId} · {m.kind || m.topic}
                      </span>
                      <span>{m.createdAt.slice(11, 19)}</span>
                    </div>
                    <div className="mt-0.5">{truncate(m.content || JSON.stringify(m), 160)}</div>
                  </div>
                );
              })
            )}
          </div>
        </Panel>

        <Panel title={`轮次记录（${runs.length}）`}>
          {runs.length === 0 ? (
            <Empty>暂无轮次</Empty>
          ) : (
            <ul className="space-y-1.5">
              {runs.map((r) => (
                <li key={r.id} className="rounded border border-border bg-bg/30 px-2 py-1.5 text-[10px]">
                  <div className="flex items-center justify-between">
                    <span>第 {r.iteration} 轮</span>
                    <Badge tone={r.status === 'succeeded' ? 'ok' : r.status === 'running' ? 'info' : 'warn'}>{r.status}</Badge>
                  </div>
                  <div className="mt-0.5 text-muted">
                    任务 {r.taskIds.length} · token {r.tokensUsed}
                    {r.startedAt && ` · ${r.startedAt.slice(11, 19)}`}
                  </div>
                  {r.reflection && <div className="mt-0.5 whitespace-pre-wrap text-muted">{truncate(r.reflection, 200)}</div>}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

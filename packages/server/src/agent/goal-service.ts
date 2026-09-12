import { eq } from 'drizzle-orm';
import {
  EventType,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_ITERATIONS,
  type Agent,
  type Goal,
  type Task,
} from '@ai/shared';
import type { Db } from '../db/client.ts';
import { agentMessages, agents, goals, tasks } from '../db/schema/index.ts';
import { eventBus } from '../events/bus.ts';
import { WorkspaceService } from '../services/workspace.ts';
import { AuditService } from '../services/audit.ts';
import { Executor, findAgentForRole } from './executor.ts';
import { auditGoal, type CriticVerdict } from './critic.ts';
import { createPlan, defaultPlan } from './planner.ts';
import { computeProgress, detectCycle, resolveBlocked, resolveReady, toDagNodes } from './task-graph.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';

export interface CreateGoalResult {
  goal: Goal;
  tasks: Task[];
  agents: Agent[];
}

export interface AdvanceResult {
  goal: Goal;
  tasks: Task[];
  verdict: CriticVerdict | null;
  finished: boolean;
}

/**
 * 目标模式编排器（Coordinator）。
 *
 * 循环：解析目标 → 生成计划 → 任务 DAG → 并行执行 → 验证 → 反思 → 更新计划 → 完成审计
 * 每一轮固定落一个 checkpoint，避免长任务丢失进度；目标本身即完成审计标准。
 */
export class GoalService {
  private readonly executor: Executor;
  private readonly workspaceService: WorkspaceService;
  private readonly audit: AuditService;

  constructor(private readonly db: Db) {
    this.executor = new Executor(db);
    this.workspaceService = new WorkspaceService(db);
    this.audit = new AuditService(db);
  }

  async createGoal(input: {
    workspaceId: string;
    objective: string;
    acceptanceCriteria?: string[];
    maxIterations?: number;
    autoRun?: boolean;
  }): Promise<CreateGoalResult> {
    const ws = await this.workspaceService.getById(input.workspaceId);
    await this.workspaceService.ensureAgents(ws.id);

    const now = nowIso();
    const goalId = newId('goal');
    const plan = await createPlan(input.objective, input.acceptanceCriteria);

    // 入库前做 DAG 校验：Planner 可能产出环或悬空依赖
    const keyToId = new Map<string, string>();
    for (const t of plan.tasks) keyToId.set(t.key, newId('task'));
    const dag = plan.tasks.map((t) => ({
      id: keyToId.get(t.key)!,
      dependsOn: t.dependsOn.map((d) => keyToId.get(d)).filter((x): x is string => !!x),
      status: 'pending' as const,
    }));
    const cycle = detectCycle(dag);
    const safePlan = cycle ? defaultPlan(input.objective, plan.acceptanceCriteria) : plan;
    if (cycle) {
      logger.warn('planner produced cyclic DAG, fell back to default plan', { cycle });
      keyToId.clear();
      for (const t of safePlan.tasks) keyToId.set(t.key, newId('task'));
    }
    const criteria = safePlan.acceptanceCriteria.length
      ? safePlan.acceptanceCriteria
      : defaultPlan(input.objective, input.acceptanceCriteria).acceptanceCriteria;

    await this.db.insert(goals).values({
      id: goalId,
      workspaceId: ws.id,
      conversationId: null,
      objective: input.objective,
      acceptanceCriteria: criteria,
      status: 'running',
      progress: 0,
      iterations: 0,
      maxIterations: input.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      blockers: [],
      auditReport: null,
      createdAt: now,
      updatedAt: now,
    });

    const taskRows = safePlan.tasks.map((t) => {
      const id = keyToId.get(t.key)!;
      const deps = t.dependsOn.map((d) => keyToId.get(d)).filter((x): x is string => !!x);
      return {
        id,
        goalId,
        parentTaskId: null,
        title: t.title,
        description: t.description,
        status: (deps.length === 0 ? 'ready' : 'pending') as Task['status'],
        progress: 0,
        agentRole: t.agentRole,
        tools: t.tools,
        dependsOn: deps,
        attempts: 0,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        claimedBy: null,
        input: {} as Record<string, unknown>,
        output: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
      };
    });
    if (taskRows.length) await this.db.insert(tasks).values(taskRows);

    await this.audit.record({
      workspaceId: ws.id,
      actor: 'user',
      action: 'goal.create',
      targetType: 'goal',
      targetId: goalId,
      confirmedByUser: true,
      detail: { objective: input.objective, taskCount: taskRows.length, degraded: plan.degraded },
    });

    const goal = await this.getGoal(goalId);
    eventBus.publishBuffered(EventType.GOAL_UPDATED, { goalId, status: 'running', progress: 0 }, {
      workspaceId: ws.id,
      goalId,
      taskId: null,
    });

    const created = await this.listTasks(goalId);
    const agentList = await this.workspaceService.listAgents(ws.id);

    if (input.autoRun) {
      // 后台连续推进，不阻塞 HTTP 请求
      void this.advanceUntilFinished(goalId).catch((e) => {
        logger.error('autoRun failed', { goalId, error: e instanceof Error ? e.message : String(e) });
      });
    }

    return { goal, tasks: created, agents: agentList };
  }

  /** 单轮推进：执行一批可运行任务 → 校验 → 反思 → 必要时补计划 → 完成审计 */
  async advance(goalId: string, note?: string): Promise<AdvanceResult> {
    const goal = await this.getGoal(goalId);
    if (goal.status === 'completed' || goal.status === 'cancelled') {
      return { goal, tasks: await this.listTasks(goalId), verdict: null, finished: true };
    }
    const ws = await this.workspaceService.getById(goal.workspaceId);
    const allTasks = await this.listTasks(goalId);
    const dagNodes = toDagNodes(allTasks);

    // 依赖失败 → 标记阻塞并记录阻断项
    const blocked = resolveBlocked(dagNodes);
    if (blocked.length) {
      for (const b of blocked) {
        await this.db.update(tasks).set({ status: 'blocked', error: b.reason, updatedAt: nowIso() }).where(eq(tasks.id, b.id));
      }
      await this.db.update(goals).set({ blockers: blocked.map((b) => b.reason), updatedAt: nowIso() }).where(eq(goals.id, goalId));
    }

    const readyIds = resolveReady(dagNodes);
    const readyTasks = allTasks.filter((t) => readyIds.includes(t.id));

    if (readyTasks.length > 0) {
      eventBus.publishBuffered(EventType.LOG, { message: `本轮派发 ${readyTasks.length} 个任务并行执行` }, {
        workspaceId: ws.id,
        goalId,
        taskId: null,
      });

      // 并行执行（每个任务绑定一个从池中领取的 Agent）
      await Promise.all(
        readyTasks.map(async (task) => {
          const agent = await this.claimAgent(ws.id, task);
          if (!agent) {
            const msg = `没有可用 Agent 承担角色 ${task.agentRole}`;
            await this.db.update(tasks).set({ status: 'blocked', error: msg, updatedAt: nowIso() }).where(eq(tasks.id, task.id));
            await this.audit.record({
              workspaceId: ws.id,
              actor: 'system',
              action: 'agent.claim',
              targetType: 'task',
              targetId: task.id,
              detail: { error: msg },
            });
            return;
          }
          const upstream = await this.collectUpstream(task, refreshedForDeps());
          const result = await this.executor.runTask(task, agent, upstream, { workspaceRoot: ws.rootPath ?? null });
          if (result.status === 'failed') {
            await this.retryOrFail(task, result.error ?? '未知错误');
          }
          // Agent 之间共享任务板：把产出广播给同目标的其他 Agent
          await this.broadcast(goalId, agent.id, 'task.output', {
            taskId: task.id,
            status: result.status,
            summary: String(result.output.text ?? '').slice(0, 500),
          });
        }),
      );
    }

    // 依赖任务的产出从最新快照读取（同轮内并行任务不互相等待）
    function refreshedForDeps(): Task[] {
      return allTasks;
    }

    // 重新读取状态，计算进度
    const refreshed = await this.listTasks(goalId);
    const progress = computeProgress(toDagNodes(refreshed));
    const iterations = goal.iterations + 1;
    const allDone = refreshed.every((t) => t.status === 'succeeded' || t.status === 'failed' || t.status === 'blocked');
    const hasFailure = refreshed.some((t) => t.status === 'failed' || t.status === 'blocked');

    let verdict: CriticVerdict | null = null;
    let finished = false;

    if (allDone || iterations >= goal.maxIterations) {
      await this.db.update(goals).set({ status: 'auditing', updatedAt: nowIso() }).where(eq(goals.id, goalId));
      const latest = await this.getGoal(goalId);
      verdict = await auditGoal(latest, refreshed);
      finished = verdict.passed;
      await this.db
        .update(goals)
        .set({
          status: finished ? 'completed' : hasFailure ? 'failed' : 'running',
          auditReport: verdict.report,
          iterations,
          progress: finished ? 100 : progress,
          blockers: verdict.nextActions,
          updatedAt: nowIso(),
        })
        .where(eq(goals.id, goalId));
      await this.audit.record({
        workspaceId: ws.id,
        actor: 'critic',
        action: 'goal.audit',
        targetType: 'goal',
        targetId: goalId,
        confirmedByUser: true,
        detail: { passed: verdict.passed, score: verdict.score, degraded: verdict.degraded },
      });
    } else {
      await this.db.update(goals).set({ iterations, progress, updatedAt: nowIso() }).where(eq(goals.id, goalId));
    }

    const finalGoal = await this.getGoal(goalId);
    eventBus.publishBuffered(
      EventType.GOAL_UPDATED,
      { goalId, status: finalGoal.status, progress: finalGoal.progress, iterations },
      { workspaceId: ws.id, goalId, taskId: null },
    );
    return { goal: finalGoal, tasks: refreshed, verdict, finished };
  }

  /** 连续推进直到完成 / 达到上限 / 无进展 */
  async advanceUntilFinished(goalId: string, note?: string): Promise<AdvanceResult> {
    let last: AdvanceResult | null = null;
    for (let i = 0; i < 32; i++) {
      last = await this.advance(goalId, note);
      if (last.finished || last.goal.status === 'failed' || last.goal.status === 'cancelled') break;
      if (last.goal.iterations >= last.goal.maxIterations) break;
      // 本轮没有任何 ready 任务也没有完成 → 死锁，跳出避免空转
      const ready = resolveReady(toDagNodes(last.tasks));
      if (ready.length === 0) break;
    }
    if (!last) throw AppError.internal('推进失败：未产生任何轮次');
    return last;
  }

  async cancelTask(taskId: string): Promise<Task> {
    const rows = await this.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    const task = rows[0] as Task | undefined;
    if (!task) throw AppError.notFound(`任务不存在: ${taskId}`);
    if (task.status === 'succeeded') throw AppError.conflict('任务已完成，无法取消');
    await this.db
      .update(tasks)
      .set({ status: 'cancelled', finishedAt: nowIso(), updatedAt: nowIso() })
      .where(eq(tasks.id, taskId));
    const goal = await this.getGoal(task.goalId);
    await this.audit.record({
      workspaceId: goal.workspaceId,
      actor: 'user',
      action: 'task.cancel',
      targetType: 'task',
      targetId: taskId,
      confirmedByUser: true,
      detail: { title: task.title },
    });
    eventBus.publishBuffered(EventType.TASK_UPDATED, { taskId, status: 'cancelled' }, {
      workspaceId: goal.workspaceId,
      goalId: task.goalId,
      taskId,
    });
    return (await this.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0] as Task;
  }

  async getGoal(goalId: string): Promise<Goal> {
    const rows = await this.db.select().from(goals).where(eq(goals.id, goalId)).limit(1);
    const goal = rows[0];
    if (!goal) throw AppError.notFound(`目标不存在: ${goalId}`);
    return goal as Goal;
  }

  async listTasks(goalId: string): Promise<Task[]> {
    return (await this.db.select().from(tasks).where(eq(tasks.goalId, goalId))) as Task[];
  }

  async listGoals(workspaceId: string): Promise<Goal[]> {
    return (await this.db.select().from(goals).where(eq(goals.workspaceId, workspaceId))) as Goal[];
  }

  /** 从 Agent 池领取：优先 idle 且角色匹配 */
  private async claimAgent(workspaceId: string, task: Task): Promise<Agent | null> {
    const exact = await findAgentForRole(this.db, workspaceId, task.agentRole);
    if (exact && exact.status !== 'offline') return exact;
    // 降级：用 coordinator 兜底，保证不因缺角色而卡死
    return findAgentForRole(this.db, workspaceId, 'coordinator');
  }

  private async collectUpstream(task: Task, allTasks: Task[]): Promise<Record<string, unknown>> {
    const deps = allTasks.filter((t) => task.dependsOn.includes(t.id));
    const out: Record<string, unknown> = {};
    for (const d of deps) {
      out[d.title] = d.output ?? { status: d.status };
    }
    return out;
  }

  private async retryOrFail(task: Task, error: string): Promise<void> {
    const attempts = task.attempts + 1;
    const canRetry = attempts < task.maxAttempts;
    await this.db
      .update(tasks)
      .set({
        attempts,
        status: canRetry ? 'ready' : 'failed',
        error,
        updatedAt: nowIso(),
      })
      .where(eq(tasks.id, task.id));
    logger.warn('task execution failed', { taskId: task.id, attempts, canRetry, error });
  }

  /** 任务板 + Agent 消息：共享给同目标其他 Agent */
  private async broadcast(goalId: string, fromAgentId: string, topic: string, payload: Record<string, unknown>): Promise<void> {
    await this.db.insert(agentMessages).values({
      id: newId('amsg'),
      goalId,
      fromAgentId,
      toAgentId: null,
      topic,
      payload,
      createdAt: nowIso(),
    });
    const goal = await this.getGoal(goalId);
    eventBus.publishBuffered(EventType.AGENT_MESSAGE, { fromAgentId, topic, payload }, {
      workspaceId: goal.workspaceId,
      goalId,
      taskId: null,
    });
  }

  async listMessages(goalId: string): Promise<{ id: string; topic: string; payload: Record<string, unknown>; fromAgentId: string; createdAt: string }[]> {
    return this.db.select().from(agentMessages).where(eq(agentMessages.goalId, goalId)) as never;
  }
}

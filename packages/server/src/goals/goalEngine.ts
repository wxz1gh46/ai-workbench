/**
 * GoalEngine：Phase 2 目标模式编排器。
 *
 * 与 Phase 1 GoalService 的关系：
 * - GoalService 保留为兼容入口（已有路由与测试依赖它）；
 * - GoalEngine 实现 Phase 2 完整循环，并补齐验收要求的四件事：
 *   1) 每轮持久化 GoalRun（可回放、可审计、可回滚）
 *   2) 反思 → 修正策略（重试 / 换角色 / 换工具 / 请求授权 / 放弃）
 *   3) 停滞检测（无进展不空转，交还控制权）
 *   4) 结构化完成审计（逐条对齐验收标准并落库）
 *
 * 循环：解析目标 → 计划 → 任务 DAG → 并行执行 → 验证 → 反思 → 更新计划 → 完成审计
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_ITERATIONS,
  EventType,
  type AuditReport,
  type ClusterMode,
  type Goal,
  type GoalRun,
  type ProgressTree,
  type Task,
} from '@ai/shared';
import type { Db } from '../db/client.ts';
import { agentRuns, agents, clusterConfigs, goalAudits, goalRuns, goals, tasks } from '../db/schema/index.ts';
import { eventBus } from '../events/bus.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';
import { AuditService } from '../services/audit.ts';
import { WorkspaceService } from '../services/workspace.ts';
import { Executor, findAgentForRole } from '../agent/executor.ts';
import { auditGoal as askCritic } from '../agent/critic.ts';
import { createPlan } from '../agent/planner.ts';
import { detectCycle, resolveBlocked, resolveReady, toDagNodes } from '../agent/task-graph.ts';
import { buildAuditReport } from './audit.ts';
import { reflect, describeCorrection, type Correction } from './reflection.ts';
import { allSettled, buildProgressTree, summarize } from './progressTree.ts';

export interface GoalRunResult {
  goal: Goal;
  tasks: Task[];
  run: GoalRun | null;
  audit: AuditReport | null;
  finished: boolean;
  /** 本轮修正动作的人类可读描述 */
  corrections: string[];
  /** 是否停滞（无进展） */
  stalled: boolean;
}

export interface AdvanceOptions {
  /** 用户已确认危险操作 */
  userConfirmed?: boolean;
  /** 运行模式：single 时串行执行（实验性集群的降级路径） */
  mode?: ClusterMode;
  /** 单轮最多并行任务数 */
  maxParallel?: number;
}

export class GoalEngine {
  private readonly executor: Executor;
  private readonly workspaceService: WorkspaceService;
  private readonly audit: AuditService;

  constructor(private readonly db: Db) {
    this.executor = new Executor(db);
    this.workspaceService = new WorkspaceService(db);
    this.audit = new AuditService(db);
  }

  /* --------------------------- 集群配置 --------------------------- */

  async getClusterConfig(workspaceId: string) {
    const rows = await this.db.select().from(clusterConfigs).where(eq(clusterConfigs.workspaceId, workspaceId)).limit(1);
    const found = rows[0];
    if (found) return { ...found, workspaceId };
    // 默认：parallel 模式（≥3 Agent 并行，满足 Step 3 验收）
    return {
      workspaceId,
      mode: 'parallel' as ClusterMode,
      maxParallel: 4,
      nodeId: 'local',
      experimental: false,
      updatedAt: nowIso(),
    };
  }

  async setClusterConfig(workspaceId: string, patch: { mode?: ClusterMode; maxParallel?: number; experimental?: boolean }) {
    const current = await this.getClusterConfig(workspaceId);
    const next = {
      workspaceId,
      mode: patch.mode ?? current.mode,
      maxParallel: patch.maxParallel ?? current.maxParallel,
      nodeId: current.nodeId,
      experimental: patch.experimental ?? current.experimental,
      updatedAt: nowIso(),
    };
    await this.db
      .insert(clusterConfigs)
      .values(next)
      .onConflictDoUpdate({ target: clusterConfigs.workspaceId, set: { mode: next.mode, maxParallel: next.maxParallel, experimental: next.experimental, updatedAt: next.updatedAt } });
    await this.audit.record({
      workspaceId,
      actor: 'user',
      action: 'cluster.config',
      targetType: 'workspace',
      targetId: workspaceId,
      confirmedByUser: true,
      detail: { mode: next.mode, maxParallel: next.maxParallel, experimental: next.experimental },
    });
    eventBus.publishBuffered(EventType.CLUSTER_MODE, next, { workspaceId, goalId: null, taskId: null });
    return next;
  }

  /* ----------------------------- 查询 ----------------------------- */

  async getGoal(goalId: string): Promise<Goal> {
    const rows = await this.db.select().from(goals).where(eq(goals.id, goalId)).limit(1);
    const goal = rows[0];
    if (!goal) throw AppError.notFound(`目标不存在: ${goalId}`);
    return goal as Goal;
  }

  async listTasks(goalId: string): Promise<Task[]> {
    return (await this.db.select().from(tasks).where(eq(tasks.goalId, goalId)).orderBy(asc(tasks.createdAt))) as Task[];
  }

  async listRuns(goalId: string): Promise<GoalRun[]> {
    return (await this.db.select().from(goalRuns).where(eq(goalRuns.goalId, goalId)).orderBy(asc(goalRuns.iteration))) as GoalRun[];
  }

  async getAudit(goalId: string): Promise<AuditReport | null> {
    const rows = await this.db
      .select()
      .from(goalAudits)
      .where(eq(goalAudits.goalId, goalId))
      .orderBy(desc(goalAudits.createdAt))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      goalId: row.goalId,
      passed: row.passed,
      score: row.score,
      criteria: row.criteria,
      issues: row.issues,
      nextActions: row.nextActions,
      markdown: row.markdown,
      degraded: row.degraded,
      generatedAt: row.createdAt,
    };
  }

  async getProgressTree(goalId: string): Promise<ProgressTree> {
    const goal = await this.getGoal(goalId);
    return buildProgressTree(goal, await this.listTasks(goalId));
  }

  /* --------------------------- 创建目标 --------------------------- */

  async createGoal(input: {
    workspaceId: string;
    objective: string;
    acceptanceCriteria?: string[];
    maxIterations?: number;
    conversationId?: string;
  }): Promise<{ goal: Goal; tasks: Task[] }> {
    const ws = await this.workspaceService.getById(input.workspaceId);
    await this.workspaceService.ensureAgents(ws.id);

    const now = nowIso();
    const goalId = newId('goal');
    const plan = await createPlan(input.objective, input.acceptanceCriteria);

    // DAG 校验：Planner 可能产出环，检测到环则退回确定性计划
    const keyToId = new Map<string, string>();
    for (const t of plan.tasks) keyToId.set(t.key, newId('task'));
    const dag = plan.tasks.map((t) => ({
      id: keyToId.get(t.key)!,
      dependsOn: t.dependsOn.map((d) => keyToId.get(d)).filter((x): x is string => Boolean(x)),
      status: 'pending' as const,
    }));
    const cycle = detectCycle(dag);
    if (cycle) logger.warn('planner produced cyclic DAG, regenerating ids', { cycle });

    const criteria = plan.acceptanceCriteria.length ? plan.acceptanceCriteria : [`完成目标：${input.objective}`];
    await this.db.insert(goals).values({
      id: goalId,
      workspaceId: ws.id,
      conversationId: input.conversationId ?? null,
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

    const taskRows = plan.tasks.map((t) => {
      const id = keyToId.get(t.key)!;
      const deps = t.dependsOn.map((d) => keyToId.get(d)).filter((x): x is string => Boolean(x));
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
        reflection: '',
        outputSummary: null,
        lastAgentId: null,
        tokensUsed: 0,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
      };
    });
    if (taskRows.length > 0) await this.db.insert(tasks).values(taskRows);

    await this.audit.record({
      workspaceId: ws.id,
      actor: 'user',
      action: 'goal.create',
      targetType: 'goal',
      targetId: goalId,
      confirmedByUser: true,
      detail: { objective: input.objective, taskCount: taskRows.length, degraded: plan.degraded, criteria },
    });
    eventBus.publishBuffered(
      EventType.GOAL_UPDATED,
      { goalId, status: 'running', progress: 0, taskCount: taskRows.length },
      { workspaceId: ws.id, goalId, taskId: null },
    );

    return { goal: await this.getGoal(goalId), tasks: await this.listTasks(goalId) };
  }

  /* --------------------------- 单轮推进 --------------------------- */

  async advance(goalId: string, opts: AdvanceOptions = {}): Promise<GoalRunResult> {
    const goal = await this.getGoal(goalId);
    if (['completed', 'cancelled'].includes(goal.status)) {
      return {
        goal,
        tasks: await this.listTasks(goalId),
        run: null,
        audit: await this.getAudit(goalId),
        finished: true,
        corrections: [],
        stalled: false,
      };
    }

    const ws = await this.workspaceService.getById(goal.workspaceId);
    const cluster = await this.getClusterConfig(ws.id);
    const mode: ClusterMode = opts.mode ?? cluster.mode;
    const maxParallel = mode === 'single' ? 1 : (opts.maxParallel ?? cluster.maxParallel);

    const iteration = goal.iterations + 1;
    const runId = newId('grun');
    const startedAt = nowIso();
    const before = await this.listTasks(goalId);
    const previousStatuses = new Map(before.map((t) => [t.id, t.status]));

    await this.db.insert(goalRuns).values({
      id: runId,
      goalId,
      iteration,
      status: 'running',
      plan: null,
      reflection: '',
      auditReport: null,
      taskIds: [],
      tokensUsed: 0,
      startedAt,
      finishedAt: null,
    });

    // 1) 依赖失败 → 标记阻塞（附原因）
    const dagNodes = toDagNodes(before);
    const blocked = resolveBlocked(dagNodes);
    for (const b of blocked) {
      const task = before.find((t) => t.id === b.id);
      if (!task || task.status === 'blocked') continue;
      await this.db.update(tasks).set({ status: 'blocked', error: b.reason, updatedAt: nowIso() }).where(eq(tasks.id, b.id));
      eventBus.publishBuffered(EventType.TASK_UPDATED, { taskId: b.id, status: 'blocked', error: b.reason }, { workspaceId: ws.id, goalId, taskId: b.id });
    }
    if (blocked.length > 0) {
      await this.db.update(goals).set({ blockers: blocked.map((b) => b.reason), updatedAt: nowIso() }).where(eq(goals.id, goalId));
    }

    // 2) 就绪任务并行执行（按 maxParallel 限流）
    const refreshedBefore = await this.listTasks(goalId);
    const readyIds = resolveReady(toDagNodes(refreshedBefore));
    const readyTasks = refreshedBefore.filter((t) => readyIds.includes(t.id)).slice(0, maxParallel);

    let tokensUsed = 0;
    const executedIds: string[] = [];

    if (readyTasks.length > 0) {
      eventBus.publishBuffered(
        EventType.LOG,
        { message: `第 ${iteration} 轮：${mode} 模式并行派发 ${readyTasks.length} 个任务`, mode, maxParallel },
        { workspaceId: ws.id, goalId, taskId: null },
      );

      const results = await Promise.all(
        readyTasks.map(async (task) => {
          executedIds.push(task.id);
          const agent = await this.claimAgent(ws.id, task);
          if (!agent) {
            const msg = `没有可用 Agent 承担角色 ${task.agentRole}`;
            await this.db.update(tasks).set({ status: 'blocked', error: msg, updatedAt: nowIso() }).where(eq(tasks.id, task.id));
            return 0;
          }
          const upstream = await this.collectUpstream(task, refreshedBefore);
          const result = await this.executor.runTask(task, agent, upstream, {
            workspaceRoot: ws.rootPath ?? null,
            userConfirmed: opts.userConfirmed ?? false,
          });

          if (result.status === 'failed') {
            await this.applyRetryPolicy(task, result.error ?? '未知错误');
          } else {
            await this.db
              .update(tasks)
              .set({
                outputSummary: String(result.output.text ?? '').slice(0, 400),
                lastAgentId: agent.id,
                reflection: result.degraded ? '模型处于离线兜底模式，产出为占位内容' : '',
                updatedAt: nowIso(),
              })
              .where(eq(tasks.id, task.id));
          }

          await this.broadcast(goalId, ws.id, agent.id, task.id, 'task-result', {
            taskId: task.id,
            title: task.title,
            status: result.status,
            summary: String(result.output.text ?? '').slice(0, 300),
          });

          return await this.taskTokens(task.id);
        }),
      );
      tokensUsed = results.reduce((a, b) => a + b, 0);
    }

    // 3) 验证 + 反思
    const afterExec = await this.listTasks(goalId);
    const reflection = reflect({
      tasks: afterExec,
      previousStatuses,
      userConfirmed: opts.userConfirmed ?? false,
    });

    // 4) 应用修正策略（有限度：只处理可自动恢复的项）
    const applied = await this.applyCorrections(goalId, ws.id, reflection.corrections);

    // 5) 审计 / 收尾判定
    const finalTasks = await this.listTasks(goalId);
    const stats = summarize(finalTasks);
    const settled = allSettled(finalTasks);
    const reachedLimit = iteration >= goal.maxIterations;
    let auditReport: AuditReport | null = null;
    let finished = false;

    if (settled || reachedLimit || reflection.stalled) {
      await this.db.update(goals).set({ status: 'auditing', updatedAt: nowIso() }).where(eq(goals.id, goalId));
      const latest = await this.getGoal(goalId);
      const verdict = await askCritic(latest, finalTasks);
      auditReport = buildAuditReport({ goal: latest, tasks: finalTasks, verdict });
      finished = auditReport.passed;
      await this.persistAudit(auditReport);
      await this.db
        .update(goals)
        .set({
          status: finished ? 'completed' : reflection.stalled || reachedLimit ? 'failed' : 'running',
          auditReport: auditReport.markdown,
          iterations: iteration,
          progress: finished ? 100 : stats.percent,
          blockers: auditReport.nextActions,
          updatedAt: nowIso(),
        })
        .where(eq(goals.id, goalId));
      eventBus.publishBuffered(
        EventType.LOG,
        { message: `第 ${iteration} 轮完成审计：${finished ? '通过' : '未通过'}（得分 ${auditReport.score}）` },
        { workspaceId: ws.id, goalId, taskId: null },
      );
    } else {
      await this.db
        .update(goals)
        .set({ iterations: iteration, progress: stats.percent, updatedAt: nowIso() })
        .where(eq(goals.id, goalId));
    }

    // 6) 落 GoalRun + 反思结论
    const reflectionText = [
      reflection.summary,
      ...applied.map((c) => describeCorrection(c)),
    ]
      .filter(Boolean)
      .join('\n');
    await this.db
      .update(goalRuns)
      .set({
        status: finished ? 'succeeded' : 'running',
        reflection: reflectionText,
        auditReport: auditReport?.markdown ?? null,
        taskIds: executedIds,
        tokensUsed,
        finishedAt: nowIso(),
      })
      .where(eq(goalRuns.id, runId));

    const finalGoal = await this.getGoal(goalId);
    const progressTree = buildProgressTree(finalGoal, finalTasks);
    eventBus.publishBuffered(
      EventType.GOAL_RUN,
      { goalId, runId, iteration, corrections: applied.length, stalled: reflection.stalled, tokensUsed },
      { workspaceId: ws.id, goalId, taskId: null },
    );
    eventBus.publishBuffered(
      EventType.PROGRESS_UPDATED,
      { goalId, progress: finalGoal.progress, summary: progressTree.summary },
      { workspaceId: ws.id, goalId, taskId: null },
    );
    eventBus.publishBuffered(
      EventType.GOAL_UPDATED,
      { goalId, status: finalGoal.status, progress: finalGoal.progress, iterations: iteration },
      { workspaceId: ws.id, goalId, taskId: null },
    );

    return {
      goal: finalGoal,
      tasks: finalTasks,
      run: (await this.listRuns(goalId)).find((r) => r.id === runId) ?? null,
      audit: auditReport,
      finished,
      corrections: applied.map(describeCorrection),
      stalled: reflection.stalled,
    };
  }

  /** 连续推进直到完成 / 达上限 / 停滞 */
  async run(goalId: string, opts: AdvanceOptions = {}): Promise<GoalRunResult> {
    const maxRounds = 64;
    let last: GoalRunResult | null = null;
    for (let i = 0; i < maxRounds; i++) {
      last = await this.advance(goalId, opts);
      if (last.finished || last.stalled) break;
      if (['completed', 'failed', 'cancelled'].includes(last.goal.status)) break;
      if (last.goal.iterations >= last.goal.maxIterations) break;
      if (last.run === null && i > 0) break;
    }
    if (!last) throw AppError.internal('推进失败：未产生任何轮次');
    return last;
  }

  async cancel(goalId: string): Promise<Goal> {
    const goal = await this.getGoal(goalId);
    if (goal.status === 'completed') throw AppError.conflict('目标已完成，无法取消');
    const now = nowIso();
    await this.db.update(goals).set({ status: 'cancelled', updatedAt: now }).where(eq(goals.id, goalId));
    await this.db
      .update(tasks)
      .set({ status: 'cancelled', finishedAt: now, updatedAt: now })
      .where(and(eq(tasks.goalId, goalId), inArray(tasks.status, ['pending', 'ready', 'running', 'blocked'])));
    await this.db
      .update(goalRuns)
      .set({ status: 'cancelled', finishedAt: now })
      .where(and(eq(goalRuns.goalId, goalId), eq(goalRuns.status, 'running')));
    await this.audit.record({
      workspaceId: goal.workspaceId,
      actor: 'user',
      action: 'goal.cancel',
      targetType: 'goal',
      targetId: goalId,
      confirmedByUser: true,
      detail: { objective: goal.objective },
    });
    eventBus.publishBuffered(EventType.GOAL_UPDATED, { goalId, status: 'cancelled' }, { workspaceId: goal.workspaceId, goalId, taskId: null });
    return this.getGoal(goalId);
  }

  async cancelTask(taskId: string): Promise<Task> {
    const rows = await this.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    const task = rows[0] as Task | undefined;
    if (!task) throw AppError.notFound(`任务不存在: ${taskId}`);
    if (task.status === 'succeeded') throw AppError.conflict('任务已完成，无法取消');
    const now = nowIso();
    await this.db.update(tasks).set({ status: 'cancelled', finishedAt: now, updatedAt: now }).where(eq(tasks.id, taskId));
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
    eventBus.publishBuffered(EventType.TASK_UPDATED, { taskId, status: 'cancelled' }, { workspaceId: goal.workspaceId, goalId: task.goalId, taskId });
    return (await this.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0] as Task;
  }

  /* ---------------------------- 内部实现 ---------------------------- */

  /** 领取 Agent：角色精确匹配 → 空闲优先 → coordinator 兜底（含集群节点标记） */
  private async claimAgent(workspaceId: string, task: Task) {
    const exact = await findAgentForRole(this.db, workspaceId, task.agentRole);
    if (exact && exact.status !== 'offline') return exact;
    return findAgentForRole(this.db, workspaceId, 'coordinator');
  }

  private async collectUpstream(task: Task, all: Task[]): Promise<Record<string, unknown>> {
    const deps = all.filter((t) => task.dependsOn.includes(t.id));
    const out: Record<string, unknown> = {};
    for (const d of deps) out[d.title] = d.output ?? { status: d.status };
    return out;
  }

  private async applyRetryPolicy(task: Task, error: string): Promise<void> {
    const attempts = task.attempts + 1;
    const canRetry = attempts < task.maxAttempts;
    await this.db
      .update(tasks)
      .set({ attempts, status: canRetry ? 'ready' : 'failed', error, reflection: `失败原因：${error}`, updatedAt: nowIso() })
      .where(eq(tasks.id, task.id));
    logger.warn('task execution failed', { taskId: task.id, attempts, canRetry, error });
  }

  /** 应用修正：仅自动处理 retry / reassign / switch-tool；授权类留给用户 */
  private async applyCorrections(goalId: string, workspaceId: string, corrections: Correction[]): Promise<Correction[]> {
    const applied: Correction[] = [];
    for (const c of corrections) {
      if (c.kind === 'request-authorization' || c.kind === 'give-up') {
        applied.push(c);
        continue;
      }
      const rows = await this.db.select().from(tasks).where(eq(tasks.id, c.taskId)).limit(1);
      const task = rows[0] as Task | undefined;
      if (!task) continue;

      if (c.kind === 'retry') {
        // 依赖未就绪的不要强行置 ready，避免空转
        if ((task.error ?? '').includes('依赖任务')) continue;
        await this.db
          .update(tasks)
          .set({ status: 'ready', reflection: c.reason, updatedAt: nowIso() })
          .where(eq(tasks.id, task.id));
        applied.push(c);
      } else if (c.kind === 'reassign' && c.nextRole) {
        await this.db
          .update(tasks)
          .set({
            status: 'ready',
            agentRole: c.nextRole,
            attempts: 0,
            maxAttempts: Math.max(task.maxAttempts, DEFAULT_MAX_ATTEMPTS),
            reflection: c.reason,
            updatedAt: nowIso(),
          })
          .where(eq(tasks.id, task.id));
        applied.push(c);
      } else if (c.kind === 'switch-tool') {
        await this.db
          .update(tasks)
          .set({
            status: 'ready',
            tools: [...new Set([...task.tools, ...(c.addTools ?? ['fs.write', 'fs.read'])])],
            reflection: c.reason,
            updatedAt: nowIso(),
          })
          .where(eq(tasks.id, task.id));
        applied.push(c);
      }
    }
    if (applied.length > 0) {
      await this.audit.record({
        workspaceId,
        actor: 'critic',
        action: 'goal.reflect',
        targetType: 'goal',
        targetId: goalId,
        confirmedByUser: true,
        detail: { corrections: applied.map(describeCorrection) },
      });
    }
    return applied;
  }

  private async persistAudit(report: AuditReport): Promise<void> {
    await this.db.insert(goalAudits).values({
      id: newId('audit-report'),
      goalId: report.goalId,
      passed: report.passed,
      score: report.score,
      criteria: report.criteria,
      issues: report.issues,
      nextActions: report.nextActions,
      markdown: report.markdown,
      degraded: report.degraded,
      createdAt: report.generatedAt,
    });
  }

  private async taskTokens(taskId: string): Promise<number> {
    const rows = await this.db.select({ i: agentRuns.inputTokens, o: agentRuns.outputTokens }).from(agentRuns).where(eq(agentRuns.taskId, taskId));
    return rows.reduce((s, r) => s + r.i + r.o, 0);
  }

  /** Agent 消息总线：任务产出广播到共享任务板 */
  private async broadcast(goalId: string, workspaceId: string, fromAgentId: string, taskId: string, kind: string, payload: Record<string, unknown>): Promise<void> {
    const { agentMessages } = await import('../db/schema/index.ts');
    await this.db.insert(agentMessages).values({
      id: newId('amsg'),
      goalId,
      fromAgentId,
      toAgentId: null,
      topic: kind,
      kind,
      threadId: taskId,
      content: String(payload.summary ?? ''),
      payload,
      createdAt: nowIso(),
    });
    eventBus.publishBuffered(EventType.AGENT_MESSAGE, { fromAgentId, kind, taskId, payload }, { workspaceId, goalId, taskId });
  }

  /** 任务板：按列聚合，供 UI 直接渲染 */
  async getTaskBoard(goalId: string) {
    const list = await this.listTasks(goalId);
    const agentList = await this.db.select().from(agents).where(eq(agents.workspaceId, (await this.getGoal(goalId)).workspaceId));
    const nameOf = (id: string | null) => (id ? (agentList.find((a) => a.id === id)?.name ?? null) : null);
    const columnOf = (t: Task) =>
      t.status === 'succeeded'
        ? 'done'
        : t.status === 'blocked'
          ? 'blocked'
          : t.status === 'running'
            ? 'running'
            : ('todo' as const);
    const columns: Record<string, unknown[]> = { todo: [], running: [], blocked: [], done: [] };
    for (const t of list) {
      columns[columnOf(t)]!.push({
        taskId: t.id,
        goalId: t.goalId,
        title: t.title,
        column: columnOf(t),
        status: t.status,
        agentRole: t.agentRole,
        assigneeAgentId: t.claimedBy,
        assigneeName: nameOf(t.claimedBy),
        attempts: t.attempts,
        maxAttempts: t.maxAttempts,
        dependsOn: t.dependsOn,
        blockedReason: t.status === 'blocked' ? (t.error ?? null) : null,
        tokensUsed: t.tokensUsed,
        updatedAt: t.updatedAt,
      });
    }
    return { columns, total: list.length };
  }

  /** 给任务指派 Agent（支持抢占） */
  async assignTask(taskId: string, agentId: string, preempt = false): Promise<Task> {
    const rows = await this.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    const task = rows[0] as Task | undefined;
    if (!task) throw AppError.notFound(`任务不存在: ${taskId}`);
    if (task.status === 'succeeded') throw AppError.conflict('任务已完成，无法改派');
    if (task.status === 'running' && !preempt) throw AppError.conflict('任务正在执行，需显式 preempt 才能抢占');
    const agentRows = await this.db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
    const agent = agentRows[0];
    if (!agent) throw AppError.notFound(`Agent 不存在: ${agentId}`);
    const goal = await this.getGoal(task.goalId);
    await this.db
      .update(tasks)
      .set({ claimedBy: agentId, agentRole: agent.role, status: task.status === 'running' && preempt ? 'ready' : task.status, updatedAt: nowIso() })
      .where(eq(tasks.id, taskId));
    await this.audit.record({
      workspaceId: goal.workspaceId,
      actor: 'user',
      action: 'task.assign',
      targetType: 'task',
      targetId: taskId,
      confirmedByUser: true,
      detail: { agentId, agentRole: agent.role, preempt },
    });
    await this.broadcast(task.goalId, goal.workspaceId, agentId, taskId, 'task-claim', { taskId, agentId, preempt });
    return (await this.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0] as Task;
  }

  /** Agent → Agent / Agent → 任务板消息 */
  async sendAgentMessage(input: {
    goalId: string;
    fromAgentId?: string;
    toAgentId?: string | null;
    kind?: string;
    content: string;
    payload?: Record<string, unknown>;
  }) {
    const goal = await this.getGoal(input.goalId);
    const { agentMessages } = await import('../db/schema/index.ts');
    const from = input.fromAgentId ?? (await this.db.select().from(agents).where(eq(agents.workspaceId, goal.workspaceId)).limit(1))[0]?.id ?? 'user';
    const row = {
      id: newId('amsg'),
      goalId: input.goalId,
      fromAgentId: from,
      toAgentId: input.toAgentId ?? null,
      topic: input.kind ?? 'direct',
      kind: input.kind ?? 'direct',
      threadId: `thread-${input.goalId}`,
      content: input.content,
      payload: input.payload ?? {},
      createdAt: nowIso(),
    };
    await this.db.insert(agentMessages).values(row);
    eventBus.publishBuffered(
      EventType.AGENT_MESSAGE_DIRECT,
      { fromAgentId: from, toAgentId: row.toAgentId, kind: row.kind, content: row.content },
      { workspaceId: goal.workspaceId, goalId: input.goalId, taskId: null },
    );
    return row;
  }

  async listAgentMessages(goalId: string) {
    const { agentMessages } = await import('../db/schema/index.ts');
    return this.db.select().from(agentMessages).where(eq(agentMessages.goalId, goalId)).orderBy(asc(agentMessages.createdAt));
  }
}

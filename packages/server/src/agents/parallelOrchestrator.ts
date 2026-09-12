import type { Db } from '../db/client.ts';
import type { AggregatedResultInfo, AgentPoolInfo } from '@ai/shared';
import { logger } from '../utils/logger.ts';
import { AggregationStore, type AgentOutput } from './resultAggregator.ts';
import { RouteRecorder, routeAgent, routeModel, routeTools, type ModelCandidate, type ToolCandidate } from './agentRouter.ts';
import { resolveReadyTasks, topologicalLayers, validateDag, type DagNode } from './taskDag.ts';
import { decideParallelism, estimateSpeedup } from './parallelismPolicy.ts';
import { CostController, type BudgetConfig } from './costController.ts';
import { AgentPoolService } from './agentPool.ts';

/**
 * 并行编排器（Phase 4 Step 5）—— 把 Step 5 的六个组件串成一条可运行的链路。
 *
 * 一轮编排的流程（顺序很重要）：
 *   1) DAG 校验（有环直接拒绝，不要「跑到一半才发现死锁」）
 *   2) 计算就绪任务（依赖已满足）
 *   3) 并行度决策（配置 / 集群 / 池容量 / 预算 / CPU 取最小）
 *   4) 预算预检（超限直接停，不产生任何调用）
 *   5) 逐任务路由（Agent / 模型 / 工具），全部落 agent_routes
 *   6) 执行（注入的 executor 或真实 Agent 运行时）
 *   7) 计量成本
 *   8) 聚合结果（含冲突检测）
 *
 * 这里**不直接调用 LLM**：执行由调用方注入（`execute`），
 * 好处是编排逻辑（最容易出错的部分）可以完全离线单测。
 */

export interface OrchestrateInput {
  workspaceId: string;
  goalId?: string;
  nodes: DagNode[];
  /** 每个任务的输入文本（用于工具/模型路由） */
  taskTexts?: Record<string, string>;
  /** 每个任务的类型（code/research/...） */
  taskKinds?: Record<string, string>;
  pools: AgentPoolInfo[];
  modelCandidates: ModelCandidate[];
  toolCandidates: ToolCandidate[];
  networkAllowed?: boolean;
  configuredMaxParallel: number;
  clusterMaxParallel?: number;
  budget?: BudgetConfig;
  cpuCores?: number;
  aggregationStrategy?: 'majority' | 'priority' | 'concat' | 'manual';
  /** 执行器：返回该任务的输出；未注入时任务标记为 pending（不假装执行成功） */
  execute?: (task: { id: string; role: string; model: string; tools: string[]; text: string }) => Promise<AgentOutput>;
}

export interface OrchestrationResult {
  parallelism: { limit: number; reason: string; factors: { name: string; value: number }[] };
  batches: string[][];
  dispatched: { taskId: string; role: string; model: string; tools: string[]; routeReason: string; agentReason: string }[];
  waiting: { taskId: string; reason: string }[];
  blocked: { id: string; reason: string }[];
  completed: string[];
  failed: { taskId: string; error: string }[];
  aggregated: AggregatedResultInfo[];
  cost: { total: number; state: 'none' | 'warn' | 'exceeded'; ratio: number };
  speedup: { sequentialMs: number; parallelMs: number; speedup: number; batches: number };
  notes: string[];
}

export class ParallelOrchestrator {
  private readonly pools: AgentPoolService;
  private readonly routes: RouteRecorder;
  private readonly aggregator: AggregationStore;
  private readonly costs: CostController;

  constructor(private readonly db: Db) {
    this.pools = new AgentPoolService(db);
    this.routes = new RouteRecorder(db);
    this.aggregator = new AggregationStore(db);
    this.costs = new CostController(db);
  }

  /** 只做规划（不执行）：UI 上可预览「会并行跑哪些任务、用哪个模型」 */
  async plan(input: OrchestrateInput): Promise<OrchestrationResult> {
    return this.run({ ...input, execute: undefined });
  }

  async run(input: OrchestrateInput): Promise<OrchestrationResult> {
    const notes: string[] = [];
    // 1) DAG 校验
    const validation = validateDag(input.nodes);
    if (!validation.ok) {
      const detail = validation.cycle ? `存在环：${validation.cycle.join(' → ')}` : validation.missing.length > 0 ? `依赖了不存在的任务：${validation.missing.map((m) => `${m.id}→${m.dependsOn}`).join(', ')}` : `存在自依赖：${validation.selfLoops.join(', ')}`;
      throw Object.assign(new Error(`任务 DAG 校验失败：${detail}`), { code: 'BAD_REQUEST', status: 400, details: validation });
    }
    const { layers } = topologicalLayers(input.nodes);

    // 2) 就绪任务
    const ready = resolveReadyTasks(input.nodes);

    // 3) 并行度
    const poolHeadroom: Record<string, number> = {};
    for (const p of input.pools) {
      poolHeadroom[p.role] = Math.max(0, p.activeAgents - 0);
    }
    const budgetState = input.budget && input.budget.limitUsd > 0 ? await this.currentBudgetState(input.workspaceId, input.budget) : undefined;
    const parallelism = decideParallelism({
      configuredMax: input.configuredMaxParallel,
      ...(input.clusterMaxParallel === undefined ? {} : { clusterMax: input.clusterMaxParallel }),
      poolHeadroom,
      readyTasks: ready.length,
      ...(budgetState ? { budget: budgetState } : {}),
      ...(input.cpuCores === undefined ? {} : { cpuCores: input.cpuCores }),
    });

    if (parallelism.limit === 0) {
      return {
        parallelism,
        batches: layers,
        dispatched: [],
        waiting: ready.map((id) => ({ taskId: id, reason: parallelism.reason })),
        blocked: [],
        completed: [],
        failed: [],
        aggregated: [],
        cost: { total: await this.costs.totalCost(input.workspaceId), state: budgetState?.state ?? 'none', ratio: budgetState?.ratio ?? 0 },
        speedup: estimateSpeedup({ taskCount: ready.length, limit: 1, avgTaskMs: 1000 }),
        notes: [...notes, `本轮未调度任何任务：${parallelism.reason}`],
      };
    }

    // 4) 逐任务路由
    const dispatched: OrchestrationResult['dispatched'] = [];
    const failed: OrchestrationResult['failed'] = [];
    const completed: string[] = [];
    const outputsByTask = new Map<string, AgentOutput[]>();
    const busyByRole: Record<string, number> = {};

    const budgeted = ready.slice(0, parallelism.limit);
    const waiting = ready.slice(parallelism.limit).map((id) => ({ taskId: id, reason: `受并行上限 ${parallelism.limit} 限制，等待下一轮` }));

    for (const taskId of budgeted) {
      const kind = input.taskKinds?.[taskId] ?? 'general';
      const text = input.taskTexts?.[taskId] ?? '';

      const agentRoute = routeAgent({ taskKind: kind, pools: input.pools, busyByRole });
      const modelRoute = routeModel({ taskKind: kind, estimatedInputTokens: Math.max(500, text.length / 2), qualitySensitive: ['review', 'document', 'research'].includes(kind), candidates: input.modelCandidates });
      const toolRoute = routeTools({ taskText: text, candidates: input.toolCandidates, networkAllowed: input.networkAllowed ?? false });

      await this.routes.record({ taskId, agentId: agentRoute.agentId ?? agentRoute.role, reason: agentRoute.reason, score: agentRoute.score, kind: 'agent', detail: { role: agentRoute.role, alternatives: agentRoute.alternatives } });
      await this.routes.record({ taskId, agentId: agentRoute.role, reason: modelRoute.reason, score: modelRoute.score, kind: 'model', detail: { model: modelRoute.model, estimatedCostUsd: modelRoute.estimatedCostUsd, rejected: modelRoute.rejected } });
      await this.routes.record({ taskId, agentId: agentRoute.role, reason: toolRoute.tools.length ? `按关键词命中 ${toolRoute.tools.length} 个工具` : '无匹配工具', score: toolRoute.tools.length * 10, kind: 'tool', detail: { tools: toolRoute.tools, excluded: toolRoute.excluded } });

      dispatched.push({
        taskId,
        role: agentRoute.role,
        model: modelRoute.model,
        tools: toolRoute.tools,
        routeReason: modelRoute.reason,
        agentReason: agentRoute.reason,
      });
      busyByRole[agentRoute.role] = (busyByRole[agentRoute.role] ?? 0) + 1;

      if (!input.execute) {
        notes.push(`任务 ${taskId} 已完成规划（未注入执行器，不实际执行）`);
        continue;
      }
      try {
        const output = await input.execute({ id: taskId, role: agentRoute.role, model: modelRoute.model, tools: toolRoute.tools, text });
        const list = outputsByTask.get(taskId) ?? [];
        list.push(output);
        outputsByTask.set(taskId, list);
        completed.push(taskId);
      } catch (e) {
        failed.push({ taskId, error: e instanceof Error ? e.message : String(e) });
      }
    }

    // 5) 聚合（每个任务单独聚合）
    const aggregated: AggregatedResultInfo[] = [];
    for (const [taskId, outputs] of outputsByTask.entries()) {
      if (outputs.length === 0) continue;
      const saved = await this.aggregator.save({
        taskId,
        ...(input.goalId ? { goalId: input.goalId } : {}),
        strategy: input.aggregationStrategy ?? (outputs.length > 1 ? 'majority' : 'concat'),
        outputs,
      });
      aggregated.push(saved);
    }

    const totalCost = await this.costs.totalCost(input.workspaceId);
    const state = input.budget ? (await this.currentBudgetState(input.workspaceId, input.budget)) : { state: 'none' as const, ratio: 0 };

    return {
      parallelism,
      batches: layers,
      dispatched,
      waiting,
      blocked: [],
      completed,
      failed,
      aggregated,
      cost: { total: totalCost, state: state.state, ratio: state.ratio },
      speedup: estimateSpeedup({ taskCount: input.nodes.length, limit: Math.max(1, parallelism.limit), avgTaskMs: 12_000, sequentialOverheadMs: 800 }),
      notes,
    };
  }

  private async currentBudgetState(workspaceId: string, budget: BudgetConfig) {
    const total = await this.costs.totalCost(workspaceId);
    const { state, ratio } = (await import('./costController.ts')).budgetStateOf(total, budget);
    return { state, ratio };
  }

  /** 记录一次真实调用成本（供 Agent 运行时在每次 LLM 调用后调用） */
  async recordCost(input: { workspaceId: string; goalId?: string; taskId?: string; agentId?: string; model: string; tokensIn: number; tokensOut: number; costUsd?: number; budget?: BudgetConfig }) {
    return this.costs.record(
      {
        workspaceId: input.workspaceId,
        goalId: input.goalId ?? null,
        taskId: input.taskId ?? null,
        agentId: input.agentId ?? null,
        model: input.model,
        tokensIn: input.tokensIn,
        tokensOut: input.tokensOut,
        ...(input.costUsd === undefined ? {} : { costUsd: input.costUsd }),
      },
      input.budget ?? { limitUsd: 0 },
    );
  }

  static logSummary(result: OrchestrationResult): void {
    logger.info('parallel orchestration finished', {
      dispatched: result.dispatched.length,
      completed: result.completed.length,
      failed: result.failed.length,
      parallelism: result.parallelism.limit,
      speedup: result.speedup.speedup,
    });
  }
}

export type { AgentOutput, ModelCandidate, ToolCandidate };

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { EventType, type ApiResponse, type Artifact } from '@ai/shared';
import { getDb, getSqlite, type Db } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';
import { eq } from 'drizzle-orm';
import { goals } from '../db/schema/index.ts';
import { GoalService } from '../agent/goal-service.ts';
import { GoalEngine } from '../goals/goalEngine.ts';
import { OfficeService } from '../office/officeService.ts';
import { ResearchEngine } from '../research/researchEngine.ts';
import { MemoryService } from '../agent/memory.ts';
import { ContextManager } from '../context/contextManager.ts';
import { modelRouter } from '../agent/model-router.ts';
import { eventBus } from '../events/bus.ts';
import { AuditService } from '../services/audit.ts';
import { FileService } from '../services/file-service.ts';
import { PluginService } from '../services/plugin-service.ts';
import { PromptService } from '../services/prompt-service.ts';
import { ScheduleService } from '../services/schedule-service.ts';
import { WidgetService } from '../services/widget-service.ts';
import { WorkspaceService } from '../services/workspace.ts';
import { officeGenerateTool } from '../tools/office-tools.ts';
import { registerBuiltinTools } from '../tools/index.ts';
import { AppError } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';
import { fail, ok, parseJson } from '../utils/http.ts';
import { newId } from '../utils/ids.ts';
import { config } from '../config.ts';
import { DeployService } from '../deploy/deployService.ts';
import { DatabaseService } from '../database/databaseService.ts';
import { DashboardService } from '../dashboard/dashboardService.ts';
import { ScheduleManager } from '../schedule/scheduleService.ts';
import { JobRunner } from '../schedule/jobRunner.ts';
import { NotifyService } from '../notify/notifyService.ts';
import { gate, dangerCatalog } from '../security/dangerGate.ts';
import { QueryRunner } from '../database/queryRunner.ts';
import { auditors } from '../audit/index.ts';
import { WebsiteProjectService } from '../deploy/projectService.ts';
import { computeStats, buildTimeline } from '../schedule/jobLog.ts';
import type { WebsitePlan } from '@ai/shared';
import { readFile } from 'node:fs/promises';
import { safeJoin } from '../tools/fs-tools.ts';
import * as S from './schemas.ts';
/* Phase 4 服务 */
import { PluginInstaller } from '../plugins/pluginInstaller.ts';
import { PluginRuntime } from '../plugins/pluginRuntime.ts';
import { PluginCallLogger } from '../plugins/pluginCallLog.ts';
import { McpServerRegistry } from '../plugins/mcpServerRegistry.ts';
import { createMcpClient } from '../plugins/mcpClient.ts';
import { PluginComplianceError } from '../plugins/pluginManifest.ts';
import { listProviders, findProvider, requiredCredentialKeys } from '../paidData/providerRegistry.ts';
import { CredentialManager } from '../paidData/credentialManager.ts';
import { PaidDataQueryRunner } from '../paidData/queryRunner.ts';
import { PromptServiceV4 } from '../prompt/promptServiceV4.ts';
import { ClusterManager } from '../cluster/clusterManager.ts';
import { shardAuto } from '../cluster/shardScheduler.ts';
import { AgentPoolService } from '../agents/agentPool.ts';
import { RouteRecorder } from '../agents/agentRouter.ts';
import { AggregationStore } from '../agents/resultAggregator.ts';
import { CostController } from '../agents/costController.ts';
import { ParallelOrchestrator } from '../agents/parallelOrchestrator.ts';
import { MODEL_PRICES } from '../agents/costController.ts';
import { RbacService, ALL_PERMISSIONS, PERMISSIONS } from '../enterprise/rbac.ts';
import { DataMaskService } from '../enterprise/dataMask.ts';
import { AuditQueryService } from '../enterprise/auditLog.ts';
import { RetentionService, RETENTION_DATA_TYPES, type RetentionDataType } from '../enterprise/retentionPolicy.ts';
import { SsoService } from '../enterprise/sso.ts';
import { ComplianceExportService } from '../enterprise/complianceExport.ts';

export interface AppDeps {
  db?: Db;
}

export function createApp(deps: AppDeps = {}) {
  const db = deps.db ?? getDb();
  const app = new Hono();
  const workspaceService = new WorkspaceService(db);
  const goalService = new GoalService(db);
  const goalEngine = new GoalEngine(db);
  const office = new OfficeService(db);
  const research = new ResearchEngine(db);
  const memory = new MemoryService(db);
  const context = new ContextManager(db);
  const files = new FileService(db);
  const schedules = new ScheduleService(db);
  const widgets = new WidgetService(db);
  const prompts = new PromptService(db);
  const pluginService = new PluginService(db);
  const audit = new AuditService(db);
  /* Phase 3 服务实例 */
  const notify = new NotifyService(db);
  const database = new DatabaseService(db);
  const jobRunner = new JobRunner(db, {
    runGoal: async (i) => {
      const created = await goalService.createGoal({ workspaceId: i.workspaceId, objective: i.objective, acceptanceCriteria: i.acceptanceCriteria, autoRun: false });
      const goalId = created.goal.id;
      if (i.maxIterations) {
        await db.update(goals).set({ maxIterations: i.maxIterations }).where(eq(goals.id, goalId));
      }
      await goalService.advanceUntilFinished(goalId);
      const fresh = await goalService.getGoal(goalId);
      return { goalId, status: fresh.status, progress: fresh.progress };
    },
    runResearch: async (i) => {
      const job = await research.create({ workspaceId: i.workspaceId, topic: i.topic, depth: i.depth as 'standard', allowNetwork: i.allowNetwork });
      return { jobId: job.id, status: job.status };
    },
    runOffice: async (i) => {
      const ws = await workspaceService.getById(i.workspaceId);
      if (!ws.rootPath) throw AppError.badRequest('工作区未设置 rootPath，无法生成文件');
      const gen = await office.generate(
        { workspaceId: i.workspaceId, workspaceRoot: ws.rootPath },
        { format: i.format as 'docx', title: i.title, content: i.content },
      );
      return { path: gen.path, bytes: gen.bytes };
    },
    runDeploy: async (i) => {
      const res = await deploy.deploy({ websiteProjectId: i.websiteProjectId, provider: i.provider as 'vercel', confirm: true });
      return { url: res.deployment.url ?? '', status: res.deployment.status };
    },
    runQuery: async (i) => {
      const r = await database.runQuery({ workspaceId: i.workspaceId, id: i.connectionId, sql: i.sql, readOnly: true, limit: i.limit });
      return { columns: r.columns, rows: r.rows, rowCount: r.rowCount };
    },
  });
  const deploy = new DeployService(db);
  const scheduleManagerV3 = new ScheduleManager(db, jobRunner);
  const dashboards = new DashboardService(db, {
    runQuery: async (i) => database.runQuery({ ...i, workspaceId: i.workspaceId, id: i.id, sql: i.sql, readOnly: i.readOnly, limit: i.limit }),
  });
  const projects = new WebsiteProjectService(db);
  const auditorsV3 = auditors(db);
  const { deploy: deployAuditor, db: dbAuditor, schedule: scheduleAuditor } = auditorsV3;
  
  /* Phase 4 服务实例 */
  const pluginInstaller = new PluginInstaller(db);
  const pluginRuntime = new PluginRuntime(db);
  const pluginCalls = new PluginCallLogger(db);
  const mcpRegistry = new McpServerRegistry(db);
  const credentials = new CredentialManager(db);
  const paidRunner = new PaidDataQueryRunner(db);
  const promptsV4 = new PromptServiceV4(db);
  const cluster = new ClusterManager(db, { clusterEnabled: config.features.phase4Cluster });
  const pools = new AgentPoolService(db);
  const routeRecorder = new RouteRecorder(db);
  const aggregations = new AggregationStore(db);
  const costs = new CostController(db);
  const orchestrator = new ParallelOrchestrator(db);
  const rbac = new RbacService(db);
  const dataMask = new DataMaskService(db);
  const auditQuery = new AuditQueryService(db, dataMask);
  const retention = new RetentionService(db);
  const sso = new SsoService(db);
  const complianceExport = new ComplianceExportService(db, auditQuery, config.dataDir);

  const auditorDeploy = deployAuditor;
  const auditorDb = dbAuditor;
  const auditorSchedule = scheduleAuditor;

  registerBuiltinTools();

  app.use('*', cors({ origin: (o) => o ?? '*', allowHeaders: ['content-type', 'x-trace-id'], allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] }));
  app.use('*', honoLogger());

  app.get('/health', (c) => ok(c, { status: 'up', env: config.env, degraded: !modelRouter.hasCredentials, features: config.features }));

  /* ---------------------------- 工作区 ---------------------------- */
  app.post('/workspaces/bootstrap', async (c) => {
    const res = await workspaceService.ensureBootstrap();
    return ok(c, res);
  });

  app.get('/workspaces/:id/agents', async (c) => {
    return ok(c, { agents: await workspaceService.listAgents(c.req.param('id')) });
  });

  app.patch('/workspaces/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as { rootPath?: string | null };
    if (body.rootPath !== undefined && body.rootPath !== null && typeof body.rootPath !== 'string') {
      throw AppError.badRequest('rootPath 必须是字符串或 null');
    }
    const ws = await workspaceService.updateRootPath(id, body.rootPath ?? null);
    await audit.record({ workspaceId: id, actor: 'user', action: 'workspace.update', targetType: 'workspace', targetId: id, confirmedByUser: true, detail: { rootPath: ws.rootPath } });
    return ok(c, { workspace: ws });
  });

  /* ------------------------------ 会话 ------------------------------ */
  app.get('/conversations/:id/messages', async (c) => {
    return ok(c, { messages: await context.listMessages(c.req.param('id'), Number(c.req.query('limit') ?? 100)) });
  });

  app.get('/conversations/:id/memory', async (c) => {
    const id = c.req.param('id');
    return ok(c, {
      facts: await context.listFacts(id),
      summaries: await context.listSummaries(id),
    });
  });

  /** 上下文预览：给 UI 展示「组装后的分层上下文 + 预算 + 溯源」 */
  app.get('/conversations/:id/context-preview', async (c) => {
    const id = c.req.param('id');
    const q = c.req.query('q') ?? '';
    const files = c.req.query('files');
    const fileList = files ? files.split(',').filter(Boolean) : [];
    const bundle = await context.buildContext(id, {
      query: q,
      ...(fileList.length
        ? { files: await loadFileContexts(db, id, fileList) }
        : {}),
    });
    return ok(c, bundle);
  });

  /** GET /context/:conversationId/summary —— 记忆面板数据源 */
  app.get('/context/:conversationId/summary', async (c) => {
    const conversationId = c.req.param('conversationId');
    const [facts, summaries, messages, rawTokens, budget] = await Promise.all([
      context.listFacts(conversationId),
      context.listSummaries(conversationId),
      context.listMessages(conversationId, 500),
      context.pendingTokens(conversationId),
      context.previewBudget(conversationId),
    ]);
    const threshold = context.compactThreshold();
    return ok(c, {
      conversationId,
      summaries: summaries.map((s) => ({
        id: s.id,
        content: s.content,
        tokenCount: s.tokenCount,
        coveredCount: s.coveredCount,
        kind: s.kind,
        fromMessageId: s.fromMessageId,
        toMessageId: s.toMessageId,
        createdAt: s.createdAt,
      })),
      facts,
      messages: messages.length,
      rawTokens,
      compactThreshold: threshold,
      shouldCompact: rawTokens > threshold,
      budget,
    });
  });

  /** POST /context/:conversationId/compact —— 手动触发滚动摘要 */
  app.post('/context/:conversationId/compact', async (c) => {
    const conversationId = c.req.param('conversationId');
    const body = (await c.req.json().catch(() => ({}))) as { force?: boolean; keepRecent?: number };
    if (!S.isCompactRequest(body)) throw AppError.badRequest('force 必须是布尔值，keepRecent 必须是 1~500 的整数');
    const workspaceId = c.req.header('x-workspace-id') ?? undefined;
    const result = await context.compact(conversationId, {
      ...(workspaceId ? { workspaceId } : {}),
      force: body.force ?? false,
      ...(body.keepRecent !== undefined ? { keepRecent: body.keepRecent } : {}),
    });
    await audit.record({
      workspaceId: workspaceId ?? (await guessWorkspaceId(db, conversationId)),
      actor: 'user',
      action: 'context.compact',
      targetType: 'conversation',
      targetId: conversationId,
      confirmedByUser: true,
      detail: { summarizedMessages: result.summarizedMessages, factsExtracted: result.factsExtracted, degraded: result.degraded },
    });
    return ok(c, result);
  });

  app.post('/conversations/:id/messages', async (c) => {
    const conversationId = c.req.param('id');
    const body = await parseJson(c, S.isSendMessageRequest, 'message');
    const userMsg = await context.appendMessage({ conversationId, role: 'user', content: body.content });

    // 超阈值自动滚动摘要（不阻塞当前回答：摘要失败也不影响对话）
    let compacted = null;
    if (await context.shouldCompact(conversationId)) {
      compacted = await context.compact(conversationId, {
        workspaceId: c.req.header('x-workspace-id') ?? (await guessWorkspaceId(db, conversationId)),
      }).catch(() => null);
    }

    const { bundle, messages } = await context.buildPromptMessages(conversationId, body.content);
    const chat = await modelRouter.chat({ messages });
    const assistantMsg = await context.appendMessage({
      conversationId,
      role: 'assistant',
      content: chat.content,
      citations: bundle.citations,
    });
    await memory.extractFacts(conversationId, c.req.header('x-workspace-id') ?? 'unknown', body.content, userMsg.id);
    return ok(c, {
      userMessage: userMsg,
      assistantMessage: assistantMsg,
      citations: bundle.citations,
      degraded: chat.degraded,
      /** Phase 2：本次回答使用的上下文预算与路由 */
      context: {
        totalTokens: bundle.totalTokens,
        blocks: bundle.blocks.map((b) => ({ kind: b.kind, tokens: b.tokens, sourceIds: b.sourceIds })),
        budget: bundle.budget,
        model: bundle.model,
        routedByLength: bundle.routedByLength,
      },
      compacted,
    });
  });

  /* ----------------------------- Agent ----------------------------- */
  app.post('/agent/goal', async (c) => {
    const body = await parseJson(c, S.isCreateGoalRequest, 'goal');
    const result = await goalService.createGoal(body);
    return ok(c, result, 201);
  });

  app.get('/agent/goals', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const goals = await goalService.listGoals(workspaceId);
    return ok(c, { goals });
  });

  app.get('/agent/goals/:id', async (c) => {
    const id = c.req.param('id');
    const goal = await goalService.getGoal(id);
    return ok(c, { goal, tasks: await goalService.listTasks(id) });
  });

  /* ------------------ Phase 2：目标模式（GoalEngine） ------------------ */

  /** POST /goals —— 创建目标（Phase 2 主入口） */
  app.post('/goals', async (c) => {
    const body = await parseJson(c, S.isCreateGoalRequest, 'goal');
    const result = await goalEngine.createGoal({
      workspaceId: body.workspaceId,
      objective: body.objective,
      ...(body.acceptanceCriteria ? { acceptanceCriteria: body.acceptanceCriteria } : {}),
      ...(body.maxIterations !== undefined ? { maxIterations: body.maxIterations } : {}),
    });
    if (body.autoRun) {
      void goalEngine.run(result.goal.id).catch((e) => logger.error('autoRun failed', { goalId: result.goal.id, error: e instanceof Error ? e.message : String(e) }));
    }
    return ok(c, result, 201);
  });

  app.get('/goals', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { goals: await goalService.listGoals(workspaceId) });
  });

  app.get('/goals/:id', async (c) => {
    const id = c.req.param('id');
    return ok(c, { goal: await goalEngine.getGoal(id), tasks: await goalEngine.listTasks(id) });
  });

  /** POST /goals/:id/run —— 自主推进直到完成 / 达上限 / 停滞 */
  app.post('/goals/:id/run', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!S.isRunGoalRequest(body)) throw AppError.badRequest('maxIterations 必须是 1~200 的整数，mode 必须是 single|parallel|cluster');
    const id = c.req.param('id');
    const result = await goalEngine.run(id, {
      ...(body.maxIterations !== undefined ? { maxIterations: body.maxIterations as number } : {}),
      ...(body.mode ? { mode: body.mode as 'single' | 'parallel' | 'cluster' } : {}),
      userConfirmed: c.req.header('x-user-confirmed') === 'true',
    });
    return ok(c, result);
  });

  app.post('/goals/:id/cancel', async (c) => ok(c, { goal: await goalEngine.cancel(c.req.param('id')) }));

  app.get('/goals/:id/tasks', async (c) => ok(c, { tasks: await goalEngine.listTasks(c.req.param('id')) }));

  /** GET /goals/:id/progress —— 进度树 */
  app.get('/goals/:id/progress', async (c) => ok(c, await goalEngine.getProgressTree(c.req.param('id'))));

  /** GET /goals/:id/audit —— 完成审计报告 */
  app.get('/goals/:id/audit', async (c) => {
    const id = c.req.param('id');
    const audit = await goalEngine.getAudit(id);
    return ok(c, { audit, markdown: audit?.markdown ?? null });
  });

  /** GET /goals/:id/runs —— 每轮推进记录（可回放） */
  app.get('/goals/:id/runs', async (c) => ok(c, { runs: await goalEngine.listRuns(c.req.param('id')) }));

  /** GET /goals/:id/board —— 任务看板（Step 4） */
  app.get('/goals/:id/board', async (c) => ok(c, { board: await goalEngine.getTaskBoard(c.req.param('id')) }));

  /** GET /goals/:id/messages —— Agent 消息总线 */
  app.get('/goals/:id/messages', async (c) => ok(c, { messages: await goalEngine.listAgentMessages(c.req.param('id')) }));

  /** POST /agents/:id/message —— Agent → Agent / Agent → 任务板消息 */
  app.post('/agents/:id/message', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!S.isSendAgentMessageRequest(body)) throw AppError.badRequest('content 必填且不超过 8000 字');
    const goalId = String(body.goalId ?? '');
    if (!goalId) throw AppError.badRequest('缺少 goalId');
    const message = await goalEngine.sendAgentMessage({
      goalId,
      fromAgentId: c.req.param('id'),
      toAgentId: (body.toAgentId as string | null | undefined) ?? null,
      kind: typeof body.kind === 'string' ? body.kind : 'direct',
      content: body.content as string,
    });
    return ok(c, { message }, 201);
  });

  /** POST /tasks/:id/assign —— 指派/抢占 */
  app.post('/tasks/:id/assign', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!S.isAssignTaskRequest(body)) throw AppError.badRequest('agentId 必填');
    const task = await goalEngine.assignTask(c.req.param('id'), body.agentId as string, body.preempt === true);
    return ok(c, { task });
  });

  /* ------------------- Phase 2：Agent 集群配置 ------------------- */

  app.get('/cluster', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { config: await goalEngine.getClusterConfig(workspaceId) });
  });

  app.patch('/cluster', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const workspaceId = String(body.workspaceId ?? '');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    if (!S.isClusterConfigRequest(body)) throw AppError.badRequest('mode/maxParallel/experimental 取值非法');
    const config = await goalEngine.setClusterConfig(workspaceId, {
      ...(body.mode ? { mode: body.mode as 'single' | 'parallel' | 'cluster' } : {}),
      ...(body.maxParallel !== undefined ? { maxParallel: body.maxParallel as number } : {}),
      ...(body.experimental !== undefined ? { experimental: body.experimental as boolean } : {}),
    });
    return ok(c, { config });
  });

  /* ------------------- Phase 2：Agent 运行追踪 ------------------- */

  app.get('/agents', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { agents: await workspaceService.listAgents(workspaceId) });
  });

  app.get('/agents/:id/runs', async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 50), 500);
    const runs = await db.query.agentRuns.findMany({
      where: (r, { eq }) => eq(r.agentId, c.req.param('id')),
      limit,
    });
    return ok(c, { runs });
  });

  app.post('/agent/goals/:id/advance', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    if (!S.isAdvanceRequest(body)) throw AppError.badRequest('note 必须是字符串');
    return ok(c, await goalService.advance(c.req.param('id'), body.note));
  });

  app.post('/agent/goals/:id/run', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    return ok(c, await goalService.advanceUntilFinished(c.req.param('id'), body.note));
  });

  app.get('/agent/goals/:id/messages', async (c) => {
    return ok(c, { messages: await goalService.listMessages(c.req.param('id')) });
  });

  app.post('/agent/tasks/:id/cancel', async (c) => {
    return ok(c, { task: await goalService.cancelTask(c.req.param('id')) });
  });

  app.get('/agent/runs', async (c) => {
    const goalId = c.req.query('goalId');
    const rows = goalId ? await goalService.listTasks(goalId) : [];
    // runs 从 DB 直接查，避免 N+1
    const runs = rows.length
      ? await db.query.agentRuns.findMany({ where: (r, { inArray }) => inArray(r.taskId, rows.map((t) => t.id)), limit: 200 })
      : await db.query.agentRuns.findMany({ limit: 100 });
    return ok(c, { runs });
  });

  /* ------------------------------ 文件 ------------------------------ */
  app.post('/files/upload', async (c) => {
    const body = await parseJson(c, S.isUploadFileRequest, 'file');
    const { file } = await files.upload(body);
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'file.upload', targetType: 'file', targetId: file.id, confirmedByUser: true, detail: { path: file.path, size: file.size } });
    eventBus.publishBuffered(EventType.FILE_CREATED, { fileId: file.id, path: file.path, version: file.version }, { workspaceId: body.workspaceId, goalId: null, taskId: null });
    return ok(c, { fileId: file.id, path: file.path, version: file.version }, 201);
  });

  app.get('/files', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { files: await files.list(workspaceId) });
  });

  app.get('/files/:id/versions', async (c) => ok(c, { versions: await files.listVersions(c.req.param('id')) }));

  /* ----------------------------- Office ---------------------------- */
  app.post('/office/generate', async (c) => {
    const body = await parseJson(c, S.isGenerateOfficeRequest, 'office');
    const ws = await workspaceService.getById(body.workspaceId);
    if (!ws.rootPath) throw AppError.badRequest('工作区未设置 rootPath，请先在设置中指定工作目录');

    const result = await officeGenerateTool.run(
      {
        format: body.format,
        title: body.title,
        content: body.content,
        ...(body.sheets ? { sheets: body.sheets.map((s) => ({ name: s.name, rows: s.rows as (string | number | boolean | null)[][] })) } : {}),
      },
      {
        workspaceId: ws.id,
        goalId: body.goalId ?? null,
        taskId: null,
        agentId: 'user',
        runId: newId('run'),
        userConfirmed: true,
        workspaceRoot: ws.rootPath,
      },
    );
    if (!result.ok) throw AppError.tool(result.error ?? '生成失败');

    const data = result.data as { path: string; bytes: number };
    const artifact: Artifact = {
      id: newId('art'),
      workspaceId: ws.id,
      goalId: body.goalId ?? null,
      taskId: null,
      fileId: null,
      kind: body.format,
      title: body.title,
      url: null,
      meta: { path: data.path, bytes: data.bytes },
      createdAt: new Date().toISOString(),
    };
    await audit.record({ workspaceId: ws.id, actor: 'user', action: 'office.generate', targetType: 'artifact', targetId: artifact.id, confirmedByUser: true, detail: { format: body.format, path: data.path } });
    eventBus.publishBuffered(EventType.ARTIFACT_CREATED, artifact, { workspaceId: ws.id, goalId: body.goalId ?? null, taskId: null });
    return ok(c, { artifact, path: data.path }, 201);
  });

  /* ------------------- Phase 2：Office 文件处理 ------------------- */

  /** 统一解析 office 上下文（工作区 + 根目录，安全默认：未配置 rootPath 直接拒绝） */
  async function officeCtx(workspaceId: string) {
    const ws = await workspaceService.getById(workspaceId);
    return { workspaceId: ws.id, workspaceRoot: ws.rootPath ?? null };
  }

  app.get('/office/status', async (c) => ok(c, await office.converterStatus()));

  /** POST /files/:id/read —— 按文件记录读取（含 docx/xlsx/pptx/pdf 解析） */
  app.get('/files/:id/content', async (c) => {
    const fileId = c.req.param('id');
    const rows = await db.query.files.findMany({ where: (t, { eq }) => eq(t.id, fileId), limit: 1 });
    const file = rows[0];
    if (!file) throw AppError.notFound(`文件不存在: ${fileId}`);
    const ctx = await officeCtx(file.workspaceId);
    return ok(c, await office.read(ctx, file.path));
  });

  app.get('/files/:id/versions', async (c) => {
    const fileId = c.req.param('id');
    const rows = await db.query.files.findMany({ where: (t, { eq }) => eq(t.id, fileId), limit: 1 });
    const file = rows[0];
    if (!file) throw AppError.notFound(`文件不存在: ${fileId}`);
    return ok(c, await office.listVersions(await officeCtx(file.workspaceId), fileId));
  });

  app.post('/files/:id/restore', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { version?: number };
    if (typeof body.version !== 'number' || body.version < 1) throw AppError.badRequest('version 必须是 ≥1 的整数');
    const fileId = c.req.param('id');
    const rows = await db.query.files.findMany({ where: (t, { eq }) => eq(t.id, fileId), limit: 1 });
    const file = rows[0];
    if (!file) throw AppError.notFound(`文件不存在: ${fileId}`);
    const result = await office.restore(await officeCtx(file.workspaceId), fileId, body.version);
    await audit.record({
      workspaceId: file.workspaceId,
      actor: 'user',
      action: 'file.restore',
      targetType: 'file',
      targetId: fileId,
      confirmedByUser: true,
      detail: { restoredFrom: body.version, version: result.version },
    });
    eventBus.publishBuffered(EventType.FILE_VERSION, result, { workspaceId: file.workspaceId, goalId: null, taskId: null });
    return ok(c, result);
  });

  app.get('/files/exports/:exportId', async (c) => {
    const { row, expired } = await office.resolveExport(c.req.param('exportId'));
    if (expired) throw AppError.notFound('导出链接已过期，请重新导出');
    const { readFile } = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const abs = pathMod.join(config.storageDir, row.storagePath);
    const buf = await readFile(abs).catch(() => null);
    if (!buf) throw AppError.notFound('导出内容缺失');
    return new Response(new Uint8Array(buf), {
      headers: {
        'content-type': row.mime,
        'content-disposition': `attachment; filename="${encodeURIComponent(pathMod.basename(row.storagePath))}"`,
        'content-length': String(buf.length),
      },
    });
  });

  /** POST /office/read —— 读取并解析工作区文件 */
  app.post('/office/read', async (c) => {
    const body = await parseJson(c, S.isOfficeReadRequest, 'office.read');
    return ok(c, await office.read(await officeCtx(body.workspaceId), body.path));
  });

  /** POST /office/preview —— 结构化预览（供 UI 渲染） */
  app.post('/office/preview', async (c) => {
    const body = await parseJson(c, S.isOfficeReadRequest, 'office.preview');
    return ok(c, await office.preview(await officeCtx(body.workspaceId), body.path));
  });

  /** POST /office/edit —— 原地编辑（不破坏格式，编辑前自动备份版本） */
  app.post('/office/edit', async (c) => {
    const body = await parseJson(c, S.isOfficeEditRequest, 'office.edit');
    const ctx = await officeCtx(body.workspaceId);
    const result = await office.edit(ctx, body.path, body.operations, { backup: body.backup !== false });
    await audit.record({
      workspaceId: body.workspaceId,
      actor: 'user',
      action: 'office.edit',
      targetType: 'file',
      targetId: body.path,
      confirmedByUser: true,
      detail: { operations: body.operations.length, applied: result.applied, version: result.version },
    });
    eventBus.publishBuffered(EventType.OFFICE_FILE_CHANGED, result, { workspaceId: body.workspaceId, goalId: null, taskId: null });
    return ok(c, result);
  });

  /** POST /office/convert —— LibreOffice headless 转换（未配置时显式降级） */
  app.post('/office/convert', async (c) => {
    const body = await parseJson(c, S.isOfficeConvertRequest, 'office.convert');
    const result = await office.convert(await officeCtx(body.workspaceId), body.path, body.target, body.outputPath);
    await audit.record({
      workspaceId: body.workspaceId,
      actor: 'user',
      action: 'office.convert',
      targetType: 'file',
      targetId: body.path,
      confirmedByUser: true,
      detail: { target: body.target, degraded: result.degraded, path: result.path },
    });
    return ok(c, result);
  });

  /** POST /office/export —— 生成可下载 / 可发布 URL */
  app.post('/office/export', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: string; path?: string; ttlHours?: number };
    if (!body.workspaceId || !body.path) throw AppError.badRequest('workspaceId 与 path 必填');
    const result = await office.export(await officeCtx(body.workspaceId), body.path, body.ttlHours === undefined ? {} : { ttlHours: body.ttlHours });
    return ok(c, result, 201);
  });

  /* ------------------- Phase 2：深度研究（ResearchEngine） -------------- */

  /** GET /research/capability —— 告知 UI 当前可用能力（未配置检索端点则不联网） */
  app.get('/research/capability', (c) => ok(c, research.capability()));

  app.get('/research', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { jobs: await research.list(workspaceId) });
  });

  /** POST /research —— 创建并异步执行深度研究 */
  app.post('/research', async (c) => {
    const body = await parseJson(c, S.isCreateResearchRequestV2, 'research');
    if (!config.features.phase2Research) {
      throw AppError.badRequest('深度研究当前未启用（通过 PHASE2_RESEARCH=1 开启）');
    }
    // 联网必须用户显式允许；未允许时不发起任何外部请求
    const job = await research.create({
      workspaceId: body.workspaceId,
      topic: body.topic,
      ...(body.depth ? { depth: body.depth } : {}),
      ...(body.outputFormats ? { outputFormats: body.outputFormats } : {}),
      allowNetwork: body.allowNetwork === true,
      ...(body.maxSources !== undefined ? { maxSources: body.maxSources } : {}),
    });
    return ok(c, { job }, 201);
  });

  app.get('/research/:id', async (c) => {
    const id = c.req.param('id');
    const [job, sources, claims, report] = await Promise.all([
      research.get(id),
      research.listSources(id),
      research.listClaims(id),
      research.getReport(id),
    ]);
    return ok(c, { job, sources, claims, report });
  });

  app.get('/research/:id/report', async (c) => {
    const id = c.req.param('id');
    const report = await research.getReport(id);
    if (!report) throw AppError.notFound('报告尚未生成（研究可能仍在进行或已失败）');
    return ok(c, { job: await research.get(id), report });
  });

  /** GET /research/:id/export?format=markdown —— 直接下载报告 */
  app.get('/research/:id/export', async (c) => {
    const id = c.req.param('id');
    const report = await research.getReport(id);
    if (!report) throw AppError.notFound('报告尚未生成');
    const job = await research.get(id);
    const name = `research-${job.topic.replace(/[^\w\u4e00-\u9fff-]/g, '_').slice(0, 40)}.md`;
    return new Response(new TextEncoder().encode(report.markdown), {
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="${encodeURIComponent(name)}"`,
      },
    });
  });

  /** POST /research/:id/publish —— 发布为自包含网页 */
  app.post('/research/:id/publish', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!S.isPublishResearchRequest({ ...body, workspaceId: body.workspaceId ?? 'x' })) {
      // workspaceId 从 job 推导，这里只校验 public 字段
      if (body.public !== undefined && typeof body.public !== 'boolean') {
        throw AppError.badRequest('public 必须是布尔值');
      }
    }
    const result = await research.publish(c.req.param('id'), { public: body.public === true });
    return ok(c, result);
  });

  app.post('/research/:id/cancel', async (c) => ok(c, { job: await research.cancel(c.req.param('id')) }));

  /* ----------------------------- 网站部署 -------------------------- */
  /*
   * Phase 1 的 /website/deploy 占位接口已彻底移除。
   *
   * 原因（真实缺陷）：它返回 202 + accepted:true，但什么都没做 ——
   * 前端会显示「已进入队列」，用户以为部署成功了。Phase 3 的真实入口是：
   *   POST /websites           创建项目
   *   POST /websites/:id/generate
   *   POST /websites/:id/deploy   ← 真实部署
   * 这里返回 410 明确告知迁移路径，避免调用方静默拿到假成功。
   */
  app.post('/website/deploy', (c) => {
    throw AppError.badRequest(
      '接口已迁移：请改用 POST /websites 创建项目 → POST /websites/:id/generate 生成 → POST /websites/:id/deploy 部署',
      { deprecated: '/website/deploy', replacements: ['POST /websites', 'POST /websites/:id/generate', 'POST /websites/:id/deploy'] },
    );
  });

  /* ----------------------------- 定时任务 -------------------------- */
  app.post('/schedule', async (c) => {
    const body = await parseJson(c, S.isCreateScheduleRequest, 'schedule');
    const schedule = await schedules.create(body);
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'schedule.create', targetType: 'schedule', targetId: schedule.id, confirmedByUser: true, detail: { trigger: schedule.trigger, expression: schedule.expression } });
    return ok(c, { schedule }, 201);
  });

  app.get('/schedule', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { schedules: await schedules.list(workspaceId) });
  });

  app.get('/schedule/:id/runs', async (c) => ok(c, { runs: await schedules.listRuns(c.req.param('id')) }));

  app.patch('/schedule/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') throw AppError.badRequest('enabled 必须是布尔值');
    return ok(c, { schedule: await schedules.setEnabled(c.req.param('id'), body.enabled) });
  });

  /* ------------------------------ 插件 ----------------------------- */
  app.get('/plugins', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { installed: await pluginService.list(workspaceId), catalog: pluginService.listCatalog() });
  });

  app.post('/plugins/:name/install', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: string };
    if (!body.workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const plugin = await pluginService.install(body.workspaceId, c.req.param('name'));
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'plugin.install', targetType: 'plugin', targetId: plugin.id, confirmedByUser: true, detail: { name: plugin.name, permissions: plugin.permissions } });
    return ok(c, { plugin }, 201);
  });

  app.delete('/plugins/:id', async (c) => {
    const id = c.req.param('id');
    await pluginService.uninstall(id);
    return ok(c, { removed: id });
  });

  /* ---------------------------- 提示词 ----------------------------- */
  app.post('/prompt/optimize', async (c) => {
    const body = await parseJson(c, S.isOptimizePromptRequest, 'prompt');
    return ok(c, await prompts.optimize(body));
  });

  app.get('/prompt/templates', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { templates: await prompts.list(workspaceId) });
  });

  /* ------------------------------ 看板 ----------------------------- */
  /*
   * 说明：Phase 1 的 /widgets 简版路由已被 Phase 3（/dashboards/:id/widgets +
   * /widgets/:id）完整取代。这里保留一段兼容层：老前端（Phase 1 UI）调用的
   * POST /widgets 仍然可用，由 DashboardsService 处理；其余同名路由已删除，
   * 避免「先声明的路由遮蔽后声明的路由」造成 404/行为不一致（真实踩坑）。
   */
  app.post('/widgets', async (c) => {
    const body = await parseJson(c, S.isCreateWidgetRequest, 'widget');
    const result = await dashboards.createFromNaturalLanguage({
      workspaceId: body.workspaceId,
      naturalLanguage: body.naturalLanguage,
      dashboardId: body.dashboardId,
    });
    return ok(c, { widget: (result as unknown as { widget: unknown }).widget }, 201);
  });

  /* ------------------------------ 审计 ----------------------------- */
  app.get('/audit', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { logs: await audit.list(workspaceId, Number(c.req.query('limit') ?? 100)) });
  });

  app.get('/events/recent', (c) => ok(c, { events: eventBus.recent(Number(c.req.query('limit') ?? 100)) }));


  /* ================================================================== */
  /* Phase 3：网站生成 / 部署 / 数据库 / 看板 / 定时任务 / 通知          */
  /* ================================================================== */

  /* --------------------------- 部署中心 --------------------------- */
  /**
   * Phase 3 功能开关中间件式校验：
   * 关闭后接口返回「未启用」，但数据保留（无需回滚数据库）。
   * 注意：只对「会产生外部影响」的入口做开关，查询类接口保持可用，
   * 便于用户查看历史数据。
   */
  const requireFeature = (key: keyof typeof config.features, label: string) => {
    if (!config.features[key]) {
      throw AppError.badRequest(`${label} 已被功能开关关闭（config.features.${String(key)} = false）；历史数据仍保留，重新打开即可恢复`);
    }
  };

  app.get('/deploy/capabilities', async (c) => ok(c, { providers: deploy.capabilities(), danger: dangerCatalog() }));

  app.get('/deploy/providers/test', async (c) => ok(c, { results: await deploy.testProviders() }));

  app.post('/websites', async (c) => {
    requireFeature('phase3Deploy', '网站部署');
    const body = await parseJson(c, S.isCreateWebsiteProjectRequest, 'website');
    const project = await deploy.createProject(body);
    return ok(c, { project }, 201);
  });

  app.get('/websites', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { projects: await deploy.listProjects(workspaceId) });
  });

  app.get('/websites/:id', async (c) => {
    const project = await deploy.getProject(c.req.param('id'));
    const [deployments, access, envVars, files] = await Promise.all([
      deploy.listDeployments(project.id),
      deploy.getAccess(project.id),
      deploy.envVars(project.id),
      projects.listGenerated(project),
    ]);
    return ok(c, {
      project,
      deployments,
      access,
      envVars,
      files,
      previewCommand: project.type === 'static' ? 'npm run dev' : 'npm run dev',
    });
  });

  app.patch('/websites/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; description?: string };
    if (body.name === undefined && body.description === undefined) throw AppError.badRequest('没有需要更新的字段');
    const project = await projects.update(id, body);
    return ok(c, { project });
  });

  app.post('/websites/:id/generate', async (c) => {
    requireFeature('phase3Deploy', '网站部署');
    const body = await parseJson(c, S.isGenerateWebsiteRequest, 'generate');
    const result = await deploy.generate({ websiteProjectId: c.req.param('id'), requirement: body.requirement });
    return ok(c, result);
  });

  app.post('/websites/:id/build', async (c) => {
    requireFeature('phase3Deploy', '网站部署');
    const project = await deploy.getProject(c.req.param('id'));
    const result = await projects.build(project);
    return ok(c, result);
  });

  app.post('/websites/:id/deploy', async (c) => {
    requireFeature('phase3Deploy', '网站部署');
    const body = await parseJson(c, S.isDeployRequest, 'deploy');
    gate('website.deploy', body.confirm, { websiteProjectId: c.req.param('id'), provider: body.provider });
    const result = await deploy.deploy({
      websiteProjectId: c.req.param('id'),
      provider: body.provider as 'vercel',
      confirm: body.confirm,
    });
    return ok(c, result, 202);
  });

  app.get('/websites/:id/deployments', async (c) => ok(c, { deployments: await deploy.listDeployments(c.req.param('id')) }));

  app.get('/deployments/:id/logs', async (c) => ok(c, deploy.logs(c.req.param('id'))));

  app.post('/websites/:id/rollback', async (c) => {
    const body = await parseJson(c, S.isRollbackRequest, 'rollback');
    gate('website.rollback', body.confirm, { deploymentId: body.deploymentId });
    const deployment = await deploy.rollback({
      websiteProjectId: c.req.param('id'),
      deploymentId: body.deploymentId,
      confirm: body.confirm,
    });
    return ok(c, { deployment });
  });

  app.delete('/websites/:id/deployments/:deploymentId', async (c) => {
    const confirm = c.req.query('confirm') === 'true';
    gate('deployment.delete', confirm, { deploymentId: c.req.param('deploymentId') });
    const result = await deploy.deleteDeployment({
      websiteProjectId: c.req.param('id'),
      deploymentId: c.req.param('deploymentId'),
      confirm,
    });
    return ok(c, result);
  });

  app.delete('/websites/:id', async (c) => {
    const confirm = c.req.query('confirm') === 'true';
    gate('website.delete', confirm, { websiteProjectId: c.req.param('id') });
    const result = await deploy.deleteProject({ websiteProjectId: c.req.param('id'), confirm });
    return ok(c, result);
  });

  app.post('/websites/:id/domain', async (c) => {
    const body = await parseJson(c, S.isDomainRequest, 'domain');
    gate('domain.bind', body.confirm, { domain: body.domain });
    const binding = await deploy.bindDomain({
      websiteProjectId: c.req.param('id'),
      domain: body.domain,
      provider: body.provider as 'vercel' | undefined,
      confirm: body.confirm,
    });
    return ok(c, { binding });
  });

  app.post('/websites/:id/access', async (c) => {
    const body = await parseJson(c, S.isAccessRequest, 'access');
    gate('access.update', body.confirm, { websiteProjectId: c.req.param('id') });
    const result = await deploy.setAccess({
      websiteProjectId: c.req.param('id'),
      rules: body.rules as { type: 'password'; value: string }[],
      confirm: body.confirm,
    });
    return ok(c, result);
  });

  app.get('/websites/:id/access', async (c) => ok(c, { rules: await deploy.getAccess(c.req.param('id')) }));

  app.get('/websites/:id/env', async (c) => ok(c, { vars: await deploy.envVars(c.req.param('id')) }));

  app.post('/websites/:id/env', async (c) => {
    const body = await parseJson(c, S.isEnvVarRequest, 'env');
    const result = await deploy.setEnvVars({ websiteProjectId: c.req.param('id'), vars: body.vars, confirm: body.confirm });
    return ok(c, result);
  });

  app.delete('/websites/:id/env/:key', async (c) => {
    const confirm = c.req.query('confirm') === 'true';
    if (!confirm) throw AppError.confirmRequired('删除环境变量需要二次确认');
    return ok(c, await deploy.removeEnvVar({ websiteProjectId: c.req.param('id'), key: c.req.param('key'), confirm }));
  });

  app.get('/websites/:id/deploy-audits', async (c) => {
    const project = await deploy.getProject(c.req.param('id'));
    return ok(c, { audits: await auditorDeploy.list(project.workspaceId, Number(c.req.query('limit') ?? 100)) });
  });

  /* --------------------------- 数据库面板 ------------------------- */
  app.get('/databases/providers', (c) => ok(c, { providers: database.providers() }));

  app.post('/databases', async (c) => {
    requireFeature('phase3Database', '数据库接入');
    const body = await parseJson(c, S.isCreateDatabaseRequest, 'database');
    const connection = await database.createConnection({ ...body, provider: body.provider as 'neon' });
    return ok(c, { connection }, 201);
  });

  app.get('/databases', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { connections: await database.listConnections(workspaceId) });
  });

  app.get('/databases/:id', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const connection = await database.getConnection(workspaceId, c.req.param('id'));
    const [migrations, backups] = await Promise.all([
      database.listMigrations(workspaceId, connection.id),
      database.listBackups(workspaceId, connection.id),
    ]);
    return ok(c, { connection, migrations, backups });
  });

  app.delete('/databases/:id', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const confirm = c.req.query('confirm') === 'true';
    gate('db.delete', confirm, { connectionId: c.req.param('id') });
    return ok(c, await database.removeConnection({ workspaceId, id: c.req.param('id'), confirm }));
  });

  app.post('/databases/:id/test', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: string };
    const workspaceId = body.workspaceId ?? c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, await database.testConnection({ workspaceId, id: c.req.param('id') }));
  });

  app.get('/databases/:id/schema', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const connection = await database.getConnection(workspaceId, c.req.param('id'));
    if (c.req.query('introspect') === 'true') {
      return ok(c, { schema: await database.introspect({ workspaceId, id: connection.id }) });
    }
    return ok(c, { schema: connection, migrations: await database.listMigrations(workspaceId, connection.id) });
  });

  app.post('/databases/:id/schema', async (c) => {
    const body = await parseJson(c, S.isCreateSchemaRequest, 'schema');
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const projectId = c.req.query('websiteProjectId');
    let plan: WebsitePlan | undefined;
    if (projectId) {
      const project = await deploy.getProject(projectId);
      plan = project.plan as unknown as WebsitePlan;
    }
    if (!plan && !body.sql) throw AppError.badRequest('需要提供 websiteProjectId（从网站需求生成）或直接的 sql/downSql');
    if (plan) {
      const result = await database.generateSchema({ workspaceId, id: c.req.param('id'), plan, withRls: body.withRls });
      return ok(c, result);
    }
    const migration = await database.createMigration({ workspaceId, id: c.req.param('id'), name: body.name, sql: body.sql, downSql: body.downSql });
    return ok(c, { migration }, 201);
  });

  app.post('/databases/:id/migrate', async (c) => {
    const body = await parseJson(c, S.isMigrationRequest, 'migrate');
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    gate('db.migrate', body.confirm, { connectionId: c.req.param('id'), migrationId: body.migrationId });
    return ok(c, await database.applyMigration({ workspaceId, id: c.req.param('id'), migrationId: body.migrationId, confirm: body.confirm }));
  });

  app.post('/databases/:id/migrate/rollback', async (c) => {
    const body = await parseJson(c, S.isMigrationRequest, 'rollback');
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    gate('db.rollback', body.confirm, { connectionId: c.req.param('id'), migrationId: body.migrationId });
    return ok(c, await database.rollbackMigration({ workspaceId, id: c.req.param('id'), migrationId: body.migrationId, confirm: body.confirm }));
  });

  app.post('/databases/:id/query', async (c) => {
    requireFeature('phase3Database', '数据库接入');
    const body = await parseJson(c, S.isQueryRequest, 'query');
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    if (body.confirm !== true) {
      const adapter = await database.adapterFor(workspaceId, c.req.param('id'));
      const preflight = new QueryRunner(adapter).preflight(body.sql, { readOnly: body.readOnly ?? true });
      return ok(c, { preflight });
    }
    const result = await database.runQuery({
      workspaceId,
      id: c.req.param('id'),
      sql: body.sql,
      params: body.params,
      readOnly: body.readOnly ?? true,
      limit: body.limit,
      confirm: body.confirm,
    });
    return ok(c, result);
  });

  app.post('/databases/:id/backup', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: string; compress?: boolean; confirm?: boolean };
    const workspaceId = body.workspaceId ?? c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    if (body.confirm !== true) throw AppError.confirmRequired('备份会读取数据库全部表结构，需要二次确认');
    return ok(c, await database.backup({ workspaceId, id: c.req.param('id'), compress: body.compress, confirm: true }));
  });

  app.get('/databases/:id/backups', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { backups: await database.listBackups(workspaceId, c.req.param('id')) });
  });

  app.post('/backups/:id/restore-plan', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    const connectionId = c.req.query('connectionId');
    if (!workspaceId || !connectionId) throw AppError.badRequest('缺少 workspaceId / connectionId');
    return ok(c, await database.planRestore({ workspaceId, id: connectionId, backupId: c.req.param('id') }));
  });

  app.get('/databases/:id/audits', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { audits: await auditorDb.list(workspaceId, Number(c.req.query('limit') ?? 100)) });
  });

  /* --------------------------- 看板编辑器 -------------------------- */
  app.get('/dashboard/registry', (c) => ok(c, { widgets: DashboardService.registry() }));

  app.post('/dashboards', async (c) => {
    requireFeature('phase3Dashboard', '定制看板');
    const body = await parseJson(c, S.isCreateDashboardRequest, 'dashboard');
    return ok(c, { dashboard: await dashboards.create(body) }, 201);
  });

  app.get('/dashboards', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { dashboards: await dashboards.listDashboards(workspaceId) });
  });

  app.get('/dashboards/:id', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const board = await dashboards.getDashboard(workspaceId, c.req.param('id'));
    const cache = await dashboards.cachedWidgetData(workspaceId, c.req.param('id'));
    return ok(c, { ...board, data: cache });
  });

  app.patch('/dashboards/:id', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    if (!body.name) throw AppError.badRequest('缺少 name');
    return ok(c, { dashboard: await dashboards.renameDashboard(workspaceId, c.req.param('id'), body.name) });
  });

  app.delete('/dashboards/:id', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const confirm = c.req.query('confirm') === 'true';
    gate('dashboard.delete', confirm, { dashboardId: c.req.param('id') });
    return ok(c, await dashboards.deleteDashboard(workspaceId, c.req.param('id')));
  });

  app.post('/dashboards/:id/layout', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const body = await parseJson(c, S.isSaveLayoutRequest, 'layout');
    const result = await dashboards.saveLayout({ workspaceId, dashboardId: c.req.param('id'), items: body.items, compact: body.compact });
    return ok(c, { dashboard: result.dashboard, widgets: result.widgets });
  });

  app.post('/dashboards/:id/layout/rollback', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const body = (await c.req.json().catch(() => ({}))) as { index?: number };
    return ok(c, await dashboards.rollbackLayout(workspaceId, c.req.param('id'), body.index));
  });

  app.post('/dashboards/:id/refresh', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, await dashboards.refreshDashboard({ workspaceId, dashboardId: c.req.param('id') }));
  });

  app.post('/dashboards/:id/widgets', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!S.isCreateWidgetRequestV3({ ...body, workspaceId, dashboardId: c.req.param('id') })) {
      throw AppError.badRequest('请求体字段缺失或类型错误（widget）');
    }
    const input = { ...body, workspaceId, dashboardId: c.req.param('id') } as Parameters<typeof dashboards.createWidget>[0];
    if (typeof body.naturalLanguage === 'string' && !body.type) {
      const nl = await dashboards.createFromNaturalLanguage({ workspaceId, naturalLanguage: body.naturalLanguage, dashboardId: c.req.param('id') });
      return ok(c, nl, 201);
    }
    return ok(c, { widget: await dashboards.createWidget(input) }, 201);
  });

  app.get('/widgets', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    if (c.req.query('pinned') === 'true') return ok(c, { widgets: await dashboards.listPinned(workspaceId) });
    const dashboardId = c.req.query('dashboardId');
    if (!dashboardId) throw AppError.badRequest('缺少 dashboardId');
    return ok(c, await dashboards.getDashboard(workspaceId, dashboardId));
  });

  app.patch('/widgets/:id', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const body = await parseJson(c, S.isUpdateWidgetRequest, 'widget');
    return ok(c, { widget: await dashboards.updateWidget({ workspaceId, widgetId: c.req.param('id'), ...body }) });
  });

  app.delete('/widgets/:id', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    await dashboards.removeWidget(workspaceId, c.req.param('id'));
    return ok(c, { removed: true });
  });

  app.post('/widgets/:id/refresh', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, await dashboards.refreshWidget({ workspaceId, widgetId: c.req.param('id') }));
  });

  app.post('/widgets/:id/pin', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const body = (await c.req.json().catch(() => ({}))) as { pinned?: boolean };
    if (typeof body.pinned !== 'boolean') throw AppError.badRequest('缺少 pinned（布尔值）');
    return ok(c, { widget: await dashboards.setPinned(workspaceId, c.req.param('id'), body.pinned) });
  });

  /* --------------------------- 定时任务 --------------------------- */
  app.get('/schedule/templates', (c) => ok(c, { templates: scheduleManagerV3.templates(), presets: scheduleManagerV3.cronPresets() }));

  app.post('/schedule/preview', async (c) => {
    const body = await parseJson(c, S.isCronPreviewRequest, 'cron');
    return ok(c, scheduleManagerV3.previewCron(body.expression, body.timezone ?? 'Asia/Shanghai'));
  });

  app.post('/schedules', async (c) => {
    requireFeature('phase3Schedule', '定时任务');
    const body = await parseJson(c, S.isCreateScheduleRequestV3, 'schedule');
    const task = await scheduleManagerV3.create(body as Parameters<typeof schedules.create>[0]);
    return ok(c, { schedule: task }, 201);
  });

  app.get('/schedules', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { schedules: await scheduleManagerV3.list(workspaceId) });
  });

  app.get('/schedules/:id', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const task = await scheduleManagerV3.get(workspaceId, c.req.param('id'));
    const runs = await scheduleManagerV3.listRuns(workspaceId, c.req.param('id'));
    return ok(c, { schedule: task, runs, stats: computeStats(runs), timeline: buildTimeline(runs) });
  });

  app.patch('/schedules/:id', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const body = await parseJson(c, S.isUpdateScheduleRequest, 'schedule');
    return ok(c, { schedule: await scheduleManagerV3.update({ workspaceId, id: c.req.param('id'), ...body }) });
  });

  app.delete('/schedules/:id', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const confirm = c.req.query('confirm') === 'true';
    gate('schedule.delete', confirm, { scheduleId: c.req.param('id') });
    return ok(c, await scheduleManagerV3.remove({ workspaceId, id: c.req.param('id'), confirm }));
  });

  app.post('/schedules/:id/run', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const body = (await c.req.json().catch(() => ({}))) as { confirm?: boolean };
    if (body.confirm !== true) throw AppError.confirmRequired('手动触发定时任务会立即执行真实动作，需要二次确认');
    return ok(c, { run: await scheduleManagerV3.runNow({ workspaceId, id: c.req.param('id'), confirm: true }) }, 202);
  });

  app.get('/schedules/:id/runs', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const runs = await scheduleManagerV3.listRuns(workspaceId, c.req.param('id'), Number(c.req.query('limit') ?? 50));
    return ok(c, { runs, stats: computeStats(runs), timeline: buildTimeline(runs) });
  });

  app.get('/schedule-audits', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { audits: await auditorSchedule.list(workspaceId, Number(c.req.query('limit') ?? 100)) });
  });

  /* --------------------------- 通知设置 --------------------------- */
  app.get('/notify/catalog', (c) => ok(c, { channels: notify.catalog() }));

  app.post('/notify/channels', async (c) => {
    requireFeature('phase3Notify', '推送通知');
    const body = await parseJson(c, S.isCreateNotifyChannelRequest, 'channel');
    const channel = await notify.createChannel(body as Parameters<typeof notify.createChannel>[0]);
    return ok(c, { channel }, 201);
  });

  app.get('/notify/channels', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { channels: await notify.listChannels(workspaceId) });
  });

  app.patch('/notify/channels/:id', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const body = await parseJson(c, S.isUpdateNotifyChannelRequest, 'channel');
    return ok(c, { channel: await notify.updateChannel({ workspaceId, channelId: c.req.param('id'), ...body }) });
  });

  app.delete('/notify/channels/:id', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const confirm = c.req.query('confirm') === 'true';
    gate('notify.delete', confirm, { channelId: c.req.param('id') });
    await notify.removeChannel(workspaceId, c.req.param('id'));
    return ok(c, { removed: true });
  });

  app.post('/notify/test', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const body = await parseJson(c, S.isTestNotifyRequest, 'test');
    return ok(c, await notify.testChannel({ workspaceId, channelId: body.channelId }));
  });

  app.post('/notify/send', async (c) => {
    const body = await parseJson(c, S.isSendNotifyRequest, 'send');
    return ok(c, await notify.dispatch({ workspaceId: body.workspaceId, channelIds: body.channelIds, message: body.message as never }));
  });

  app.get('/notify/logs', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { logs: await notify.listLogs(workspaceId, Number(c.req.query('limit') ?? 100), c.req.query('channelId') || undefined) });
  });

/* ================================================================== */
  /* Phase 4：生态、集群与提示词工程                                     */
  /* ================================================================== */

  const requirePhase4 = (key: keyof typeof config.features, label: string) => {
    if (!config.features[key]) {
      throw AppError.badRequest(`${label} 已被功能开关关闭（config.features.${String(key)} = false）；历史数据仍保留，重新打开即可恢复`);
    }
  };

  /* ------------------- Step 1：插件系统与 MCP ------------------- */

  app.get('/plugins/market', (c) =>
    ok(c, {
      catalog: pluginInstaller.browse({
        ...(c.req.query('q') ? { q: c.req.query('q') as string } : {}),
        ...(c.req.query('kind') ? { kind: c.req.query('kind') as string } : {}),
        ...(c.req.query('requiresAuth') === undefined ? {} : { requiresAuth: c.req.query('requiresAuth') === 'true' }),
      }),
      kinds: ['mcp', 'http', 'websocket', 'local'],
    }),
  );

  app.get('/plugins/market/:name', (c) => ok(c, pluginInstaller.detail(c.req.param('name'))));

  /** Phase 4 插件视图：安装态 + 授权态 + 可更新 */
  app.get('/plugins/installed', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { plugins: await pluginInstaller.listInstalled(workspaceId) });
  });

  app.post('/plugins/install', async (c) => {
    requirePhase4('phase4PaidPlugins', '插件系统');
    const body = await parseJson(c, S.isInstallPluginRequest, 'plugin');
    const name = String(c.req.query('name') ?? '');
    if (!name) throw AppError.badRequest('缺少 name 查询参数（要安装的插件名）');
    gate('plugin.install', c.req.query('confirm') === 'true', { name });
    const result = await pluginInstaller.install(body.workspaceId, name);
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'plugin.install', targetType: 'plugin', targetId: result.pluginId, confirmedByUser: true, detail: { name: result.name, version: result.version, signed: result.signed, permissions: result.permissions.map((p) => p.scope) } });
    eventBus.publishBuffered(EventType.PLUGIN_INSTALLED, { name: result.name, version: result.version }, { workspaceId: body.workspaceId, goalId: null, taskId: null });
    return ok(c, result, 201);
  });

  app.post('/plugins/:id/uninstall', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: string };
    if (!body.workspaceId) throw AppError.badRequest('缺少 workspaceId');
    gate('plugin.uninstall', c.req.query('confirm') === 'true', { pluginId: c.req.param('id') });
    const result = await pluginInstaller.uninstall(body.workspaceId, c.req.param('id'));
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'plugin.uninstall', targetType: 'plugin', targetId: c.req.param('id'), confirmedByUser: true, detail: { name: result.name } });
    eventBus.publishBuffered(EventType.PLUGIN_UNINSTALLED, result, { workspaceId: body.workspaceId, goalId: null, taskId: null });
    return ok(c, result);
  });

  app.post('/plugins/:id/update', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: string };
    if (!body.workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const result = await pluginInstaller.update(body.workspaceId, c.req.param('id'));
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'plugin.update', targetType: 'plugin', targetId: c.req.param('id'), confirmedByUser: true, detail: { from: result.previousVersion, to: result.latest, grantsRevoked: result.grantedScopes.length === 0 } });
    return ok(c, result);
  });

  app.get('/plugins/:id/permissions', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const installed = await pluginInstaller.listInstalled(workspaceId);
    const target = installed.find((p) => p.pluginId === c.req.param('id') || p.installationId === c.req.param('id'));
    if (!target) throw AppError.notFound(`插件未安装: ${c.req.param('id')}`);
    return ok(c, { installationId: target.installationId, permissions: target.permissions, grantedScopes: target.grantedScopes, requiresUserAuth: target.requiresUserAuth, secretRefs: target.secretRefs });
  });

  app.post('/plugins/:id/grant', async (c) => {
    const body = await parseJson(c, S.isGrantPluginRequest, 'grant');
    const result = await pluginInstaller.grant({ workspaceId: body.workspaceId, installationId: c.req.param('id'), scopes: body.scopes, ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }) });
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'plugin.grant', targetType: 'plugin', targetId: c.req.param('id'), confirmedByUser: true, detail: { scopes: result.granted } });
    eventBus.publishBuffered(EventType.PLUGIN_GRANTED, result, { workspaceId: body.workspaceId, goalId: null, taskId: null });
    return ok(c, result);
  });

  app.post('/plugins/:id/revoke', async (c) => {
    const body = await parseJson(c, S.isRevokePluginRequest, 'revoke');
    gate('plugin.revoke', c.req.query('confirm') === 'true', { installationId: c.req.param('id') });
    const result = await pluginInstaller.revoke({ workspaceId: body.workspaceId, installationId: c.req.param('id'), ...(body.scopes ? { scopes: body.scopes } : {}) });
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'plugin.revoke', targetType: 'plugin', targetId: c.req.param('id'), confirmedByUser: true, detail: { revoked: result.revoked } });
    eventBus.publishBuffered(EventType.PLUGIN_REVOKED, result, { workspaceId: body.workspaceId, goalId: null, taskId: null });
    return ok(c, result);
  });

  app.post('/plugins/:id/invoke', async (c) => {
    const body = await parseJson(c, S.isInvokePluginRequest, 'invoke');
    requirePhase4('phase4PaidPlugins', '插件调用');
    const result = await pluginRuntime.invoke({
      workspaceId: body.workspaceId,
      installationId: c.req.param('id'),
      tool: body.tool,
      ...(body.args ? { args: body.args } : {}),
      confirm: body.confirm === true,
    });
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'plugin.invoke', targetType: 'plugin', targetId: c.req.param('id'), confirmedByUser: body.confirm === true, detail: { tool: body.tool, ok: result.ok, degraded: result.degraded, denied: result.denied?.missingScopes ?? null } });
    eventBus.publishBuffered(EventType.PLUGIN_CALLED, { tool: body.tool, ok: result.ok }, { workspaceId: body.workspaceId, goalId: null, taskId: null });
    return ok(c, result);
  });

  app.get('/plugins/:id/calls', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { calls: await pluginCalls.list(workspaceId, c.req.param('id'), Number(c.req.query('limit') ?? 100)) });
  });

  app.get('/mcp/servers', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const servers = await mcpRegistry.list(workspaceId);
    return ok(c, { servers, transports: ['stdio', 'http', 'sse', 'websocket'] });
  });

  app.post('/mcp/servers', async (c) => {
    const body = await parseJson(c, S.isRegisterMcpServerRequest, 'mcp');
    gate('mcp.server.register', c.req.query('confirm') === 'true', { name: body.name });
    const server = await mcpRegistry.register({
      workspaceId: body.workspaceId,
      name: body.name,
      ...(body.transport ? { transport: body.transport as 'stdio' } : {}),
      ...(body.endpoint ? { endpoint: body.endpoint } : {}),
      ...(body.command ? { command: body.command } : {}),
      ...(body.args ? { args: body.args } : {}),
      ...(body.secretRefs ? { secretRefs: body.secretRefs } : {}),
    });
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'mcp.server.register', targetType: 'mcp_server', targetId: server.id, confirmedByUser: true, detail: { name: server.name, transport: server.transport, endpoint: server.endpoint } });
    eventBus.publishBuffered(EventType.MCP_SERVER_UPDATED, { id: server.id, name: server.name }, { workspaceId: body.workspaceId, goalId: null, taskId: null });
    return ok(c, { server }, 201);
  });

  app.delete('/mcp/servers/:id', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    gate('mcp.server.remove', c.req.query('confirm') === 'true', { serverId: c.req.param('id') });
    const result = await mcpRegistry.remove(workspaceId, c.req.param('id'));
    await audit.record({ workspaceId, actor: 'user', action: 'mcp.server.remove', targetType: 'mcp_server', targetId: c.req.param('id'), confirmedByUser: true, detail: {} });
    return ok(c, result);
  });

  /** 能力探测：连通后同步工具清单（未连通则显式 degraded） */
  app.post('/mcp/servers/:id/sync', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const server = await mcpRegistry.get(workspaceId, c.req.param('id'));
    const client = createMcpClient(server as never);
    const result = await client.listTools();
    if (result.degraded) {
      await mcpRegistry.setStatus(server.id, 'registered', 'stdio 传输需要宿主进程，未注入 host');
      return ok(c, { synced: 0, degraded: true, note: '未接入 MCP 宿主进程，工具清单未同步（不会伪造工具列表）', tools: [] });
    }
    const tools = await mcpRegistry.syncTools(server.id, result.tools.map((t) => ({ name: t.name, description: t.description, schema: t.schema })));
    await mcpRegistry.setStatus(server.id, 'connected', null);
    return ok(c, { synced: tools.length, degraded: false, tools });
  });

  app.get('/mcp/servers/:id/tools', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    await mcpRegistry.get(workspaceId, c.req.param('id'));
    return ok(c, { tools: await mcpRegistry.listTools(c.req.param('id')) });
  });

  /* ------------------- Step 2：付费数据库 ------------------- */

  app.get('/paid-data/providers', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    const providers = listProviders();
    if (!workspaceId) return ok(c, { providers: providers.map((p) => ({ ...p, credentialConfigured: false, configuredFields: [] })) });
    const configured = await credentials.list(workspaceId);
    return ok(c, {
      providers: providers.map((p) => {
        const hit = configured.find((x) => x.providerId === p.id);
        return { ...p, status: hit ? hit.status : p.requiresUserAuth ? 'unconfigured' : 'available', credentialConfigured: Boolean(hit), configuredFields: hit?.fieldNames ?? [] };
      }),
      disclaimer: '所有付费数据源只通过官方 API 或你本机已授权的终端接入；工作台不代持账号、不绕过反爬、不共享登录态。',
    });
  });

  app.post('/paid-data/credentials', async (c) => {
    const body = await parseJson(c, S.isSavePaidCredentialRequest, 'credentials');
    gate('paid_data.credential.save', c.req.query('confirm') === 'true', { providerId: c.req.query('providerId') ?? '' });
    const providerId = String(c.req.query('providerId') ?? '');
    if (!providerId) throw AppError.badRequest('缺少 providerId 查询参数');
    const result = await credentials.save({ workspaceId: body.workspaceId, providerId, credentials: body.credentials, replace: body.replace === true });
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'paid_data.credential.save', targetType: 'paid_data_provider', targetId: providerId, confirmedByUser: true, detail: { fields: result.fieldNames, missing: result.requiredMissing } });
    return ok(c, result, 201);
  });

  app.get('/paid-data/credentials', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { credentials: await credentials.list(workspaceId), requiredFields: Object.fromEntries(listProviders().map((p) => [p.id, requiredCredentialKeys(p.id)])) });
  });

  app.delete('/paid-data/credentials/:providerId', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    gate('paid_data.credential.delete', c.req.query('confirm') === 'true', { providerId: c.req.param('providerId') });
    const result = await credentials.remove(workspaceId, c.req.param('providerId'));
    await audit.record({ workspaceId, actor: 'user', action: 'paid_data.credential.delete', targetType: 'paid_data_provider', targetId: c.req.param('providerId'), confirmedByUser: true, detail: {} });
    return ok(c, result);
  });

  /** 预检：提交查询前告诉用户「会不会被合规守卫拒绝」 */
  app.post('/paid-data/preflight', async (c) => {
    const body = await parseJson(c, S.isPaidQueryRequest, 'preflight');
    const creds = await credentials.resolve(body.workspaceId, body.providerId);
    const spec = findProvider(body.providerId);
    const hasCredentials = Boolean(spec) && spec!.credentialFields.filter((f) => f.required).every((f) => Boolean(creds[f.key]?.trim()));
    return ok(c, paidRunner.preflight({ providerId: body.providerId, action: body.action, params: body.params ?? {}, hasCredentials }));
  });

  app.post('/paid-data/query', async (c) => {
    const body = await parseJson(c, S.isPaidQueryRequest, 'query');
    requirePhase4('phase4PaidPlugins', '付费数据查询');

    gate('paid_data.query', c.req.query('confirm') === 'true' || body.confirm === true, { providerId: body.providerId, action: body.action });
    const creds = await credentials.resolve(body.workspaceId, body.providerId);
    const result = await paidRunner.run({
      workspaceId: body.workspaceId,
      providerId: body.providerId,
      action: body.action,
      params: body.params ?? {},
      credentials: creds,
      noCache: body.noCache === true,
      ...(body.purpose ? { purpose: body.purpose } : {}),
    });
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'paid_data.query', targetType: 'paid_data_provider', targetId: body.providerId, confirmedByUser: true, detail: { action: body.action, status: result.status, cached: result.cached, degraded: result.degraded, blockedReason: result.blockedReason ?? null } });
    eventBus.publishBuffered(result.status === 'blocked' ? EventType.PAID_DATA_BLOCKED : EventType.PAID_DATA_QUERY, { providerId: body.providerId, action: body.action, status: result.status }, { workspaceId: body.workspaceId, goalId: null, taskId: null });
    return ok(c, result);
  });

  app.get('/paid-data/queries', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { queries: await paidRunner.listQueries(workspaceId, Number(c.req.query('limit') ?? 50)) });
  });

  app.get('/paid-data/queries/:id', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, await paidRunner.getQuery(workspaceId, c.req.param('id')));
  });

  /* ------------------- Step 3：提示词工程 ------------------- */

  app.get('/prompts/library', (c) => ok(c, { templates: promptsV4.library() }));

  app.post('/prompts/library/:key', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: string; name?: string };
    if (!body.workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const result = await promptsV4.createFromLibrary(body.workspaceId, c.req.param('key'), body.name);
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'prompt.library.use', targetType: 'prompt_template', targetId: result.templateId, confirmedByUser: true, detail: { key: c.req.param('key'), version: result.version } });
    return ok(c, result, 201);
  });

  app.get('/prompts/catalog', (c) => ok(c, { metrics: promptsV4.metricCatalog() }));

  app.get('/prompts/v4', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { templates: await promptsV4.list(workspaceId) });
  });

  app.get('/prompts/v4/:name', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const version = c.req.query('version') ? Number(c.req.query('version')) : undefined;
    return ok(c, await promptsV4.detail(workspaceId, c.req.param('name'), version));
  });

  app.post('/prompts/generate', async (c) => {
    requirePhase4('phase4Prompt', '提示词工程');
    const body = await parseJson(c, S.isPromptGenerateRequest, 'generate');
    const result = await promptsV4.generate({ workspaceId: body.workspaceId, goal: body.goal, ...(body.context ? { context: body.context } : {}), ...(body.targetModel ? { targetModel: body.targetModel } : {}), ...(body.useModel === undefined ? {} : { useModel: body.useModel }) });
    eventBus.publishBuffered(EventType.PROMPT_GENERATED, { intent: result.intent, degraded: result.degraded }, { workspaceId: body.workspaceId, goalId: null, taskId: null });
    return ok(c, result);
  });

  app.post('/prompts/optimize-v4', async (c) => {
    const body = await parseJson(c, S.isPromptOptimizeV4Request, 'optimize');
    const result = await promptsV4.optimize({ workspaceId: body.workspaceId, current: body.current as never, ...(body.intent ? { intent: body.intent } : {}), ...(body.targetModel ? { targetModel: body.targetModel } : {}), ...(body.useModel === undefined ? {} : { useModel: body.useModel }) });
    eventBus.publishBuffered(EventType.PROMPT_OPTIMIZED, { score: result.score, degraded: result.degraded }, { workspaceId: body.workspaceId, goalId: null, taskId: null });
    return ok(c, result);
  });

  /** 一键复制：返回可直接粘贴的 Markdown */
  app.post('/prompts/copy', async (c) => {
    const body = await parseJson(c, S.isPromptCopyRequest, 'copy');
    return ok(c, promptsV4.copyable({ sections: body.sections as never, ...(body.variables ? { variables: body.variables } : {}), ...(body.name ? { name: body.name } : {}) }));
  });

  app.post('/prompts/v4', async (c) => {
    requirePhase4('phase4Prompt', '提示词工程');
    const body = await parseJson(c, S.isPromptSaveV4Request, 'prompt');
    const result = await promptsV4.save({
      workspaceId: body.workspaceId,
      name: body.name,
      sections: body.sections as never,
      ...(body.tags ? { tags: body.tags } : {}),
      ...(body.variables ? { variables: body.variables as never } : {}),
    });
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'prompt.version.save', targetType: 'prompt_template', targetId: result.templateId, confirmedByUser: true, detail: { name: result.name, version: result.version } });
    eventBus.publishBuffered(EventType.PROMPT_VERSION_SAVED, { name: result.name, version: result.version }, { workspaceId: body.workspaceId, goalId: null, taskId: null });
    return ok(c, result, 201);
  });

  app.post('/prompts/v4/:name/rollback', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: string; version?: number };
    if (!body.workspaceId || typeof body.version !== 'number') throw AppError.badRequest('缺少 workspaceId 或 version');
    gate('prompt.version.rollback', c.req.query('confirm') === 'true', { name: c.req.param('name'), version: body.version });
    const result = await promptsV4.rollbackVersion(body.workspaceId, c.req.param('name'), body.version);
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'prompt.version.rollback', targetType: 'prompt_template', targetId: result.templateId, confirmedByUser: true, detail: { name: c.req.param('name'), from: body.version, to: result.version } });
    return ok(c, result);
  });

  app.post('/prompts/v4/:name/abtest', async (c) => {
    const body = await parseJson(c, S.isAbTestCreateRequest, 'abtest');
    const result = await promptsV4.createABTest({ workspaceId: body.workspaceId, templateName: body.templateName, versionA: body.versionA, versionB: body.versionB, ...(body.name ? { name: body.name } : {}) });
    eventBus.publishBuffered(EventType.PROMPT_ABTEST_UPDATED, result, { workspaceId: body.workspaceId, goalId: null, taskId: null });
    return ok(c, result, 201);
  });

  app.get('/prompts/abtests', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { tests: await promptsV4.listABTests(workspaceId) });
  });

  app.post('/prompts/abtests/:id/evaluate', async (c) => {
    const body = await parseJson(c, S.isAbEvaluationRequest, 'evaluate');
    const result = await promptsV4.recordEvaluation({ workspaceId: body.workspaceId, abTestId: c.req.param('id'), version: body.version, metric: body.metric, value: body.value, sampleSize: body.sampleSize, ...(body.note ? { note: body.note } : {}) });
    return ok(c, result, 201);
  });

  app.post('/prompts/abtests/:id/auto-evaluate', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, await promptsV4.autoEvaluate({ workspaceId, abTestId: c.req.param('id') }));
  });

  app.get('/prompts/abtests/:id', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, await promptsV4.report(workspaceId, c.req.param('id')));
  });

  app.post('/prompts/abtests/:id/finish', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, await promptsV4.finishABTest(workspaceId, c.req.param('id')));
  });

  /* ------------------- Step 4：实验性集群 ------------------- */

  app.get('/cluster/nodes', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const [nodes, policy] = await Promise.all([cluster.nodes.list(), cluster.policies.get(workspaceId)]);
    const health = await cluster.nodes.healthAll(200);
    const latest = new Map<string, (typeof health)[number]>();
    for (const h of health) if (!latest.has(h.nodeId)) latest.set(h.nodeId, h);
    return ok(c, {
      nodes: nodes.map((n) => ({ ...n, metrics: latest.get(n.id) ? { cpu: latest.get(n.id)!.cpu, memory: latest.get(n.id)!.memory, gpu: latest.get(n.id)!.gpu, disk: latest.get(n.id)!.disk, network: latest.get(n.id)!.network } : null })),
      policy,
    });
  });

  app.post('/cluster/nodes', async (c) => {
    requirePhase4('phase4Cluster', '实验性集群');
    const body = await parseJson(c, S.isClusterNodeRegisterRequest, 'node');
    const policy = await cluster.policies.get(body.workspaceId);
    const node = await cluster.nodes.register(
      {
        name: body.name,
        ...(body.role ? { role: body.role as 'worker' } : {}),
        ...(body.host ? { host: body.host } : {}),
        ...(body.port === undefined ? {} : { port: body.port }),
        ...(body.resources ? { resources: body.resources } : {}),
        ...(body.labels ? { labels: body.labels } : {}),
      },
      { maxNodes: policy.maxNodes, allowLoopback: true },
    );
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'cluster.node.register', targetType: 'cluster_node', targetId: node.id, confirmedByUser: true, detail: { name: node.name, host: node.host, port: node.port } });
    eventBus.publishBuffered(EventType.CLUSTER_NODE_REGISTERED, { nodeId: node.id, name: node.name }, { workspaceId: body.workspaceId, goalId: null, taskId: null });
    return ok(c, { node }, 201);
  });

  app.delete('/cluster/nodes/:id', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    gate('cluster.node.remove', c.req.query('confirm') === 'true', { nodeId: c.req.param('id') });
    const result = await cluster.nodes.remove(c.req.param('id'));
    await audit.record({ workspaceId, actor: 'user', action: 'cluster.node.remove', targetType: 'cluster_node', targetId: c.req.param('id'), confirmedByUser: true, detail: result });
    return ok(c, result);
  });

  app.post('/cluster/nodes/:id/heartbeat', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, number> | undefined;
    if (!S.isClusterHeartbeatRequest(body)) throw AppError.badRequest('心跳指标必须是数字：cpu/memory/gpu/disk/network');
    const node = await cluster.heartbeat.beat(c.req.param('id'), body as never);
    return ok(c, { node });
  });

  app.post('/cluster/sweep', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const policy = await cluster.policies.get(workspaceId);
    const result = await cluster.monitor.sweep(policy.heartbeatTimeoutMs);
    return ok(c, { offline: result.offline.map((n) => ({ id: n.id, name: n.name })), online: result.online.map((n) => ({ id: n.id, name: n.name })) });
  });

  app.get('/cluster/status', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const requested = c.req.query('mode') === 'single' ? 'single' : 'cluster';
    return ok(c, await cluster.status(workspaceId, requested));
  });

  app.get('/cluster/health', async (c) => ok(c, await cluster.monitor.healthSummary()));

  app.get('/cluster/elections', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { elections: await cluster.elections.history(Number(c.req.query('limit') ?? 20)), term: await cluster.elections.currentTerm() });
  });

  app.post('/cluster/elections', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    gate('cluster.election.force', c.req.query('confirm') === 'true', {});
    const result = await cluster.elections.elect({ reason: 'manual' });
    await audit.record({ workspaceId, actor: 'user', action: 'cluster.election.force', targetType: 'cluster', targetId: 'local', confirmedByUser: true, detail: { term: result.term, leaderNodeId: result.leaderNodeId, reason: result.reason, changed: result.changed } });
    return ok(c, result);
  });

  app.get('/cluster/tasks', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { tasks: await cluster.distributor.listTasks(workspaceId, Number(c.req.query('limit') ?? 100)) });
  });

  app.post('/cluster/tasks/distribute', async (c) => {
    const body = await parseJson(c, S.isShardDistributeRequest, 'distribute');
    const policy = await cluster.policies.get(body.workspaceId);
    const online = (await cluster.nodes.list()).filter((n) => n.status === 'online');
    const shards = shardAuto(body.items, body.shardCount ?? policy.maxParallelTasks, typeof body.need?.cpu === 'number' ? () => 1 : undefined);
    const result = await cluster.distributor.distribute({
      workspaceId: body.workspaceId,
      taskId: body.taskId,
      ...(body.goalId ? { goalId: body.goalId } : {}),
      shards,
      nodes: online,
      ...(body.labels ? { labels: body.labels } : {}),
      ...(body.need ? { need: body.need } : {}),
      maxParallel: policy.maxParallelTasks,
    });
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'cluster.task.distribute', targetType: 'cluster_task', targetId: body.taskId, confirmedByUser: true, detail: { shards: shards.length, assigned: result.assignments.length, skipped: result.skipped.length } });
    eventBus.publishBuffered(EventType.CLUSTER_SHARD_UPDATED, { taskId: body.taskId, assignments: result.assignments }, { workspaceId: body.workspaceId, goalId: body.goalId ?? null, taskId: body.taskId });
    return ok(c, result, 202);
  });

  app.post('/cluster/shards/:id/complete', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ok?: boolean; result?: Record<string, unknown>; error?: string };
    if (typeof body.ok !== 'boolean') throw AppError.badRequest('缺少 ok（布尔值）');
    const result = await cluster.distributor.complete(c.req.param('id'), { ok: body.ok, ...(body.result ? { result: body.result } : {}), ...(body.error ? { error: body.error } : {}) });
    return ok(c, result);
  });

  app.post('/cluster/tasks/:id/cancel', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const result = await cluster.distributor.cancelTask(workspaceId, c.req.param('id'));
    if (!result) throw AppError.notFound(`集群任务不存在: ${c.req.param('id')}`);
    return ok(c, { task: result });
  });

  app.get('/cluster/policy', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { policy: await cluster.policies.get(workspaceId) });
  });

  app.patch('/cluster/policy', async (c) => {
    const body = await parseJson(c, S.isClusterPolicyUpdateRequest, 'policy');
    gate('cluster.policy.update', c.req.query('confirm') === 'true', {});
    const policy = await cluster.policies.update(body.workspaceId, {
      ...(body.maxNodes === undefined ? {} : { maxNodes: body.maxNodes }),
      ...(body.maxParallelTasks === undefined ? {} : { maxParallelTasks: body.maxParallelTasks }),
      ...(body.resourceLimits === undefined ? {} : { resourceLimits: body.resourceLimits }),
      ...(body.fallbackEnabled === undefined ? {} : { fallbackEnabled: body.fallbackEnabled }),
      ...(body.heartbeatTimeoutMs === undefined ? {} : { heartbeatTimeoutMs: body.heartbeatTimeoutMs }),
    });
    await cluster.syncHeartbeat(body.workspaceId);
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'cluster.policy.update', targetType: 'cluster_policy', targetId: policy.id, confirmedByUser: true, detail: { maxNodes: policy.maxNodes, maxParallelTasks: policy.maxParallelTasks, fallbackEnabled: policy.fallbackEnabled } });
    return ok(c, { policy });
  });

  app.post('/cluster/bootstrap', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: string };
    if (!body.workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const result = await cluster.ensureBootstrapped(body.workspaceId);
    return ok(c, result);
  });

  /* ------------------- Step 5：多 Agent 并行 ------------------- */

  app.get('/agents/pool', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const list = await pools.list(workspaceId);
    const withBusy = await Promise.all(
      list.map(async (p) => {
        const busy = await pools.busyAgents(workspaceId, p.role);
        return { ...p, busy: busy.length, headroom: Math.max(0, p.activeAgents - busy.length) };
      }),
    );
    return ok(c, { pools: withBusy });
  });

  app.post('/agents/pool', async (c) => {
    const body = await parseJson(c, S.isAgentPoolCreateRequest, 'pool');
    const pool = await pools.create({ workspaceId: body.workspaceId, name: body.name, role: body.role, ...(body.minAgents === undefined ? {} : { minAgents: body.minAgents }), ...(body.maxAgents === undefined ? {} : { maxAgents: body.maxAgents }), ...(body.model === undefined ? {} : { model: body.model }), ...(body.tools ? { tools: body.tools } : {}) });
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'agent.pool.create', targetType: 'agent_pool', targetId: pool.id, confirmedByUser: true, detail: { role: pool.role, min: pool.minAgents, max: pool.maxAgents } });
    return ok(c, { pool }, 201);
  });

  app.post('/agents/pool/scale', async (c) => {
    const body = await parseJson(c, S.isAgentPoolScaleRequest, 'scale');
    const role = String(c.req.query('role') ?? '');
    if (!role) throw AppError.badRequest('缺少 role 查询参数');
    gate('agent.pool.scale', c.req.query('confirm') === 'true', { role, target: body.target });
    const result = await pools.scale({ workspaceId: body.workspaceId, idOrRole: role, target: body.target });
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'agent.pool.scale', targetType: 'agent_pool', targetId: result.pool.id, confirmedByUser: true, detail: { role, target: body.target, changed: result.changed } });
    eventBus.publishBuffered(EventType.AGENT_POOL_UPDATED, result, { workspaceId: body.workspaceId, goalId: null, taskId: null });
    return ok(c, result);
  });

  app.patch('/agents/pool/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const workspaceId = String(body.workspaceId ?? '');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const pool = await pools.update(workspaceId, c.req.param('id'), body as never);
    return ok(c, { pool });
  });

  app.get('/agents/routes', async (c) => {
    const taskId = c.req.query('taskId');
    if (taskId) return ok(c, { routes: await routeRecorder.list(taskId) });
    return ok(c, { routes: await routeRecorder.listRecent(Number(c.req.query('limit') ?? 100)) });
  });

  app.get('/agents/models', (c) => ok(c, { models: Object.entries(MODEL_PRICES).map(([model, price]) => ({ model, inputPricePerM: price.in, outputPricePerM: price.out })) }));

  app.post('/agents/orchestrate', async (c) => {
    const body = await parseJson(c, S.isOrchestrateRequest, 'orchestrate');
    const poolList = await pools.list(body.workspaceId);
    const configuredMax = body.maxParallel ?? 4;
    const budget = await costBudgetFor(body.workspaceId);
    const result = body.dryRun === false
      ? await orchestrator.run({
          workspaceId: body.workspaceId,
          ...(body.goalId ? { goalId: body.goalId } : {}),
          nodes: body.nodes as never,
          ...(body.taskTexts ? { taskTexts: body.taskTexts } : {}),
          ...(body.taskKinds ? { taskKinds: body.taskKinds } : {}),
          pools: poolList as never,
          modelCandidates: Object.entries(MODEL_PRICES).map(([model, price]) => ({ model, contextWindow: model.includes('4.1') ? 1_000_000 : 128_000, inputPricePerM: price.in, outputPricePerM: price.out, strengths: ['general'], longContext: model.includes('4.1') })),
          toolCandidates: [
            { name: 'fs.read', keywords: ['文件', '读取', 'file'] },
            { name: 'fs.write', keywords: ['写入', '生成文件', 'save'], dangerous: true },
            { name: 'web.fetch', keywords: ['联网', '检索', '搜索', 'url'], network: true },
            { name: 'db.query', keywords: ['数据库', '查询', 'sql'] },
          ],
          networkAllowed: body.networkAllowed === true,
          configuredMaxParallel: configuredMax,
          budget,
        })
      : await orchestrator.plan({
          workspaceId: body.workspaceId,
          ...(body.goalId ? { goalId: body.goalId } : {}),
          nodes: body.nodes as never,
          ...(body.taskTexts ? { taskTexts: body.taskTexts } : {}),
          ...(body.taskKinds ? { taskKinds: body.taskKinds } : {}),
          pools: poolList as never,
          modelCandidates: Object.entries(MODEL_PRICES).map(([model, price]) => ({ model, contextWindow: model.includes('4.1') ? 1_000_000 : 128_000, inputPricePerM: price.in, outputPricePerM: price.out, strengths: ['general'], longContext: model.includes('4.1') })),
          toolCandidates: [],
          networkAllowed: body.networkAllowed === true,
          configuredMaxParallel: configuredMax,
          budget,
        });
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'agent.orchestrate', targetType: 'goal', targetId: body.goalId ?? null, confirmedByUser: true, detail: { tasks: body.nodes.length, dispatched: result.dispatched.length, parallelism: result.parallelism.limit, dryRun: body.dryRun !== false } });
    return ok(c, result);
  });

  app.get('/aggregated/results', async (c) => {
    const taskId = c.req.query('taskId');
    if (!taskId) throw AppError.badRequest('缺少 taskId');
    return ok(c, { results: await aggregations.get(taskId) });
  });

  app.post('/aggregated/:id/resolve', async (c) => {
    const body = await parseJson(c, S.isAggregateResolveRequest, 'resolve');
    gate('aggregated.resolve', c.req.query('confirm') === 'true', { id: c.req.param('id') });
    const result = await aggregations.resolve({ workspaceId: body.workspaceId, id: c.req.param('id'), decisions: body.decisions });
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'aggregated.resolve', targetType: 'aggregated_result', targetId: c.req.param('id'), confirmedByUser: true, detail: result });
    return ok(c, result);
  });

  app.get('/costs', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const goalId = c.req.query('goalId');
    if (goalId) return ok(c, await costs.byGoal(workspaceId, goalId));
    return ok(c, await costs.summary(workspaceId, await costBudgetFor(workspaceId)));
  });

  app.post('/costs', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const workspaceId = String(body.workspaceId ?? '');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    if (typeof body.model !== 'string' || typeof body.tokensIn !== 'number' || typeof body.tokensOut !== 'number') {
      throw AppError.badRequest('model / tokensIn / tokensOut 必填');
    }
    const result = await costs.record(
      { workspaceId, goalId: (body.goalId as string) ?? null, taskId: (body.taskId as string) ?? null, agentId: (body.agentId as string) ?? null, model: body.model, tokensIn: body.tokensIn, tokensOut: body.tokensOut, ...(typeof body.costUsd === 'number' ? { costUsd: body.costUsd } : {}) },
      await costBudgetFor(workspaceId),
    );
    eventBus.publishBuffered(result.state === 'none' ? EventType.COST_RECORDED : EventType.COST_BUDGET_WARNING, result, { workspaceId, goalId: null, taskId: null });
    return ok(c, result, 201);
  });

  /* ------------------- Step 6：企业安全与审计 ------------------- */

  app.get('/rbac/permissions', (c) => ok(c, { permissions: rbac.permissionCatalog(), all: ALL_PERMISSIONS }));

  app.get('/rbac/roles', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    await rbac.ensureBuiltinRoles(workspaceId);
    return ok(c, { roles: await rbac.listRoles(workspaceId) });
  });

  app.post('/rbac/roles', async (c) => {
    requirePhase4('phase4Enterprise', '企业安全');
    const body = await parseJson(c, S.isRbacRoleCreateRequest, 'role');
    const role = await rbac.createRole({ workspaceId: body.workspaceId, name: body.name, permissions: body.permissions });
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'rbac.role.create', targetType: 'role', targetId: role.id, confirmedByUser: true, detail: { name: role.name, permissions: role.permissions } });
    eventBus.publishBuffered(EventType.RBAC_ROLE_UPDATED, { name: role.name }, { workspaceId: body.workspaceId, goalId: null, taskId: null });
    return ok(c, { role }, 201);
  });

  app.patch('/rbac/roles/:name', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: string; permissions?: string[] };
    if (!body.workspaceId || !Array.isArray(body.permissions)) throw AppError.badRequest('缺少 workspaceId 或 permissions');
    const role = await rbac.updateRole(body.workspaceId, c.req.param('name'), body.permissions);
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'rbac.role.update', targetType: 'role', targetId: role.id, confirmedByUser: true, detail: { name: role.name, permissions: role.permissions } });
    eventBus.publishBuffered(EventType.RBAC_ROLE_UPDATED, { name: role.name }, { workspaceId: body.workspaceId, goalId: null, taskId: null });
    return ok(c, { role });
  });

  app.delete('/rbac/roles/:name', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    gate('rbac.role.delete', c.req.query('confirm') === 'true', { name: c.req.param('name') });
    const result = await rbac.deleteRole(workspaceId, c.req.param('name'));
    await audit.record({ workspaceId, actor: 'user', action: 'rbac.role.delete', targetType: 'role', targetId: result.removed, confirmedByUser: true, detail: result });
    return ok(c, result);
  });

  app.post('/rbac/assign', async (c) => {
    const body = await parseJson(c, S.isRbacAssignRequest, 'assign');
    gate('rbac.assign', c.req.query('confirm') === 'true', { userId: body.userId, role: body.role });
    await rbac.ensureBuiltinRoles(body.workspaceId);
    const result = await rbac.assign({ workspaceId: body.workspaceId, userId: body.userId, roleNameOrId: body.role });
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'rbac.assign', targetType: 'user_role', targetId: body.userId, confirmedByUser: true, detail: { role: result.role, permissions: result.permissions } });
    return ok(c, result);
  });

  app.post('/rbac/unassign', async (c) => {
    const body = await parseJson(c, S.isRbacAssignRequest, 'unassign');
    const result = await rbac.unassign({ workspaceId: body.workspaceId, userId: body.userId, roleNameOrId: body.role });
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'rbac.unassign', targetType: 'user_role', targetId: body.userId, confirmedByUser: true, detail: { role: result.role } });
    return ok(c, result);
  });

  app.get('/rbac/users', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { users: await rbac.listUserRoles(workspaceId) });
  });

  app.get('/rbac/check', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    const userId = c.req.query('userId');
    const permission = c.req.query('permission');
    if (!workspaceId || !userId || !permission) throw AppError.badRequest('缺少 workspaceId / userId / permission');
    if (!(permission in PERMISSIONS)) throw AppError.badRequest(`未知权限点：${permission}`);
    return ok(c, await rbac.check({ workspaceId, userId, permission: permission as keyof typeof PERMISSIONS }));
  });

  app.get('/sso/config', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, await sso.describe(workspaceId));
  });

  app.post('/sso/config', async (c) => {
    const body = await parseJson(c, S.isSsoConfigRequest, 'sso');
    await rbac.ensureBuiltinRoles(body.workspaceId);
    const roles = (await rbac.listRoles(body.workspaceId)).map((r) => r.name);
    const result = await sso.upsert(body.workspaceId, {
      ...(body.protocol ? { protocol: body.protocol as 'oidc' } : {}),
      issuer: body.issuer,
      clientId: body.clientId ?? '',
      clientSecretRef: body.clientSecretRef,
      redirectUri: body.redirectUri ?? '',
      ...(body.groupMapping ? { groupMapping: body.groupMapping } : {}),
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
    }, roles);
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'sso.config.update', targetType: 'sso_config', targetId: 'sso', confirmedByUser: true, detail: { protocol: result.protocol, issuer: result.issuer, clientSecretRef: result.clientSecretRef } });
    eventBus.publishBuffered(EventType.SSO_CONFIG_UPDATED, { protocol: result.protocol }, { workspaceId: body.workspaceId, goalId: null, taskId: null });
    return ok(c, result);
  });

  app.post('/sso/enable', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: string; enabled?: boolean };
    if (!body.workspaceId || typeof body.enabled !== 'boolean') throw AppError.badRequest('缺少 workspaceId 或 enabled');
    gate('sso.enable', c.req.query('confirm') === 'true', {});
    const result = await sso.setEnabled(body.workspaceId, body.enabled);
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'sso.enable', targetType: 'sso_config', targetId: 'sso', confirmedByUser: true, detail: { enabled: body.enabled } });
    return ok(c, result);
  });

  app.delete('/sso/config', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    gate('sso.remove', c.req.query('confirm') === 'true', {});
    const result = await sso.remove(workspaceId);
    await audit.record({ workspaceId, actor: 'user', action: 'sso.remove', targetType: 'sso_config', targetId: 'sso', confirmedByUser: true, detail: {} });
    return ok(c, result);
  });

  app.get('/sso/auth-url', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, await sso.buildAuthUrl(workspaceId));
  });

  app.get('/audit/logs', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const logs = await auditQuery.list({
      workspaceId,
      ...(c.req.query('from') ? { from: c.req.query('from') as string } : {}),
      ...(c.req.query('to') ? { to: c.req.query('to') as string } : {}),
      ...(c.req.query('action') ? { action: c.req.query('action') as string } : {}),
      ...(c.req.query('actor') ? { actor: c.req.query('actor') as string } : {}),
      ...(c.req.query('dangerousOnly') === 'true' ? { dangerousOnly: true } : {}),
      limit: Number(c.req.query('limit') ?? 100),
    });
    return ok(c, { logs, stats: await auditQuery.stats(workspaceId) });
  });

  app.post('/audit/export', async (c) => {
    const body = await parseJson(c, S.isAuditExportRequest, 'export');
    gate('audit.export', c.req.query('confirm') === 'true', { from: body.from, to: body.to });
    const result = await complianceExport.exportAudit({ workspaceId: body.workspaceId, from: body.from, to: body.to, ...(body.actor ? { actor: body.actor } : {}) });
    eventBus.publishBuffered(EventType.AUDIT_EXPORTED, { exportId: result.exportId, rowCount: result.rowCount }, { workspaceId: body.workspaceId, goalId: null, taskId: null });
    return ok(c, result, 201);
  });

  app.get('/audit/exports', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { exports: await complianceExport.listExports(workspaceId) });
  });

  app.get('/audit/exports/:id/download', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const file = await complianceExport.readExport(workspaceId, c.req.param('id'));
    return new Response(new Uint8Array(file.content), {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-disposition': `attachment; filename="${file.fileName}"`,
        'content-length': String(file.content.length),
      },
    });
  });

  app.get('/compliance/mask-rules', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { rules: await dataMask.listRules(workspaceId), builtin: dataMask.builtinCatalog() });
  });

  app.post('/compliance/mask-rules', async (c) => {
    const body = await parseJson(c, S.isMaskRuleRequest, 'mask');
    const rule = await dataMask.upsertRule({ workspaceId: body.workspaceId, field: body.field, strategy: body.strategy as 'full', ...(body.target ? { target: body.target } : {}), ...(body.enabled === undefined ? {} : { enabled: body.enabled }) });
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'compliance.mask.upsert', targetType: 'data_mask_rule', targetId: rule.id, confirmedByUser: true, detail: { field: rule.field, strategy: rule.strategy, target: rule.target } });
    return ok(c, { rule }, 201);
  });

  app.delete('/compliance/mask-rules/:id', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const result = await dataMask.deleteRule(workspaceId, c.req.param('id'));
    await audit.record({ workspaceId, actor: 'user', action: 'compliance.mask.delete', targetType: 'data_mask_rule', targetId: c.req.param('id'), confirmedByUser: true, detail: result });
    return ok(c, result);
  });

  app.get('/compliance/mask-preview', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, await auditQuery.previewMask(workspaceId, Number(c.req.query('limit') ?? 10)));
  });

  app.get('/compliance/retention', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { policies: await retention.list(workspaceId), dataTypes: RETENTION_DATA_TYPES });
  });

  app.post('/compliance/retention', async (c) => {
    const body = await parseJson(c, S.isRetentionUpsertRequest, 'retention');
    const policy = await retention.upsert({ workspaceId: body.workspaceId, dataType: body.dataType, retentionDays: body.retentionDays, ...(body.action ? { action: body.action as 'delete' } : {}), ...(body.enabled === undefined ? {} : { enabled: body.enabled }) });
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'compliance.retention.upsert', targetType: 'retention_policy', targetId: policy.id, confirmedByUser: true, detail: { dataType: policy.dataType, retentionDays: policy.retentionDays, action: policy.action } });
    return ok(c, { policy }, 201);
  });

  app.delete('/compliance/retention/:dataType', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    const result = await retention.remove(workspaceId, c.req.param('dataType'));
    await audit.record({ workspaceId, actor: 'user', action: 'compliance.retention.delete', targetType: 'retention_policy', targetId: c.req.param('dataType'), confirmedByUser: true, detail: result });
    return ok(c, result);
  });

  /**
   * 执行保留策略。
   * 默认 dryRun=true：先给用户看「会删多少」，确认后（confirm=true）才真删。
   */
  app.post('/compliance/retention/apply', async (c) => {
    const body = await parseJson(c, S.isRetentionApplyRequest, 'apply');
    const dryRun = body.dryRun !== false;
    if (!dryRun) gate('retention.apply', c.req.query('confirm') === 'true', { dataType: body.dataType ?? 'all' });
    const results = await retention.apply(
      { workspaceId: body.workspaceId, ...(body.dataType ? { dataType: body.dataType as never } : {}), dryRun },
      buildRetentionExecutors(db),
    );
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'compliance.retention.apply', targetType: 'retention_policy', targetId: body.dataType ?? 'all', confirmedByUser: !dryRun, detail: { dryRun, results } });
    if (!dryRun) eventBus.publishBuffered(EventType.RETENTION_APPLIED, { results }, { workspaceId: body.workspaceId, goalId: null, taskId: null });
    return ok(c, { dryRun, results });
  });

  app.post('/compliance/package', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: string; from?: string; to?: string };
    if (!body.workspaceId || !body.from || !body.to) throw AppError.badRequest('缺少 workspaceId / from / to');
    const maskRules = (await dataMask.listRules(body.workspaceId)).map((r) => ({ field: r.field, strategy: r.strategy, target: r.target }));
    const retentionPolicies = (await retention.list(body.workspaceId)).map((p) => ({ dataType: p.dataType, retentionDays: p.retentionDays, action: p.action, enabled: p.enabled }));
    const pkg = await complianceExport.buildPackage({ workspaceId: body.workspaceId, from: body.from, to: body.to, maskRules, retentionPolicies });
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'compliance.package.build', targetType: 'compliance_package', targetId: body.workspaceId, confirmedByUser: true, detail: { auditCount: pkg.summary.auditCount } });
    return ok(c, pkg);
  });

  /* ---------------------------- 错误兜底 ---------------------------- */

  app.notFound((c) => fail(c, AppError.notFound(`接口不存在: ${c.req.method} ${c.req.path}`)));
  app.onError((err, c) => {
    if (!(err instanceof AppError)) console.error('[unhandled]', err);
    return fail(c, err);
  });

  return app;
}

/** 预算读取：从环境变量读取工作区级 Token 预算（美元），未配置则不限 */
async function costBudgetFor(_workspaceId: string) {
  const raw = Number(process.env.WORKBENCH_TOKEN_BUDGET_USD ?? '0');
  return { limitUsd: Number.isFinite(raw) && raw > 0 ? raw : 0, warnRatio: 0.8 };
}

/**
 * 保留策略执行器映射。
 * 表名在此处**白名单写死**，不接受任何外部输入拼表名（防注入）；
 * dryRun 只做 count，不做任何删除。
 */
function buildRetentionExecutors(db: Db): Partial<Record<RetentionDataType, (cutoff: string, action: string, dryRun: boolean) => Promise<{ scanned: number; affected: number }>>> {
  const tableFor: Record<string, string> = {
    audit_logs: 'audit_logs',
    schedule_runs: 'schedule_runs',
    plugin_call_logs: 'plugin_call_logs',
    cost_records: 'cost_records',
    conversations: 'conversations',
    office_documents: 'office_documents',
    research_reports: 'research_reports',
    deployment_logs: 'website_deployments',
  };
  const columnFor: Record<string, string> = {
    audit_logs: 'created_at',
    schedule_runs: 'started_at',
    plugin_call_logs: 'created_at',
    cost_records: 'created_at',
    conversations: 'created_at',
    office_documents: 'parsed_at',
    research_reports: 'created_at',
    deployment_logs: 'created_at',
  };
  const out: Record<string, (cutoff: string, action: string, dryRun: boolean) => Promise<{ scanned: number; affected: number }>> = {};
  for (const [dataType, table] of Object.entries(tableFor)) {
    const column = columnFor[dataType]!;
    out[dataType] = async (cutoff, action, dryRun) => {
      const sqlite = getSqlite();
      const countRow = sqlite.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${column} < ?`).get(cutoff) as { c: number } | undefined;
      const scanned = countRow?.c ?? 0;
      if (dryRun || scanned === 0) return { scanned, affected: 0 };
      if (action === 'delete') {
        sqlite.prepare(`DELETE FROM ${table} WHERE ${column} < ?`).run(cutoff);
      } else if (action === 'anonymize') {
        // 只对有明确「可匿名化字段」的表做处理；否则退化为「不删不改」，由用户选择 delete
        if (dataType === 'plugin_call_logs') {
          sqlite.prepare(`UPDATE plugin_call_logs SET args = '{}' WHERE ${column} < ?`).run(cutoff);
        } else {
          return { scanned, affected: 0 };
        }
      } else {
        // archive：不删除，仅记录（真实归档动作会写 audit_logs）
        return { scanned, affected: 0 };
      }
      void db;
      return { scanned, affected: scanned };
    };
  }
  return out as Partial<Record<RetentionDataType, (cutoff: string, action: string, dryRun: boolean) => Promise<{ scanned: number; affected: number }>>>;
}

/**
 * 追加文件上下文：把工作区内的文本文件读入，供上下文组装使用。
 * 只读取显式传入的相对路径，且受 safeJoin 边界保护。
 */
async function loadFileContexts(
  db: Db,
  conversationId: string,
  paths: string[],
): Promise<{ title: string; content: string; sourceId: string }[]> {
  const wsRows = await db.query.conversations.findMany({ where: (t, { eq }) => eq(t.id, conversationId), limit: 1 });
  const workspaceId = wsRows[0]?.workspaceId;
  if (!workspaceId) return [];
  const ws = await db.query.workspaces.findMany({ where: (t, { eq }) => eq(t.id, workspaceId), limit: 1 });
  const root = ws[0]?.rootPath ?? null;
  const out: { title: string; content: string; sourceId: string }[] = [];
  for (const rel of paths.slice(0, 20)) {
    try {
      const abs = safeJoin(root, rel);
      const buf = await readFile(abs);
      const limit = 200_000;
      out.push({
        title: rel,
        content: buf.subarray(0, limit).toString('utf8') + (buf.length > limit ? '\n…（文件过长已截断）' : ''),
        sourceId: `file:${rel}`,
      });
    } catch {
      // 单文件失败不影响整体上下文组装
    }
  }
  return out;
}

/** 会话未显式带工作区时，从会话归属推断（用于审计与事实落库） */
async function guessWorkspaceId(db: Db, conversationId: string): Promise<string> {
  const rows = await db.query.conversations.findMany({ where: (t, { eq }) => eq(t.id, conversationId), limit: 1 });
  return rows[0]?.workspaceId ?? conversationId;
}

export type App = ReturnType<typeof createApp>;
export { runMigrations };
export type { ApiResponse };

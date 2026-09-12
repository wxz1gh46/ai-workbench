import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { EventType, type ApiResponse, type Artifact } from '@ai/shared';
import { getDb, type Db } from '../db/client.ts';
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

  /* ---------------------------- 错误兜底 ---------------------------- */
  app.notFound((c) => fail(c, AppError.notFound(`接口不存在: ${c.req.method} ${c.req.path}`)));
  app.onError((err, c) => {
    if (!(err instanceof AppError)) console.error('[unhandled]', err);
    return fail(c, err);
  });

  return app;
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

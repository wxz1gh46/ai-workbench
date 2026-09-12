import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { EventType, type ApiResponse, type Artifact } from '@ai/shared';
import { getDb, type Db } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';
import { GoalService } from '../agent/goal-service.ts';
import { GoalEngine } from '../goals/goalEngine.ts';
import { OfficeService } from '../office/officeService.ts';
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
  const memory = new MemoryService(db);
  const context = new ContextManager(db);
  const files = new FileService(db);
  const schedules = new ScheduleService(db);
  const widgets = new WidgetService(db);
  const prompts = new PromptService(db);
  const pluginService = new PluginService(db);
  const audit = new AuditService(db);

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

  /* ---------------------------- 深度研究 --------------------------- */
  app.post('/research', async (c) => {
    const body = await parseJson(c, S.isResearchRequest, 'research');
    if (!config.features.phase2Research) {
      throw AppError.badRequest('深度研究将在 Phase 2 交付（当前无联网检索与多源验证能力），请先使用目标模式');
    }
    const result = await goalService.createGoal({
      workspaceId: body.workspaceId,
      objective: `深度研究：${body.topic}（深度：${body.depth ?? 'standard'}）`,
      acceptanceCriteria: ['多源交叉验证', '给出可追溯引用', `产出 ${(body.outputFormats ?? ['markdown']).join(' / ')}`],
    });
    return ok(c, result, 201);
  });

  /* ----------------------------- 网站部署 -------------------------- */
  app.post('/website/deploy', async (c) => {
    const body = await parseJson(c, S.isDeployWebsiteRequest, 'website');
    if (!config.features.phase3Deploy) {
      throw AppError.badRequest('网站部署将在 Phase 3 交付（需用户配置 Vercel/Cloudflare Token 与 Neon/Supabase 连接）');
    }
    await audit.record({ workspaceId: body.workspaceId, actor: 'user', action: 'website.deploy', targetType: 'website', targetId: null, confirmedByUser: body.confirm, detail: { description: body.description, provider: body.provider ?? 'vercel' } });
    return ok(c, { accepted: true, note: '部署任务已进入队列（Phase 3 实现具体 Provider 适配）' }, 202);
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
  app.post('/widgets', async (c) => {
    const body = await parseJson(c, S.isCreateWidgetRequest, 'widget');
    return ok(c, { widget: await widgets.createFromNaturalLanguage(body) }, 201);
  });

  app.get('/widgets', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { widgets: await widgets.list(workspaceId, c.req.query('dashboardId') ?? 'default') });
  });

  app.patch('/widgets/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { layout?: { x: number; y: number; w: number; h: number } };
    if (!body.layout) throw AppError.badRequest('缺少 layout');
    await widgets.updateLayout(c.req.param('id'), body.layout);
    return ok(c, { updated: true });
  });

  app.delete('/widgets/:id', async (c) => {
    await widgets.remove(c.req.param('id'));
    return ok(c, { removed: true });
  });

  /* ------------------------------ 审计 ----------------------------- */
  app.get('/audit', async (c) => {
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw AppError.badRequest('缺少 workspaceId');
    return ok(c, { logs: await audit.list(workspaceId, Number(c.req.query('limit') ?? 100)) });
  });

  app.get('/events/recent', (c) => ok(c, { events: eventBus.recent(Number(c.req.query('limit') ?? 100)) }));

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

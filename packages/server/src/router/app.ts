import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger as honoLogger } from 'hono/logger';
import { EventType, type ApiResponse, type Artifact } from '@ai/shared';
import { getDb, type Db } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';
import { GoalService } from '../agent/goal-service.ts';
import { MemoryService } from '../agent/memory.ts';
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
import { fail, ok, parseJson } from '../utils/http.ts';
import { newId } from '../utils/ids.ts';
import { config } from '../config.ts';
import * as S from './schemas.ts';

export interface AppDeps {
  db?: Db;
}

export function createApp(deps: AppDeps = {}) {
  const db = deps.db ?? getDb();
  const app = new Hono();
  const workspaceService = new WorkspaceService(db);
  const goalService = new GoalService(db);
  const memory = new MemoryService(db);
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
    return ok(c, { messages: await memory.listMessages(c.req.param('id'), 100) });
  });

  app.get('/conversations/:id/memory', async (c) => {
    return ok(c, { facts: await memory.listFacts(c.req.param('id')) });
  });

  app.get('/conversations/:id/context-preview', async (c) => {
    const q = c.req.query('q') ?? '';
    return ok(c, await memory.buildContext(c.req.param('id'), q));
  });

  app.post('/conversations/:id/messages', async (c) => {
    const conversationId = c.req.param('id');
    const body = await parseJson(c, S.isSendMessageRequest, 'message');
    const userMsg = await memory.appendMessage({ conversationId, role: 'user', content: body.content });
    const ctx = await memory.buildContext(conversationId, body.content);
    const chat = await modelRouter.chat({
      messages: [
        {
          role: 'system',
          content: ['你是 AI 工作台的对话助手。可用上下文如下：', ...ctx.blocks.map((b) => `【${b.kind}】\n${b.content}`)].join('\n\n'),
        },
        { role: 'user', content: body.content },
      ],
    });
    const assistantMsg = await memory.appendMessage({ conversationId, role: 'assistant', content: chat.content, citations: ctx.citations });
    await memory.extractFacts(conversationId, c.req.header('x-workspace-id') ?? 'unknown', body.content, userMsg.id);
    return ok(c, { userMessage: userMsg, assistantMessage: assistantMsg, citations: ctx.citations, degraded: chat.degraded });
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

export type App = ReturnType<typeof createApp>;
export { runMigrations };
export type { ApiResponse };

import { desc, eq } from 'drizzle-orm';
import type { WidgetKind } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { agents, files, goals, promptTemplates, scheduleRuns, schedules, tasks, websiteDeployments, websiteProjects, widgets } from '../db/schema/index.ts';

/**
 * 小组件数据源（Step 4）。
 *
 * 设计：
 *   - 每个组件类型对应一个 provider 函数，返回结构化 payload（前端只渲染，不计算）；
 *   - 全部是本地只读查询 → 无凭据也能工作；
 *   - 每个 provider 都返回 `degraded` 标记：数据缺失时明确说明原因，
 *     而不是返回空数组让用户以为「就是没有数据」。
 *
 * data-query 是唯一涉及外部的类型：它委托 DatabaseService 执行只读 SQL，
 * 由调用方（WidgetRuntime）注入，避免这里直接依赖数据库模块造成循环引用。
 */

export interface WidgetPayload {
  widgetId: string;
  type: WidgetKind;
  refreshedAt: string;
  degraded: boolean;
  error?: string;
  payload: unknown;
}

export interface QueryExecutor {
  runQuery(input: { workspaceId: string; id: string; sql: string; readOnly: boolean; limit: number }): Promise<{ columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; ms: number }>;
}

export class WidgetDataSources {
  constructor(
    private readonly db: Db,
    private readonly queryExecutor?: QueryExecutor,
  ) {}

  async fetch(input: { workspaceId: string; widgetId: string; type: WidgetKind; config: Record<string, unknown> }): Promise<WidgetPayload> {
    const base = {
      widgetId: input.widgetId,
      type: input.type,
      refreshedAt: new Date().toISOString(),
    };
    try {
      switch (input.type) {
        case 'task-progress':
          return { ...base, ...(await this.taskProgress(input.workspaceId, input.config)) };
        case 'agent-status':
          return { ...base, ...(await this.agentStatus(input.workspaceId, input.config)) };
        case 'file-list':
          return { ...base, ...(await this.fileList(input.workspaceId, input.config)) };
        case 'website-status':
          return { ...base, ...(await this.websiteStatus(input.workspaceId, input.config)) };
        case 'schedule-status':
          return { ...base, ...(await this.scheduleStatus(input.workspaceId, input.config)) };
        case 'data-query':
          return { ...base, ...(await this.dataQuery(input.workspaceId, input.config)) };
        case 'prompt-template':
          return { ...base, ...(await this.promptTemplates(input.workspaceId, input.config)) };
        default:
          return { ...base, degraded: true, error: `未知组件类型: ${String(input.type)}`, payload: null };
      }
    } catch (e) {
      return { ...base, degraded: true, error: e instanceof Error ? e.message : String(e), payload: null };
    }
  }

  private async taskProgress(workspaceId: string, config: Record<string, unknown>) {
    const goalId = typeof config.goalId === 'string' && config.goalId ? config.goalId : null;
    const goalRows = goalId
      ? await this.db.select().from(goals).where(eq(goals.id, goalId)).limit(1)
      : await this.db.select().from(goals).where(eq(goals.workspaceId, workspaceId)).orderBy(desc(goals.updatedAt)).limit(1);
    const goal = goalRows[0];
    if (!goal) {
      return { degraded: true, error: '工作区内暂无目标：先到「目标模式」创建一个目标', payload: { goal: null, total: 0, done: 0, running: 0, blocked: 0, progress: 0 } };
    }
    const taskRows = await this.db.select().from(tasks).where(eq(tasks.goalId, goal.id));
    const done = taskRows.filter((t) => t.status === 'succeeded').length;
    const running = taskRows.filter((t) => t.status === 'running' || t.status === 'ready').length;
    const blocked = taskRows.filter((t) => t.status === 'blocked' || t.status === 'failed').length;
    return {
      degraded: false,
      payload: {
        goal: { id: goal.id, title: goal.objective, status: goal.status, progress: goal.progress },
        total: taskRows.length,
        done,
        running,
        blocked,
        progress: taskRows.length > 0 ? Math.round((done / taskRows.length) * 100) : 0,
        blockers: config.showBlockers === false ? [] : taskRows.filter((t) => t.status === 'blocked').map((t) => ({ id: t.id, title: t.title, error: t.error })),
      },
    };
  }

  private async agentStatus(workspaceId: string, config: Record<string, unknown>) {
    const rows = await this.db.select().from(agents).where(eq(agents.workspaceId, workspaceId));
    const showIdle = config.showIdle !== false;
    const list = rows.filter((a) => showIdle || a.status === 'busy');
    return {
      degraded: false,
      payload: {
        total: rows.length,
        busy: rows.filter((a) => a.status === 'busy').length,
        idle: rows.filter((a) => a.status === 'idle').length,
        error: rows.filter((a) => a.status === 'error').length,
        agents: list.map((a) => ({ id: a.id, name: a.name, role: a.role, status: a.status, model: a.model })),
      },
    };
  }

  private async fileList(workspaceId: string, config: Record<string, unknown>) {
    const limit = clampLimit(config.limit, 20);
    const rows = await this.db.select().from(files).where(eq(files.workspaceId, workspaceId)).orderBy(desc(files.updatedAt)).limit(limit * 3);
    const mime = typeof config.mime === 'string' && config.mime ? config.mime : null;
    const list = rows.filter((f) => !mime || f.mime.includes(mime)).slice(0, limit);
    return {
      degraded: false,
      payload: {
        total: rows.length,
        files: list.map((f) => ({ id: f.id, name: f.name, path: f.path, mime: f.mime, size: f.size, version: f.version, updatedAt: f.updatedAt })),
      },
    };
  }

  private async websiteStatus(workspaceId: string, config: Record<string, unknown>) {
    const projectId = typeof config.websiteProjectId === 'string' && config.websiteProjectId ? config.websiteProjectId : null;
    const projects = projectId
      ? await this.db.select().from(websiteProjects).where(eq(websiteProjects.id, projectId)).limit(1)
      : await this.db.select().from(websiteProjects).where(eq(websiteProjects.workspaceId, workspaceId)).orderBy(desc(websiteProjects.updatedAt)).limit(5);
    if (projects.length === 0) {
      return { degraded: true, error: '还没有网站项目：到「部署中心」创建并生成一个吧', payload: { projects: [] } };
    }
    const out = [];
    for (const p of projects) {
      const deps = await this.db
        .select()
        .from(websiteDeployments)
        .where(eq(websiteDeployments.websiteProjectId, p.id))
        .orderBy(desc(websiteDeployments.createdAt))
        .limit(1);
      const latest = deps[0];
      out.push({
        id: p.id,
        name: p.name,
        status: p.status,
        url: config.showUrl === false ? null : (latest?.url ?? p.previewUrl),
        provider: latest?.provider ?? null,
        deployedAt: latest?.deployedAt ?? null,
        deployStatus: latest?.status ?? 'never',
        customDomain: p.plan && typeof p.plan === 'object' && 'customDomain' in p.plan ? (p.plan as { customDomain?: string }).customDomain : null,
      });
    }
    return { degraded: false, payload: { projects: out } };
  }

  private async scheduleStatus(workspaceId: string, config: Record<string, unknown>) {
    const limit = clampLimit(config.limit, 10);
    const rows = await this.db.select().from(schedules).where(eq(schedules.workspaceId, workspaceId)).limit(limit * 2);
    const onlyEnabled = config.onlyEnabled === true;
    const list = rows.filter((s) => !onlyEnabled || s.enabled).slice(0, limit);
    const out = [];
    for (const s of list) {
      const runs = await this.db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, s.id)).orderBy(desc(scheduleRuns.startedAt)).limit(1);
      out.push({
        id: s.id,
        name: s.name,
        trigger: s.trigger,
        expression: s.expression,
        timezone: s.timezone,
        enabled: s.enabled,
        nextRunAt: s.nextRunAt,
        lastRunAt: s.lastRunAt,
        lastStatus: runs[0]?.status ?? 'never',
        lastError: runs[0]?.error ?? null,
      });
    }
    return { degraded: false, payload: { total: rows.length, schedules: out } };
  }

  private async dataQuery(workspaceId: string, config: Record<string, unknown>) {
    const sql = typeof config.sql === 'string' ? config.sql.trim() : '';
    const connectionId = typeof config.connectionId === 'string' ? config.connectionId : '';
    if (!sql || !connectionId) {
      return { degraded: true, error: '数据查询组件需要配置 connectionId 与 sql（在组件配置面板中填写）', payload: null };
    }
    if (!this.queryExecutor) {
      return { degraded: true, error: '查询执行器未注入（服务配置问题）', payload: null };
    }
    // 强制只读：组件永远不能执行写 SQL
    const result = await this.queryExecutor.runQuery({
      workspaceId,
      id: connectionId,
      sql,
      readOnly: true,
      limit: clampLimit(config.limit, 50),
    });
    return {
      degraded: false,
      payload: { columns: result.columns, rows: result.rows, rowCount: result.rowCount, truncated: result.truncated, ms: result.ms, readOnly: true },
    };
  }

  private async promptTemplates(workspaceId: string, config: Record<string, unknown>) {
    const limit = clampLimit(config.limit, 10);
    const rows = await this.db.select().from(promptTemplates).where(eq(promptTemplates.workspaceId, workspaceId)).limit(limit * 2);
    const templateId = typeof config.templateId === 'string' && config.templateId ? config.templateId : null;
    const list = rows.filter((t) => !templateId || t.id === templateId).slice(0, limit);
    return {
      degraded: list.length === 0,
      payload: {
        total: rows.length,
        templates: list.map((t) => ({ id: t.id, name: t.name, tags: t.tags, variables: t.variables, version: t.version })),
      },
      ...(list.length === 0 ? { error: '还没有提示词模板：到「提示词工程」创建常用模板' } : {}),
    };
  }

  /** 组件的推荐刷新间隔（毫秒）。外部数据源更慢，本地数据更快。 */
  static recommendedInterval(type: WidgetKind): number {
    switch (type) {
      case 'task-progress':
      case 'agent-status':
        return 3000;
      case 'file-list':
      case 'prompt-template':
        return 15_000;
      case 'website-status':
      case 'schedule-status':
        return 10_000;
      case 'data-query':
        return 60_000;
      default:
        return 10_000;
    }
  }
}

function clampLimit(input: unknown, fallback: number): number {
  const n = Number(input ?? fallback);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), 200);
}

export { widgets };

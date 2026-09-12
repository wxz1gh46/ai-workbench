import { EventType, type ScheduleTask } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { eventBus } from '../events/bus.ts';
import { logger } from '../utils/logger.ts';
import { AppError } from '../utils/errors.ts';
import { PostgresAdapter } from '../database/postgresAdapter.ts';

/**
 * 任务执行器（Step 5）。
 *
 * 六种任务类型：
 *   goal      创建目标并自动推进（复用 Phase 2 GoalEngine）
 *   research  深度研究（复用 Phase 2 ResearchEngine）
 *   office    生成 Office 文档（复用 Phase 2 OfficeService）
 *   deploy    触发网站部署（复用 Phase 3 DeployService）
 *   db-query  执行只读 SQL 并返回结果
 *   custom    仅发通知 / 外部 Webhook
 *
 * 依赖注入：这里不直接 import 具体的 Service，而是接收一个 deps 对象，
 * 这样可以：1) 避免循环依赖；2) 单元测试时注入假实现；3) 未配置的能力显式降级。
 */
export interface JobRunnerDeps {
  runGoal?: (input: { workspaceId: string; objective: string; acceptanceCriteria?: string[]; maxIterations?: number }) => Promise<{ goalId: string; status: string; progress: number }>;
  runResearch?: (input: { workspaceId: string; topic: string; depth: string; allowNetwork: boolean }) => Promise<{ jobId: string; status: string }>;
  runOffice?: (input: { workspaceId: string; format: string; title: string; content: string }) => Promise<{ path: string; bytes: number }>;
  runDeploy?: (input: { workspaceId: string; websiteProjectId: string; provider: string }) => Promise<{ url: string; status: string }>;
  runQuery?: (input: { workspaceId: string; connectionId: string; sql: string; limit: number }) => Promise<{ columns: string[]; rows: Record<string, unknown>[]; rowCount: number }>;
}

export interface JobResult {
  ok: boolean;
  summary: string;
  data: Record<string, unknown>;
  degraded: boolean;
  /** 是否值得重试（网络类错误可重试，参数错误不应重试） */
  retryable: boolean;
}

export class JobRunner {
  constructor(
    private readonly db: Db,
    private readonly deps: JobRunnerDeps,
  ) {}

  async execute(task: ScheduleTask): Promise<JobResult> {
    const config = task.taskConfig ?? {};
    eventBus.publishBuffered(
      EventType.SCHEDULE_LOG,
      { scheduleId: task.id, level: 'info', msg: `开始执行 ${task.taskType} 任务` },
      { workspaceId: task.workspaceId },
    );

    try {
      switch (task.taskType) {
        case 'goal':
          return await this.runGoal(task, config);
        case 'research':
          return await this.runResearch(task, config);
        case 'office':
          return await this.runOffice(task, config);
        case 'deploy':
          return await this.runDeploy(task, config);
        case 'db-query':
          return await this.runDbQuery(task, config);
        case 'custom':
          return await this.runCustom(task, config);
        default:
          return { ok: false, summary: `未知任务类型: ${String(task.taskType)}`, data: {}, degraded: false, retryable: false };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retryable = isRetryable(e);
      logger.warn('job failed', { scheduleId: task.id, taskType: task.taskType, error: msg, retryable });
      return { ok: false, summary: msg, data: {}, degraded: false, retryable };
    }
  }

  private async runGoal(task: ScheduleTask, config: Record<string, unknown>): Promise<JobResult> {
    // 先校验参数：参数错误属于「用户配置问题」，应立即失败而不是进入重试循环
    const objective = String(config.objective ?? '').trim();
    if (!objective) return { ok: false, summary: '缺少 objective 参数', data: {}, degraded: false, retryable: false };
    if (!this.deps.runGoal) {
      return { ok: false, summary: '目标模式未启用（deps.runGoal 未注入）', data: {}, degraded: true, retryable: false };
    }
    const res = await this.deps.runGoal({
      workspaceId: task.workspaceId,
      objective,
      acceptanceCriteria: Array.isArray(config.acceptanceCriteria) ? (config.acceptanceCriteria as string[]) : undefined,
      maxIterations: typeof config.maxIterations === 'number' ? config.maxIterations : undefined,
    });
    return {
      ok: res.status === 'completed',
      summary: `目标 ${res.status}（进度 ${res.progress}%）`,
      data: { goalId: res.goalId, status: res.status, progress: res.progress },
      degraded: false,
      retryable: res.status === 'failed',
    };
  }

  private async runResearch(task: ScheduleTask, config: Record<string, unknown>): Promise<JobResult> {
    const topic = String(config.topic ?? '').trim();
    if (!topic) return { ok: false, summary: '缺少 topic 参数', data: {}, degraded: false, retryable: false };
    if (!this.deps.runResearch) {
      return { ok: false, summary: '深度研究未启用（deps.runResearch 未注入）', data: {}, degraded: true, retryable: false };
    }
    const res = await this.deps.runResearch({
      workspaceId: task.workspaceId,
      topic,
      depth: String(config.depth ?? 'standard'),
      allowNetwork: config.allowNetwork === true,
    });
    return { ok: true, summary: `研究任务已提交（${res.status}）`, data: { jobId: res.jobId, status: res.status }, degraded: false, retryable: false };
  }

  private async runOffice(task: ScheduleTask, config: Record<string, unknown>): Promise<JobResult> {
    const title = String(config.title ?? task.name);
    const content = String(config.content ?? '');
    if (!content.trim()) return { ok: false, summary: '缺少 content 参数', data: {}, degraded: false, retryable: false };
    if (!this.deps.runOffice) {
      return { ok: false, summary: 'Office 生成未启用（deps.runOffice 未注入）', data: {}, degraded: true, retryable: false };
    }
    const res = await this.deps.runOffice({
      workspaceId: task.workspaceId,
      format: String(config.format ?? 'docx'),
      title,
      content,
    });
    return { ok: true, summary: `已生成 ${res.path}（${res.bytes} 字节）`, data: { path: res.path, bytes: res.bytes }, degraded: false, retryable: false };
  }

  private async runDeploy(task: ScheduleTask, config: Record<string, unknown>): Promise<JobResult> {
    const websiteProjectId = String(config.websiteProjectId ?? '').trim();
    if (!websiteProjectId) return { ok: false, summary: '缺少 websiteProjectId 参数', data: {}, degraded: false, retryable: false };
    if (!this.deps.runDeploy) {
      return { ok: false, summary: '部署未启用（deps.runDeploy 未注入）', data: {}, degraded: true, retryable: false };
    }
    const res = await this.deps.runDeploy({
      workspaceId: task.workspaceId,
      websiteProjectId,
      provider: String(config.provider ?? 'vercel'),
    });
    return { ok: true, summary: `部署完成：${res.url || '（无 URL）'}`, data: { url: res.url, status: res.status }, degraded: !res.url, retryable: false };
  }

  private async runDbQuery(task: ScheduleTask, config: Record<string, unknown>): Promise<JobResult> {
    const sql = String(config.sql ?? '').trim();
    const connectionId = String(config.connectionId ?? '').trim();
    if (!sql) return { ok: false, summary: '缺少 sql 参数', data: {}, degraded: false, retryable: false };
    if (!connectionId) return { ok: false, summary: '缺少 connectionId 参数', data: {}, degraded: false, retryable: false };

    // 双重保险：任务里的 SQL 也走同一套静态安全校验，绝不允许定时任务写库
    const inspection = PostgresAdapter.inspect(sql);
    if (!inspection.safe) return { ok: false, summary: `SQL 被安全策略拒绝：${inspection.reason}`, data: {}, degraded: false, retryable: false };
    if (inspection.isWrite) {
      return { ok: false, summary: '定时任务只允许只读查询（写操作请手动执行并二次确认）', data: {}, degraded: false, retryable: false };
    }
    if (!this.deps.runQuery) {
      return { ok: false, summary: '数据库查询未启用（deps.runQuery 未注入）', data: {}, degraded: true, retryable: false };
    }
    const res = await this.deps.runQuery({
      workspaceId: task.workspaceId,
      connectionId,
      sql,
      limit: typeof config.limit === 'number' ? config.limit : 50,
    });
    return {
      ok: true,
      summary: `查询返回 ${res.rowCount} 行`,
      data: { rowCount: res.rowCount, columns: res.columns, sample: res.rows.slice(0, 5) },
      degraded: false,
      retryable: false,
    };
  }

  private async runCustom(task: ScheduleTask, config: Record<string, unknown>): Promise<JobResult> {
    // custom 不做实际业务：它的价值是「定时触发通知 / Webhook」，由 NotifyService 完成
    return {
      ok: true,
      summary: '自定义任务已触发（由通知渠道完成外部动作）',
      data: { payload: config.payload ?? {} },
      degraded: false,
      retryable: false,
    };
  }
}

/** 判断错误是否值得重试：网络/超时/5xx 可重试；参数与权限错误不重试 */
export function isRetryable(e: unknown): boolean {
  if (e instanceof AppError) {
    return e.status >= 500 || e.code === 'TIMEOUT' || e.code === 'PROVIDER_ERROR';
  }
  const msg = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
  if (/unauthor|forbidden|invalid|缺少|不合法|not found|syntax/.test(msg)) return false;
  return /timeout|econnreset|etimedout|network|fetch failed|429|502|503|504/.test(msg);
}

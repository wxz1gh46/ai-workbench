import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { retentionPolicies } from '../db/schema/index.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';

/**
 * 数据保留策略（Phase 4 Step 6）。
 *
 * 支持的 dataType（对应真实表）：
 *   audit_logs · schedule_runs · plugin_call_logs · research_reports ·
 *   office_documents · cost_records · deployment_logs · conversations
 *
 * 动作：delete（删除） / anonymize（匿名化保留统计价值） / archive（标记归档，不删）
 *
 * 安全设计（重要）：
 *   - 默认 **dryRun=true**：先算「会删多少」给用户看，确认后再真删。
 *     直接删历史数据不可逆，必须给用户一次反悔机会。
 *   - 不允许对 users / workspaces 设保留策略（删工作区等于删库）
 */

export const RETENTION_DATA_TYPES = [
  'audit_logs',
  'schedule_runs',
  'plugin_call_logs',
  'research_reports',
  'office_documents',
  'cost_records',
  'deployment_logs',
  'conversations',
] as const;

export type RetentionDataType = (typeof RETENTION_DATA_TYPES)[number];

/** 绝对禁止配置保留策略的表（删了会造成不可恢复的数据丢失） */
const FORBIDDEN_TYPES = ['users', 'workspaces', 'goals', 'tasks', 'agents'];

export interface ApplyInput {
  workspaceId: string;
  dataType?: RetentionDataType;
  dryRun?: boolean;
  now?: Date;
}

export interface ApplyResult {
  dataType: string;
  action: string;
  retentionDays: number;
  cutoff: string;
  scanned: number;
  affected: number;
  dryRun: boolean;
  detail: string;
}

export class RetentionService {
  constructor(private readonly db: Db) {}

  async list(workspaceId: string) {
    return (await this.db.select().from(retentionPolicies).where(eq(retentionPolicies.workspaceId, workspaceId))) as unknown as PolicyRow[];
  }

  async upsert(input: { workspaceId: string; dataType: string; retentionDays: number; action?: 'delete' | 'anonymize' | 'archive'; enabled?: boolean }) {
    if (FORBIDDEN_TYPES.includes(input.dataType)) {
      throw AppError.forbidden(`不允许为 ${input.dataType} 配置保留策略（会造成不可恢复的数据丢失）`);
    }
    if (!RETENTION_DATA_TYPES.includes(input.dataType as RetentionDataType)) {
      throw AppError.badRequest(`未知数据类型：${input.dataType}（可用：${RETENTION_DATA_TYPES.join(', ')}）`);
    }
    if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1 || input.retentionDays > 3650) {
      throw AppError.badRequest(`保留天数必须是 1~3650 的整数（收到 ${input.retentionDays}）`);
    }
    const action = input.action ?? 'delete';
    if (!['delete', 'anonymize', 'archive'].includes(action)) throw AppError.badRequest(`未知动作：${action}`);

    const existing = (await this.list(input.workspaceId)).find((p) => p.dataType === input.dataType);
    const now = nowIso();
    if (existing) {
      await this.db
        .update(retentionPolicies)
        .set({ retentionDays: input.retentionDays, action, enabled: input.enabled ?? existing.enabled, updatedAt: now } as never)
        .where(eq(retentionPolicies.id, existing.id));
      return this.list(input.workspaceId).then((l) => l.find((p) => p.dataType === input.dataType)!);
    }
    const row = {
      id: newId('rpol'),
      workspaceId: input.workspaceId,
      dataType: input.dataType,
      retentionDays: input.retentionDays,
      action,
      enabled: input.enabled ?? true,
      lastRunAt: null,
      lastAffected: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(retentionPolicies).values(row as never);
    return row as unknown as PolicyRow;
  }

  async remove(workspaceId: string, dataType: string) {
    const rows = (await this.list(workspaceId)) as unknown as PolicyRow[];
    const row = rows.find((r) => r.dataType === dataType);
    if (!row) throw AppError.notFound(`保留策略不存在：${dataType}`);
    await this.db.delete(retentionPolicies).where(eq(retentionPolicies.id, row.id));
    return { removed: dataType };
  }

  /**
   * 执行保留策略。
   * 通过注入的 executor 完成真实删除/匿名化 —— 保持本模块可测，
   * 且不把「SQL 拼接」散落在多个地方（executor 统一实现表名白名单映射）。
   */
  async apply(input: ApplyInput, executors: Partial<Record<RetentionDataType, (cutoffIso: string, action: string, dryRun: boolean) => Promise<{ scanned: number; affected: number }>>>): Promise<ApplyResult[]> {
    const policies = ((await this.list(input.workspaceId)) as unknown as PolicyRow[]).filter((p) => p.enabled && (!input.dataType || p.dataType === input.dataType));
    if (input.dataType && policies.length === 0) {
      throw AppError.notFound(`没有启用的保留策略：${input.dataType}`);
    }
    const now = input.now ?? new Date();
    const dryRun = input.dryRun === undefined ? true : input.dryRun;
    const results: ApplyResult[] = [];

    for (const policy of policies) {
      const cutoff = new Date(now.getTime() - policy.retentionDays * 24 * 60 * 60 * 1000).toISOString();
      const executor = executors[policy.dataType as RetentionDataType];
      if (!executor) {
        results.push({
          dataType: policy.dataType,
          action: policy.action,
          retentionDays: policy.retentionDays,
          cutoff,
          scanned: 0,
          affected: 0,
          dryRun,
          detail: '未实现该数据类型的执行器（已跳过，未做任何删除）',
        });
        continue;
      }
      const { scanned, affected } = await executor(cutoff, policy.action, dryRun);
      if (!dryRun) {
        await this.db
          .update(retentionPolicies)
          .set({ lastRunAt: nowIso(), lastAffected: affected, updatedAt: nowIso() } as never)
          .where(eq(retentionPolicies.id, policy.id));
      }
      logger.info('retention policy applied', { dataType: policy.dataType, action: policy.action, scanned, affected, dryRun });
      results.push({
        dataType: policy.dataType,
        action: policy.action,
        retentionDays: policy.retentionDays,
        cutoff,
        scanned,
        affected,
        dryRun,
        detail: dryRun ? `预演：将影响 ${affected} 条（未实际修改）` : `已${policy.action === 'delete' ? '删除' : policy.action === 'anonymize' ? '匿名化' : '归档'} ${affected} 条`,
      });
    }
    return results;
  }
}

export type PolicyRow = typeof retentionPolicies.$inferSelect;

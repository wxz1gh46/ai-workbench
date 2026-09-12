import { and, desc, eq, gte, lte } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { auditExports, auditLogs, roles, userRoles } from '../db/schema/index.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DataMaskService, type MaskRule, type MaskStrategy } from './dataMask.ts';

/**
 * 审计查询与合规导出（Phase 4 Step 6）。
 *
 * 与 Phase 3 的分域审计（auditors）的关系：
 *   - 分域审计（deploy_audits/db_audits/schedule_audits）记录各域上下文的完整明细
 *   - audit_logs 是全局总线（所有工具调用与用户操作），本服务处理它
 *
 * 导出的合规要求：
 *   - 导出前**强制脱敏**（detail 里可能有凭据/邮箱）
 *   - 导出必须留痕（audit_exports 表 + 再写一条 audit_logs），否则「谁导了什么」说不清
 *   - 导出文件落在 dataDir/exports，文件名不含用户输入（防路径穿越）
 */

export interface ListAuditQuery {
  workspaceId: string;
  from?: string;
  to?: string;
  action?: string;
  actor?: string;
  dangerousOnly?: boolean;
  limit?: number;
  offset?: number;
  /**
   * 允许突破常规查询的 1000 条上限（仅审计导出内部使用）。
   *
   * 真实缺陷：导出接口要求 10000 条，但 list 内部把 limit 夹到 1000，
   * 结果「导出成功」却只导出 1/10 的数据 —— 合规导出尤其不能出现这种静默截断。
   */
  allowLargeLimit?: boolean;
}

export class AuditQueryService {
  constructor(
    private readonly db: Db,
    private readonly masker: DataMaskService,
  ) {}

  async list(query: ListAuditQuery) {
    const conditions = [eq(auditLogs.workspaceId, query.workspaceId)];
    if (query.from) conditions.push(gte(auditLogs.createdAt, query.from));
    if (query.to) conditions.push(lte(auditLogs.createdAt, query.to));
    if (query.action) conditions.push(eq(auditLogs.action, query.action));
    if (query.actor) conditions.push(eq(auditLogs.actor, query.actor));

    const ceiling = query.allowLargeLimit ? 100_000 : 1000;
    const limit = Math.min(Math.max(query.limit ?? 100, 1), ceiling);
    const rows = (await this.db
      .select()
      .from(auditLogs)
      .where(and(...conditions))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit)) as unknown as AuditRow[];

    const filtered = query.dangerousOnly ? rows.filter((r) => r.dangerous) : rows;
    const rules = ((await this.masker.listRules(query.workspaceId)) as unknown as { field: string; strategy: string; target: string; enabled: boolean }[]).map((r) => ({
      field: r.field,
      strategy: r.strategy as MaskStrategy,
      target: r.target,
      enabled: r.enabled,
    })) as MaskRule[];
    const map = this.masker.buildStrategyMap(rules, 'audit_logs');
    // 必须用 maskDeep：审计 detail 是嵌套对象，只做浅层脱敏会让
    // detail.token / detail.nested.apiKey 这类字段原样泄露（真实风险）。
    return filtered.map((r) => this.masker.maskDeep(r, map) as AuditRow);
  }

  /** 统计：按 action 聚合，便于「审计概览」 */
  async stats(workspaceId: string, limit = 5000) {
    const rows = (await this.db.select().from(auditLogs).where(eq(auditLogs.workspaceId, workspaceId)).orderBy(desc(auditLogs.createdAt)).limit(limit)) as unknown as AuditRow[];
    const byAction = new Map<string, number>();
    const byActor = new Map<string, number>();
    let dangerous = 0;
    let unconfirmedDangerous = 0;
    for (const r of rows) {
      byAction.set(r.action, (byAction.get(r.action) ?? 0) + 1);
      byActor.set(r.actor, (byActor.get(r.actor) ?? 0) + 1);
      if (r.dangerous) dangerous += 1;
      if (r.dangerous && !r.confirmedByUser) unconfirmedDangerous += 1;
    }
    return {
      total: rows.length,
      dangerous,
      unconfirmedDangerous,
      byAction: [...byAction.entries()].map(([action, count]) => ({ action, count })).sort((a, b) => b.count - a.count),
      byActor: [...byActor.entries()].map(([actor, count]) => ({ actor, count })).sort((a, b) => b.count - a.count),
    };
  }

  /**
   * 导出为 NDJSON（每行一条 JSON）。
   * 选择 NDJSON 而不是 CSV：审计 detail 是嵌套结构，CSV 会丢层级或需要转义地狱。
   */
  async export(input: { workspaceId: string; from: string; to: string; type?: string; actor?: string; outputDir: string; limit?: number }): Promise<{
    exportId: string;
    filePath: string;
    rowCount: number;
    bytes: number;
  }> {
    if (!input.from || !input.to) throw AppError.badRequest('导出必须指定时间范围（from / to）');
    if (Date.parse(input.from) > Date.parse(input.to)) throw AppError.badRequest('开始时间不能晚于结束时间');

    const limit = Math.min(Math.max(input.limit ?? 10_000, 1), 100_000);
    const rows = await this.list({ workspaceId: input.workspaceId, from: input.from, to: input.to, ...(input.actor ? { actor: input.actor } : {}), limit, allowLargeLimit: true });

    const exportId = newId('aexp');
    const fileName = `${exportId}.ndjson`;
    const dir = path.join(input.outputDir, 'exports');
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, fileName);
    const body = rows.map((r) => JSON.stringify(r)).join('\n');
    await writeFile(filePath, body, 'utf8');

    const now = nowIso();
    await this.db.insert(auditExports).values({
      id: exportId,
      workspaceId: input.workspaceId,
      type: input.type ?? 'audit',
      rangeStart: input.from,
      rangeEnd: input.to,
      filePath,
      rowCount: rows.length,
      status: 'succeeded',
      error: null,
      createdAt: now,
    } as never);

    // 导出行为本身也要留痕
    await this.db.insert(auditLogs).values({
      id: newId('audit'),
      workspaceId: input.workspaceId,
      actor: input.actor ?? 'user',
      action: 'audit.export',
      targetType: 'audit_export',
      targetId: exportId,
      dangerous: false,
      confirmedByUser: true,
      detail: { from: input.from, to: input.to, rowCount: rows.length, bytes: Buffer.byteLength(body), masked: true } as never,
      createdAt: now,
    } as never);

    logger.info('audit exported', { workspaceId: input.workspaceId, exportId, rowCount: rows.length });
    return { exportId, filePath, rowCount: rows.length, bytes: Buffer.byteLength(body) };
  }

  async listExports(workspaceId: string) {
    return (await this.db.select().from(auditExports).where(eq(auditExports.workspaceId, workspaceId)).orderBy(desc(auditExports.createdAt))) as unknown as ExportRow[];
  }

  /** 审计日志的「当前脱敏视图」：让用户看到导出后的样子（避免导出后才发现被脱敏） */
  async previewMask(workspaceId: string, limit = 10) {
    const rows = await this.list({ workspaceId, limit });
    const rules = await this.masker.listRules(workspaceId);
    return { samples: rows, rules: rules.map((r) => ({ field: r.field, strategy: r.strategy as MaskStrategy, target: r.target })) };
  }
}

export type AuditRow = typeof auditLogs.$inferSelect;
export type ExportRow = typeof auditExports.$inferSelect;
export { roles, userRoles };

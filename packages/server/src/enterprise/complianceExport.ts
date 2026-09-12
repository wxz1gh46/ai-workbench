import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { auditExports } from '../db/schema/index.ts';
import { AppError } from '../utils/errors.ts';
import { AuditQueryService } from './auditLog.ts';

/**
 * 合规导出（Phase 4 Step 6）。
 *
 * 职责：把「导出」做成受控、可追溯、可下载的动作：
 *   - 只允许读取 exports 目录下的文件（路径由服务端生成，用户不能传路径 → 无穿越面）
 *   - 下载前再次校验归属（workspaceId 必须匹配）
 *   - 返回内容时带上 Content-Disposition，文件名由服务端生成
 *
 * 合规包（compliance package）额外包含：
 *   - 审计日志（脱敏）
 *   - 当前脱敏规则与保留策略（便于第三方核验「你确实按约定做了」）
 *   - 工作区摘要（不含任何凭据）
 */

export interface CompliancePackage {
  workspaceId: string;
  generatedAt: string;
  audit: Record<string, unknown>[];
  maskRules: { field: string; strategy: string; target: string }[];
  retentionPolicies: { dataType: string; retentionDays: number; action: string; enabled: boolean }[];
  summary: { auditCount: number; dangerousCount: number; unconfirmedDangerous: number };
}

export class ComplianceExportService {
  constructor(
    private readonly db: Db,
    private readonly auditQuery: AuditQueryService,
    private readonly outputDir: string,
  ) {}

  /** 生成合规包（内存对象；调用方决定落盘或直接返回） */
  async buildPackage(input: { workspaceId: string; from: string; to: string; maskRules: { field: string; strategy: string; target: string }[]; retentionPolicies: { dataType: string; retentionDays: number; action: string; enabled: boolean }[] }): Promise<CompliancePackage> {
    const [rows, stats] = await Promise.all([this.auditQuery.list({ workspaceId: input.workspaceId, from: input.from, to: input.to, limit: 100_000 }), this.auditQuery.stats(input.workspaceId)]);
    return {
      workspaceId: input.workspaceId,
      generatedAt: new Date().toISOString(),
      audit: rows as unknown as Record<string, unknown>[],
      maskRules: input.maskRules,
      retentionPolicies: input.retentionPolicies,
      summary: { auditCount: rows.length, dangerousCount: stats.dangerous, unconfirmedDangerous: stats.unconfirmedDangerous },
    };
  }

  /** 导出审计为 NDJSON 并登记 audit_exports */
  async exportAudit(input: { workspaceId: string; from: string; to: string; actor?: string }) {
    return this.auditQuery.export({ workspaceId: input.workspaceId, from: input.from, to: input.to, ...(input.actor ? { actor: input.actor } : {}), outputDir: this.outputDir });
  }

  /**
   * 读取导出文件（下载用）。
   * 安全检查：文件路径必须落在 outputDir/exports 内且工作区匹配 ——
   * 双重校验，防止通过构造 id 越权读别的导出。
   */
  async readExport(workspaceId: string, exportId: string): Promise<{ content: Buffer; fileName: string; rowCount: number }> {
    const rows = (await this.db.select().from(auditExports).where(eq(auditExports.id, exportId)).limit(1)) as unknown as ExportRowRaw[];
    const row = rows[0];
    if (!row || row.workspaceId !== workspaceId) throw AppError.notFound(`导出记录不存在: ${exportId}`);

    const exportsDir = path.resolve(this.outputDir, 'exports');
    const resolved = path.resolve(row.filePath);
    if (!resolved.startsWith(exportsDir + path.sep)) {
      throw AppError.forbidden('导出文件路径越界，已拒绝读取');
    }
    const buf = await readFile(resolved).catch(() => null);
    if (!buf) throw AppError.notFound('导出文件已不存在（可能被清理），请重新导出');
    return { content: buf, fileName: path.basename(resolved), rowCount: row.rowCount };
  }

  async listExports(workspaceId: string) {
    return this.auditQuery.listExports(workspaceId);
  }
}

type ExportRowRaw = typeof auditExports.$inferSelect;

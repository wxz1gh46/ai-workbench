import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { DbAdapter } from './adapter.ts';
import { AppError } from '../utils/errors.ts';

/**
 * 备份与恢复入口（Step 2）。
 *
 * 能力边界（必须说清楚，避免用户误以为有 PITR）：
 *   - 这是「逻辑备份」：导出结构 + 每表前 N 行样本，适合小库与结构留档；
 *   - 完整数据备份请用 pg_dump（工作台不下载/不转存你的全量数据）；
 *   - 恢复是「把备份 SQL 交给用户执行」，工作台不自动覆盖线上库（危险动作）。
 *
 * 备份文件落工作区（storage 目录），并计算 sha256 便于校验完整性。
 */

export interface BackupArtifact {
  id: string;
  connectionId: string;
  createdAt: string;
  format: 'sql' | 'sql.gz';
  bytes: number;
  tables: number;
  sha256: string;
  /** 备份内容（未压缩的 SQL 文本，供 UI 预览前 2000 字符） */
  preview: string;
  content: string;
}

export class BackupService {
  constructor(private readonly connectionId: string) {}

  async create(adapter: DbAdapter, opts: { compress?: boolean } = {}): Promise<BackupArtifact> {
    const dump = await adapter.backup();
    const content = dump.content;
    const sha256 = createHash('sha256').update(content).digest('hex');
    const finalContent = opts.compress ? gzipSync(Buffer.from(content, 'utf8')).toString('base64') : content;
    return {
      id: `bak_${Date.now().toString(36)}`,
      connectionId: this.connectionId,
      createdAt: new Date().toISOString(),
      format: opts.compress ? 'sql.gz' : 'sql',
      bytes: Buffer.byteLength(content),
      tables: dump.tables,
      sha256,
      preview: content.slice(0, 2000),
      content: finalContent,
    };
  }

  /** 校验备份完整性（恢复前必须先过这一步） */
  static verify(artifact: BackupArtifact): { ok: boolean; message: string } {
    const raw = artifact.format === 'sql.gz' ? gunzipSync(Buffer.from(artifact.content, 'base64')).toString('utf8') : artifact.content;
    const actual = createHash('sha256').update(raw).digest('hex');
    if (actual !== artifact.sha256) return { ok: false, message: '备份文件校验失败：sha256 不匹配（文件可能被修改）' };
    return { ok: true, message: `校验通过（${artifact.tables} 张表，${artifact.bytes} 字节）` };
  }

  /** 恢复：只生成可执行 SQL，不自动执行（危险动作由用户确认后走迁移通道） */
  static planRestore(artifact: BackupArtifact): { sql: string; steps: string[]; requiresConfirm: true } {
    const verified = BackupService.verify(artifact);
    if (!verified.ok) throw AppError.badRequest(verified.message);
    const raw = artifact.format === 'sql.gz' ? gunzipSync(Buffer.from(artifact.content, 'base64')).toString('utf8') : artifact.content;
    return {
      sql: raw,
      steps: [
        '1. 确认目标数据库正确（备份内容会覆盖同名表结构，但不删除多余表）',
        '2. 建议先对目标库做一次备份',
        '3. 在「查询控制台」关闭只读模式并确认执行（会写入 db_audits 审计）',
        '4. 大库请改用 pg_restore 以获得并行与断点续传能力',
      ],
      requiresConfirm: true,
    };
  }
}

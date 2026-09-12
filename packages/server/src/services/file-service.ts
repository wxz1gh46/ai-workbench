import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import type { FileRecord, FileVersion } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { fileVersions, files } from '../db/schema/index.ts';
import { config } from '../config.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';

const MIME_BY_EXT: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
};

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function mimeOf(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/**
 * 文件服务。
 * - DB 记录元数据与版本；二进制存放在 STORAGE_DIR（Phase 1 用本地磁盘）
 * - 同一路径重复上传自动递增 version，保留历史 → 支持版本回滚
 * - 大文件流式处理在 Phase 2 通过 ReadableStream 上传接口补齐
 */
export class FileService {
  constructor(private readonly db: Db) {}

  async upload(input: { workspaceId: string; name: string; contentBase64: string; mime?: string }): Promise<{ file: FileRecord; storagePath: string }> {
    const buf = Buffer.from(input.contentBase64, 'base64');
    if (buf.length === 0) throw AppError.badRequest('文件内容为空');
    const MAX = 50 * 1024 * 1024;
    if (buf.length > MAX) throw AppError.badRequest(`文件过大（${buf.length} 字节），Phase 1 上限 50MB`);

    const existing = await this.db
      .select()
      .from(files)
      .where(and(eq(files.workspaceId, input.workspaceId), eq(files.path, input.name)))
      .limit(1);
    const prev = existing[0] as FileRecord | undefined;
    const version = prev ? prev.version + 1 : 1;
    const now = nowIso();
    const fileId = prev?.id ?? newId('file');
    const ext = path.extname(input.name).slice(1).toLowerCase();
    const storageRel = path.join(input.workspaceId, fileId, `v${version}_${path.basename(input.name)}`);
    const storageAbs = path.join(config.storageDir, storageRel);
    await mkdir(path.dirname(storageAbs), { recursive: true });
    await writeFile(storageAbs, buf);

    if (prev) {
      await this.db
        .update(files)
        .set({ version, size: buf.length, sha256: sha256(buf), mime: input.mime ?? mimeOf(input.name), updatedAt: now })
        .where(eq(files.id, fileId));
    } else {
      await this.db.insert(files).values({
        id: fileId,
        workspaceId: input.workspaceId,
        path: input.name,
        name: path.basename(input.name),
        ext,
        mime: input.mime ?? mimeOf(input.name),
        size: buf.length,
        version: 1,
        sha256: sha256(buf),
        createdAt: now,
        updatedAt: now,
      });
    }
    await this.db.insert(fileVersions).values({
      id: newId('fver'),
      fileId,
      version,
      storagePath: storageRel,
      size: buf.length,
      sha256: sha256(buf),
      note: prev ? '重新上传' : '首次上传',
      createdAt: now,
    });

    const record = (await this.db.select().from(files).where(eq(files.id, fileId)).limit(1))[0] as FileRecord;
    return { file: record, storagePath: storageAbs };
  }

  async list(workspaceId: string): Promise<FileRecord[]> {
    return (await this.db.select().from(files).where(eq(files.workspaceId, workspaceId))) as FileRecord[];
  }

  async listVersions(fileId: string): Promise<FileVersion[]> {
    return (await this.db
      .select()
      .from(fileVersions)
      .where(eq(fileVersions.fileId, fileId))
      .orderBy(desc(fileVersions.version))) as FileVersion[];
  }

  async readVersionText(fileId: string, version?: number): Promise<{ content: string; version: number }> {
    const versions = await this.listVersions(fileId);
    const target = version ? versions.find((v) => v.version === version) : versions[0];
    if (!target) throw AppError.notFound(`文件版本不存在: ${fileId}@${version ?? 'latest'}`);
    const abs = path.join(config.storageDir, target.storagePath);
    try {
      const buf = await readFile(abs);
      return { content: buf.toString('utf8'), version: target.version };
    } catch {
      throw AppError.notFound(`文件内容缺失（可能已被清理）: ${target.storagePath}`);
    }
  }
}

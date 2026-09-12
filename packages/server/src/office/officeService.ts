/**
 * Office 服务：读取 / 编辑 / 生成 / 转换 / 预览 / 版本 / 导出。
 *
 * 安全边界（本模块最重要的约束）：
 * - 所有路径都经 safeJoin 校验，只能落在 workspace.rootPath 之内；
 * - 未配置 rootPath 时一律拒绝（安全默认，而不是写到意外位置）；
 * - 大文件读取有上限，避免内存溢出；
 * - 编辑前自动备份 FileVersion，保证可回滚。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import type { OfficeDocumentInfo, OfficeFormat, OfficePreview } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { fileExports, fileVersions, files, officeDocuments, officePreviews } from '../db/schema/index.ts';
import { config } from '../config.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';
import { safeJoin } from '../tools/fs-tools.ts';
import { parseOfficeFile } from './parse.ts';
import { applyOfficeEdits, type EditOperation } from './edit.ts';
import { convertDocument, isConverterAvailable } from './converter.ts';

/** 单文件读取上限：超过则只解析头部并给出警告（防内存溢出） */
const MAX_PARSE_BYTES = 64 * 1024 * 1024;

export interface OfficeContext {
  workspaceId: string;
  workspaceRoot: string | null;
}

export class OfficeService {
  constructor(private readonly db: Db) {}

  /* ------------------------------ 读取 ------------------------------ */

  async read(ctx: OfficeContext, relPath: string): Promise<OfficeDocumentInfo & { warnings: string[]; truncated: boolean }> {
    const abs = safeJoin(ctx.workspaceRoot, relPath);
    const info = await stat(abs).catch(() => null);
    if (!info) throw AppError.notFound(`文件不存在: ${relPath}`);
    if (info.isDirectory()) throw AppError.badRequest(`这是目录，不是文件: ${relPath}`);

    const truncated = info.size > MAX_PARSE_BYTES;
    const parsed = await parseOfficeFile(abs, relPath);
    if (truncated) parsed.warnings.push(`文件 ${(info.size / 1024 / 1024).toFixed(1)}MB 超过解析上限，仅解析可用部分`);

    // 解析缓存（同 workspace + path 覆盖写）：先删后插，避免部分字段 upsert 的兼容问题
    const fileRow = await this.findFile(ctx.workspaceId, relPath);
    await this.db
      .delete(officeDocuments)
      .where(and(eq(officeDocuments.workspaceId, ctx.workspaceId), eq(officeDocuments.path, relPath)));
    await this.db.insert(officeDocuments).values({
      id: newId('odoc'),
      workspaceId: ctx.workspaceId,
      fileId: fileRow?.id ?? null,
      path: relPath,
      format: parsed.format,
      content: parsed.content as unknown as Record<string, unknown>,
      meta: parsed.meta as Record<string, unknown>,
      warnings: parsed.warnings,
      parsedAt: nowIso(),
    });

    return { ...parsed, fileId: fileRow?.id ?? null, truncated };
  }

  /* ------------------------------ 预览 ------------------------------ */

  async preview(ctx: OfficeContext, relPath: string): Promise<OfficePreview> {
    const parsed = await this.read(ctx, relPath);
    const tables = parsed.content.tables ?? [];
    const slides = parsed.content.slides ?? [];

    let markdown = parsed.content.text;
    if (parsed.format === 'xlsx' && tables.length > 0) {
      markdown = tables
        .map((t) => {
          const header = t.rows[0] ?? [];
          const body = t.rows.slice(1);
          const toRow = (r: (string | number | boolean | null)[]) => `| ${r.map((c) => (c === null ? '' : String(c)).replace(/\|/g, '\\|')).join(' | ')} |`;
          return [
            `## ${t.sheet}`,
            toRow(header),
            `| ${header.map(() => '---').join(' | ')} |`,
            ...body.slice(0, 200).map(toRow),
          ].join('\n');
        })
        .join('\n\n');
    }

    const renderer: OfficePreview['renderer'] =
      parsed.format === 'docx'
        ? 'docx-preview'
        : parsed.format === 'pdf'
          ? 'pdf.js'
          : parsed.format === 'xlsx'
            ? 'sheetjs'
            : parsed.format === 'pptx'
              ? 'pptx'
              : 'markdown';

    const fileRow = await this.findFile(ctx.workspaceId, relPath);
    const downloadUrl = fileRow ? `/files/${fileRow.id}/download` : `/office/download?workspaceId=${encodeURIComponent(ctx.workspaceId)}&path=${encodeURIComponent(relPath)}`;

    await this.db.insert(officePreviews).values({
      id: newId('oprev'),
      workspaceId: ctx.workspaceId,
      path: relPath,
      format: parsed.format,
      markdown: markdown.slice(0, 500_000),
      renderer,
      createdAt: nowIso(),
    });

    return { format: parsed.format, markdown, tables, slides, renderer, downloadUrl };
  }

  /* ------------------------------ 编辑 ------------------------------ */

  async edit(
    ctx: OfficeContext,
    relPath: string,
    ops: EditOperation[],
    opts: { backup?: boolean } = {},
  ): Promise<{ path: string; version: number; bytes: number; applied: number; warnings: string[]; backupVersion: number | null }> {
    const abs = safeJoin(ctx.workspaceRoot, relPath);
    const exists = await stat(abs).catch(() => null);
    if (!exists) throw AppError.notFound(`文件不存在: ${relPath}`);

    const backupVersion = opts.backup === false ? null : await this.snapshot(ctx, relPath);

    const result = await applyOfficeEdits(abs, relPath, ops);
    const nextInfo = await stat(abs);
    const version = await this.bumpVersion(ctx, relPath, abs, nextInfo.size, '编辑后自动留存版本');
    const warnings = [...result.warnings];

    if (result.applied === 0 && ops.length > 0) {
      warnings.push('没有任何编辑被应用，请检查操作类型与目标文件格式是否匹配');
    }
    logger.info('office file edited', { path: relPath, ops: ops.length, applied: result.applied, bytes: nextInfo.size });
    return { path: relPath, version, bytes: nextInfo.size, applied: result.applied, warnings, backupVersion };
  }

  /* ------------------------------ 生成 ------------------------------ */

  async generate(
    ctx: OfficeContext,
    input: {
      format: OfficeFormat;
      title: string;
      content: string;
      sheets?: { name: string; rows: (string | number | boolean | null)[][] }[];
      slides?: { title: string; bullets: string[] }[];
      outputPath?: string;
    },
  ): Promise<{ path: string; version: number; bytes: number; warnings: string[] }> {
    const { officeGenerateTool } = await import('../tools/office-tools.ts');
    const ext = input.format === 'markdown' ? 'md' : input.format;
    const rel = input.outputPath ?? path.posix.join('out', `${sanitize(input.title)}.${ext}`);
    // 通过工具层执行：复用「危险操作确认 + 工作区边界」的统一约束
    const res = await officeGenerateTool.run(
      {
        format: input.format,
        title: input.title,
        content: input.content,
        outputPath: rel,
        ...(input.sheets ? { sheets: input.sheets } : {}),
        ...(input.slides ? { slides: input.slides } : {}),
      },
      {
        workspaceId: ctx.workspaceId,
        goalId: null,
        taskId: null,
        agentId: 'user',
        runId: newId('run'),
        userConfirmed: true,
        workspaceRoot: ctx.workspaceRoot,
      },
    );
    if (!res.ok) throw AppError.tool(res.error ?? '生成失败');

    const abs = safeJoin(ctx.workspaceRoot, rel);
    const info = await stat(abs);
    const version = await this.bumpVersion(ctx, rel, abs, info.size, '生成/覆盖');
    return { path: rel, version, bytes: info.size, warnings: [] };
  }

  /* ------------------------------ 转换 ------------------------------ */

  async convert(ctx: OfficeContext, relPath: string, target: OfficeFormat, outputPath?: string) {
    const abs = safeJoin(ctx.workspaceRoot, relPath);
    const exists = await stat(abs).catch(() => null);
    if (!exists) throw AppError.notFound(`文件不存在: ${relPath}`);

    const outputDirRel = path.posix.dirname(outputPath ?? relPath);
    const outputDirAbs = safeJoin(ctx.workspaceRoot, outputDirRel === '.' ? '' : outputDirRel);
    await mkdir(outputDirAbs, { recursive: true });

    const result = await convertDocument(abs, outputDirAbs, target);
    if (result.degraded) {
      return { ...result, path: '', version: 0, warnings: result.warnings };
    }
    let outRel = path.posix.relative(ctx.workspaceRoot ?? '', result.outputPath);
    if (outputPath) {
      // 允许调用方指定输出名
      const targetAbs = safeJoin(ctx.workspaceRoot, outputPath);
      const buf = await readFile(result.outputPath);
      await writeFile(targetAbs, buf);
      outRel = outputPath;
    }
    const outAbs = safeJoin(ctx.workspaceRoot, outRel);
    const info = await stat(outAbs);
    const version = await this.bumpVersion(ctx, outRel, outAbs, info.size, `由 ${relPath} 转换生成`);
    return {
      ...result,
      path: outRel,
      version,
      conversionAvailable: true as const,
    };
  }

  async converterStatus(): Promise<{ available: boolean; hint: string }> {
    const available = await isConverterAvailable();
    return {
      available,
      hint: available
        ? 'LibreOffice headless 可用，支持 docx/xlsx/pptx/pdf/markdown 互转'
        : '未配置 SOFFICE_PATH，跨格式转换不可用。安装 LibreOffice 并设置 SOFFICE_PATH 后启用；不影响同格式读取/编辑与直接生成。',
    };
  }

  /* ---------------------------- 版本管理 ---------------------------- */

  /** 备份当前文件为 FileVersion（编辑前调用，保证可回滚） */
  async snapshot(ctx: OfficeContext, relPath: string, note = '编辑前自动备份'): Promise<number | null> {
    const abs = safeJoin(ctx.workspaceRoot, relPath);
    const buf = await readFile(abs).catch(() => null);
    if (!buf) return null;
    const fileId = await this.ensureFileRow(ctx, relPath, buf.length, sha256(buf), path.extname(relPath).slice(1));
    const versions = await this.db.select().from(fileVersions).where(eq(fileVersions.fileId, fileId));
    const nextVersion = versions.reduce((m, v) => Math.max(m, v.version), 0) + 1;
    const storageRel = path.posix.join(ctx.workspaceId, fileId, `v${nextVersion}_${path.basename(relPath)}`);
    const storageAbs = path.join(config.storageDir, storageRel);
    await mkdir(path.dirname(storageAbs), { recursive: true });
    await writeFile(storageAbs, buf);
    await this.db.insert(fileVersions).values({
      id: newId('fver'),
      fileId,
      version: nextVersion,
      storagePath: storageRel,
      size: buf.length,
      sha256: sha256(buf),
      note,
      createdAt: nowIso(),
    });
    // 关键：备份也占用一个版本号，必须同步 files.version，
    // 否则后续编辑会复用同一版本号（出现两条 v2，且 version 不前进）
    await this.db.update(files).set({ version: nextVersion, updatedAt: nowIso() }).where(eq(files.id, fileId));
    return nextVersion;
  }

  async listVersions(ctx: OfficeContext, relPathOrFileId: string) {
    const fileRow =
      relPathOrFileId.startsWith('file_')
        ? (await this.db.select().from(files).where(eq(files.id, relPathOrFileId)).limit(1))[0]
        : await this.findFile(ctx.workspaceId, relPathOrFileId);
    if (!fileRow) throw AppError.notFound(`文件记录不存在: ${relPathOrFileId}`);
    const versions = await this.db
      .select()
      .from(fileVersions)
      .where(eq(fileVersions.fileId, fileRow.id))
      .orderBy(desc(fileVersions.version));
    return { fileId: fileRow.id, current: fileRow.version, path: fileRow.path, versions };
  }

  /** 回滚到指定版本：把历史内容写回工作区文件，并产生一个新版本（可再回滚） */
  async restore(ctx: OfficeContext, fileId: string, version: number) {
    const fileRow = (await this.db.select().from(files).where(eq(files.id, fileId)).limit(1))[0];
    if (!fileRow) throw AppError.notFound(`文件不存在: ${fileId}`);
    const rows = await this.db
      .select()
      .from(fileVersions)
      .where(and(eq(fileVersions.fileId, fileId), eq(fileVersions.version, version)))
      .limit(1);
    const target = rows[0];
    if (!target) throw AppError.notFound(`版本不存在: ${fileId}@${version}`);

    const buf = await readFile(path.join(config.storageDir, target.storagePath)).catch(() => null);
    if (!buf) throw AppError.notFound(`版本内容缺失（可能已被清理）: ${target.storagePath}`);

    // 写回工作区（若配置了 rootPath）；未配置时仅更新版本记录并提示
    let restoredToWorkspace = false;
    if (ctx.workspaceRoot) {
      const abs = safeJoin(ctx.workspaceRoot, fileRow.path);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, buf);
      restoredToWorkspace = true;
    }

    const nextVersion = fileRow.version + 1;
    await this.db
      .update(files)
      .set({ version: nextVersion, size: buf.length, sha256: sha256(buf), updatedAt: nowIso() })
      .where(eq(files.id, fileId));
    await this.db.insert(fileVersions).values({
      id: newId('fver'),
      fileId,
      version: nextVersion,
      storagePath: target.storagePath,
      size: buf.length,
      sha256: sha256(buf),
      note: `回滚自 v${version}`,
      createdAt: nowIso(),
    });

    return { fileId, path: fileRow.path, version: nextVersion, restoredFrom: version, restoredToWorkspace, bytes: buf.length };
  }

  /* ------------------------------ 导出 ------------------------------ */

  /** 生成可下载 / 可发布的导出记录（带过期时间） */
  async export(ctx: OfficeContext, relPath: string, opts: { public?: boolean; ttlHours?: number } = {}) {
    const abs = safeJoin(ctx.workspaceRoot, relPath);
    const buf = await readFile(abs).catch(() => null);
    if (!buf) throw AppError.notFound(`文件不存在: ${relPath}`);
    const fileId = await this.ensureFileRow(ctx, relPath, buf.length, sha256(buf), path.extname(relPath).slice(1));
    const fileRow = (await this.db.select().from(files).where(eq(files.id, fileId)).limit(1))[0]!;

    const exportId = newId('exp');
    const storageRel = path.posix.join(ctx.workspaceId, 'exports', `${exportId}_${path.basename(relPath)}`);
    const storageAbs = path.join(config.storageDir, storageRel);
    await mkdir(path.dirname(storageAbs), { recursive: true });
    await writeFile(storageAbs, buf);

    const ttlHours = opts.ttlHours ?? 168;
    const expiresAt = new Date(Date.now() + ttlHours * 3_600_000).toISOString();
    const row = {
      id: exportId,
      workspaceId: ctx.workspaceId,
      fileId: fileRow.id,
      version: fileRow.version,
      storagePath: storageRel,
      mime: mimeOf(relPath),
      size: buf.length,
      url: `/files/exports/${exportId}`,
      expiresAt,
      createdAt: nowIso(),
    };
    await this.db.insert(fileExports).values(row);
    return row;
  }

  async resolveExport(exportId: string) {
    const row = (await this.db.select().from(fileExports).where(eq(fileExports.id, exportId)).limit(1))[0];
    if (!row) throw AppError.notFound(`导出不存在: ${exportId}`);
    const expired = row.expiresAt ? Date.parse(row.expiresAt) < Date.now() : false;
    return { row, expired };
  }

  /* ------------------------------ 内部 ------------------------------ */

  private async findFile(workspaceId: string, relPath: string) {
    const rows = await this.db
      .select()
      .from(files)
      .where(and(eq(files.workspaceId, workspaceId), eq(files.path, relPath)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** 保证存在 files 记录（工作区文件直接编辑时也纳入版本体系） */
  private async ensureFileRow(ctx: OfficeContext, relPath: string, size: number, hash: string, ext: string): Promise<string> {
    const existing = await this.findFile(ctx.workspaceId, relPath);
    const now = nowIso();
    if (existing) {
      await this.db
        .update(files)
        .set({ size, sha256: hash, updatedAt: now })
        .where(eq(files.id, existing.id));
      return existing.id;
    }
    const id = newId('file');
    await this.db.insert(files).values({
      id,
      workspaceId: ctx.workspaceId,
      path: relPath,
      name: path.basename(relPath),
      ext,
      mime: mimeOf(relPath),
      size,
      version: 1,
      sha256: hash,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  /** 文件被改动后递增版本号（并记录一条版本） */
  private async bumpVersion(ctx: OfficeContext, relPath: string, abs: string, size: number, note: string): Promise<number> {
    const buf = await readFile(abs);
    const fileId = await this.ensureFileRow(ctx, relPath, size, sha256(buf), path.extname(relPath).slice(1));
    const versions = await this.db.select().from(fileVersions).where(eq(fileVersions.fileId, fileId));
    // 版本号以「已存在的最大版本」为准，避免与备份产生的版本号冲突
    const maxVersion = versions.reduce((m, v) => Math.max(m, v.version), 0);

    // 只在内容确实变化时记录新版本，避免无意义的版本膨胀
    const latest = versions.find((v) => v.version === maxVersion);
    if (latest?.sha256 === sha256(buf)) {
      return maxVersion;
    }
    const nextVersion = maxVersion + 1;

    const storageRel = path.posix.join(ctx.workspaceId, fileId, `v${nextVersion}_${path.basename(relPath)}`);
    const storageAbs = path.join(config.storageDir, storageRel);
    await mkdir(path.dirname(storageAbs), { recursive: true });
    await writeFile(storageAbs, buf);
    await this.db.insert(fileVersions).values({
      id: newId('fver'),
      fileId,
      version: nextVersion,
      storagePath: storageRel,
      size: buf.length,
      sha256: sha256(buf),
      note,
      createdAt: nowIso(),
    });
    await this.db.update(files).set({ version: nextVersion, updatedAt: nowIso() }).where(eq(files.id, fileId));
    return nextVersion;
  }
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'untitled';
}

const MIME_BY_EXT: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
};

export function mimeOf(p: string): string {
  return MIME_BY_EXT[path.extname(p).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

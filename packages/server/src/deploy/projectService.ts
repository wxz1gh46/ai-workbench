import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { WebsiteProject } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { websiteBuilds, websiteProjects } from '../db/schema/index.ts';
import { eq } from 'drizzle-orm';
import { AppError } from '../utils/errors.ts';
import { safeJoin } from '../tools/fs-tools.ts';
import { nowIso, newId } from '../utils/ids.ts';
import { workspaceRoot } from '../services/workspace.ts';
import { logger } from '../utils/logger.ts';
import { scanForSecrets } from './websiteGenerator.ts';

/**
 * 网站项目辅助服务（Step 1/3 之间的小工具）。
 *
 * 与 DeployService 的分工：
 *   - DeployService 负责「生成 → 部署 → 回滚」的主链路；
 *   - ProjectService 负责项目本身的更新与产物读取（读磁盘、扫描大文件、统计体积）。
 * 拆开是为了让 app.ts 的路由更薄，同时避免 DeployService 变成上帝类。
 */
export class WebsiteProjectService {
  constructor(private readonly db: Db) {}

  async update(id: string, patch: { name?: string; description?: string }): Promise<WebsiteProject> {
    const rows = await this.db.select().from(websiteProjects).where(eq(websiteProjects.id, id)).limit(1);
    const row = rows[0];
    if (!row || row.status === 'deleted') throw AppError.notFound(`网站项目不存在: ${id}`);
    const name = patch.name?.trim();
    if (patch.name !== undefined && (!name || name.length > 120)) throw AppError.badRequest('项目名称不合法（1-120 字符）');
    await this.db
      .update(websiteProjects)
      .set({
        name: name ?? row.name,
        description: patch.description ?? row.description,
        updatedAt: nowIso(),
      })
      .where(eq(websiteProjects.id, id));
    const fresh = await this.db.select().from(websiteProjects).where(eq(websiteProjects.id, id)).limit(1);
    return fresh[0] as unknown as WebsiteProject;
  }

  /** 读取最近一次构建记录（版本、文件清单、日志） */
  async lastBuild(projectId: string) {
    const rows = await this.db.select().from(websiteBuilds).where(eq(websiteBuilds.websiteProjectId, projectId));
    if (rows.length === 0) return null;
    return rows.sort((a, b) => b.version - a.version)[0];
  }

  /** 从磁盘列出生成产物（供 UI 文件树） */
  async listGenerated(project: WebsiteProject, limit = 500): Promise<{ path: string; bytes: number }[]> {
    const root = await workspaceRoot(this.db, project.workspaceId);
    if (!root || !project.rootDir) return [];
    const absRoot = safeJoin(root, project.rootDir);
    const out: { path: string; bytes: number }[] = [];
    const skip = new Set(['node_modules', '.git', 'dist', '.next']);
    async function walk(dir: string, rel: string): Promise<void> {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= limit) return;
        if (skip.has(e)) continue;
        const abs = path.join(dir, e);
        const relPath = rel ? `${rel}/${e}` : e;
        const info = await stat(abs).catch(() => null);
        if (!info) continue;
        if (info.isDirectory()) await walk(abs, relPath);
        else out.push({ path: relPath, bytes: info.size });
      }
    }
    await walk(absRoot, '');
    return out;
  }

  /**
   * 构建校验（Step 1 的「build」动作）。
   * 桌面端不做真实打包（避免下载几百 MB 依赖），这里做的是「可部署性检查」：
   *   1. 入口文件存在；
   *   2. 无残留密钥；
   *   3. 体积与文件数在合理范围。
   * 结果写入 website_builds，便于部署时引用。
   */
  async build(project: WebsiteProject): Promise<{
    ok: boolean;
    version: number;
    checks: { name: string; ok: boolean; detail: string }[];
    files: number;
    bytes: number;
  }> {
    const root = await workspaceRoot(this.db, project.workspaceId);
    if (!root || !project.rootDir) throw AppError.badRequest('项目尚未生成到工作区，请先执行「生成」');
    const absRoot = safeJoin(root, project.rootDir);
    const checks: { name: string; ok: boolean; detail: string }[] = [];

    const entry = project.entryFile ?? 'index.html';
    const entryExists = await stat(path.join(absRoot, entry)).then(() => true).catch(() => false);
    const altEntry = await stat(path.join(absRoot, 'public', 'index.html')).then(() => true).catch(() => false);
    checks.push({
      name: '入口文件',
      ok: entryExists || altEntry,
      detail: entryExists ? `找到 ${entry}` : altEntry ? '找到 public/index.html' : `缺少 ${entry}`,
    });

    const files = await this.listGenerated(project, 2000);
    const bytes = files.reduce((s, f) => s + f.bytes, 0);
    checks.push({ name: '文件数量', ok: files.length > 0 && files.length < 1000, detail: `${files.length} 个文件` });
    checks.push({ name: '产物体积', ok: bytes < 50 * 1024 * 1024, detail: `${(bytes / 1024).toFixed(1)} KB` });

    // 密钥扫描：防止把凭据打进前端产物
    const leaked: string[] = [];
    for (const f of files.filter((x) => x.bytes < 512 * 1024).slice(0, 200)) {
      const content = await readFile(path.join(absRoot, f.path), 'utf8').catch(() => '');
      const hits = scanForSecrets(content);
      if (hits.length > 0) leaked.push(`${f.path}:${hits.join(',')}`);
    }
    checks.push({ name: '密钥扫描', ok: leaked.length === 0, detail: leaked.length === 0 ? '未发现疑似密钥' : leaked.join('；') });

    const ok = checks.every((c) => c.ok);
    const last = await this.lastBuild(project.id);
    const version = (last?.version ?? 0) + 1;
    await this.db.insert(websiteBuilds).values({
      id: newId('wbld'),
      websiteProjectId: project.id,
      version,
      files,
      buildLog: checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`).join('\n'),
      status: ok ? 'succeeded' : 'failed',
      trigger: 'manual',
      error: ok ? null : checks.filter((c) => !c.ok).map((c) => c.name).join(', '),
      createdAt: nowIso(),
    });
    logger.info('website build check', { projectId: project.id, ok, files: files.length, bytes });
    return { ok, version, checks, files: files.length, bytes };
  }
}

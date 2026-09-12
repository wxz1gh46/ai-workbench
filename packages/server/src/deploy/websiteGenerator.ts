import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WebsitePlan } from '@ai/shared';
import { safeJoin } from '../tools/fs-tools.ts';
import { logger } from '../utils/logger.ts';
import { AppError } from '../utils/errors.ts';
import { buildFullstackSite, schemaSql } from './fullstackBuilder.ts';
import { validateProjectName } from './deployService.ts';
import { buildStaticSite } from './staticSiteBuilder.ts';
import type { GeneratedFile } from './templates.ts';

/**
 * 网站生成器（Step 1）。
 *
 * 职责：把「结构化需求」变成「写完即可运行的项目文件」，并落到工作区内。
 *
 * 安全：
 *   - 所有路径经 safeJoin 校验，禁止越出工作区根目录；
 *   - 生成内容里不含任何密钥（模板只写变量名）；
 *   - 生成前先做敏感词扫描，命中直接拒绝（防止把用户贴的 Token 写进产物）。
 */

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'github-pat', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'openai-key', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'aws-akid', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'slack-token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'postgres-uri-with-password', re: /postgres(ql)?:\/\/[^:\s]+:[^@\s]+@/ },
];

export function scanForSecrets(text: string): string[] {
  return SECRET_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
}

export interface GenerateResult {
  rootDir: string;
  entryFile: string;
  files: { path: string; bytes: number }[];
  plan: WebsitePlan;
  previewCommand: string;
}

/** 生成文件列表（纯函数，便于测试） */
export function generateFiles(plan: WebsitePlan, projectName: string, requirement: string): GeneratedFile[] {
  return plan.needsDatabase || plan.siteType !== 'static'
    ? buildFullstackSite(plan, projectName, requirement)
    : buildStaticSite(plan, projectName, requirement);
}

/** 把文件写入工作区 `websites/<projectName>/`；返回落盘清单 */
export async function writeProject(
  workspaceRoot: string | null,
  projectName: string,
  files: GeneratedFile[],
): Promise<{ rootDir: string; written: { path: string; bytes: number }[] }> {
  if (!workspaceRoot) {
    throw AppError.badRequest('工作区未设置根目录：请先在「设置 → 工作区」中选择一个本地目录，生成的项目会写入该目录');
  }
  // 净化前显式拒绝路径穿越形态，避免「静默修正」让用户误判写入位置
  const nameCheck = validateProjectName(projectName);
  if (!nameCheck.ok) throw AppError.badRequest(nameCheck.reason ?? '项目名不合法');
  const relRoot = path.posix.join('websites', projectName);
  const absRoot = safeJoin(workspaceRoot, relRoot);

  const hits: { file: string; pattern: string }[] = [];
  for (const f of files) {
    for (const p of scanForSecrets(f.content)) hits.push({ file: f.path, pattern: p });
  }
  if (hits.length > 0) {
    throw AppError.badRequest(
      `生成的产物中检测到疑似密钥，已拒绝写入（请把凭据放到部署平台的环境变量里）：${hits.map((h) => `${h.file}:${h.pattern}`).join(', ')}`,
    );
  }

  // 重新生成前先清空目标目录：避免上一版残留文件（例如换了实体后旧 api/*.mjs 仍在，
  // 而 server.mjs 已不再 import 它，造成「文件在但接口 404」这种极难排查的问题）
  await rm(absRoot, { recursive: true, force: true });
  await mkdir(absRoot, { recursive: true });
  const written: { path: string; bytes: number }[] = [];
  for (const f of files) {
    const abs = safeJoin(workspaceRoot, path.posix.join(relRoot, f.path));
    await mkdir(path.dirname(abs), { recursive: true });
    const content = f.content.replace(/\r\n/g, '\n');
    await writeFile(abs, content, 'utf8');
    written.push({ path: f.path, bytes: Buffer.byteLength(content) });
  }
  logger.info('website project written', { relRoot, files: written.length });
  return { rootDir: relRoot, written };
}

/** 入口文件与预览命令 */
export function resolveEntry(plan: WebsitePlan): { entryFile: string; previewCommand: string } {
  return {
    entryFile: plan.siteType === 'static' ? 'index.html' : 'server.mjs',
    previewCommand: 'npm run dev',
  };
}

/** 生成 DDL 文本（供数据库面板直接使用） */
export function planSchemaSql(plan: WebsitePlan): string {
  return plan.needsDatabase ? schemaSql(plan) : '';
}

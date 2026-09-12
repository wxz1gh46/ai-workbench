import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition, ToolResult } from './types.ts';
import { AppError } from '../utils/errors.ts';

/**
 * 安全边界：所有文件工具只能访问 workspaceRoot 之内。
 * 路径穿越（../）一律拒绝。
 */
export function safeJoin(root: string | null, rel: string): string {
  if (!root) throw AppError.badRequest('工作区未设置根目录，无法读写文件');
  const resolved = path.resolve(root, rel);
  const normalizedRoot = path.resolve(root);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    throw AppError.forbidden(`路径越界，禁止访问工作区之外: ${rel}`);
  }
  return resolved;
}

export const readFileTool: ToolDefinition<{ path: string; maxBytes?: number }> = {
  name: 'fs.read',
  description: '读取工作区内文本文件内容',
  dangerous: false,
  permission: 'fs:read',
  parameters: {
    path: { type: 'string', description: '相对于工作区根目录的路径', required: true },
    maxBytes: { type: 'number', description: '最大读取字节数，默认 200000' },
  },
  async run(args, ctx): Promise<ToolResult> {
    const abs = safeJoin(ctx.workspaceRoot, args.path);
    if (!existsSync(abs)) return { ok: false, error: `文件不存在: ${args.path}` };
    const buf = await readFile(abs);
    const limit = args.maxBytes ?? 200_000;
    return { ok: true, data: buf.subarray(0, limit).toString('utf8'), summary: `读取 ${args.path}` };
  },
};

export const writeFileTool: ToolDefinition<{ path: string; content: string }> = {
  name: 'fs.write',
  description: '写入文本文件（自动创建目录）',
  dangerous: false,
  permission: 'fs:write',
  parameters: {
    path: { type: 'string', description: '相对路径', required: true },
    content: { type: 'string', description: '文件内容', required: true },
  },
  async run(args, ctx): Promise<ToolResult> {
    const abs = safeJoin(ctx.workspaceRoot, args.path);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, args.content, 'utf8');
    return { ok: true, data: { path: args.path, bytes: Buffer.byteLength(args.content) }, summary: `写入 ${args.path}` };
  },
};

export const listDirTool: ToolDefinition<{ path?: string }> = {
  name: 'fs.list',
  description: '列出目录内容',
  dangerous: false,
  permission: 'fs:read',
  parameters: { path: { type: 'string', description: '相对路径，默认 .' } },
  async run(args, ctx): Promise<ToolResult> {
    const abs = safeJoin(ctx.workspaceRoot, args.path ?? '.');
    if (!existsSync(abs)) return { ok: false, error: `目录不存在: ${args.path ?? '.'}` };
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(abs, { withFileTypes: true });
    return {
      ok: true,
      data: entries.map((e) => ({ name: e.name, dir: e.isDirectory() })),
      summary: `列出 ${args.path ?? '.'}`,
    };
  },
};

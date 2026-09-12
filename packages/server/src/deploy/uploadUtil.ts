import type { GeneratedFile } from './templates.ts';

/**
 * 部署产物打包/上传工具。
 *
 * 设计取舍：
 *   - 不引入 tar/gzip 依赖（保持「零额外依赖 + 离线可测」），
 *     直接按平台 API 需要的「文本文件内联」格式输出；
 *   - 二进制文件（图片等）在生成阶段不会出现，若用户后续手动加入，
 *     这里会跳过并显式告警，而不是静默丢失。
 */

export interface PackedFiles {
  files: { file: string; data: string; encoding: 'utf-8' }[];
  skipped: string[];
  fileCount: number;
  totalBytes: number;
}

const TEXT_EXT = /\.(html|css|js|mjs|cjs|ts|tsx|jsx|json|md|txt|sql|yml|yaml|svg|env|example|gitignore|toml|xml)$/i;

export function packFilesForUpload(files: GeneratedFile[]): PackedFiles {
  const out: PackedFiles['files'] = [];
  const skipped: string[] = [];
  let totalBytes = 0;
  for (const f of files) {
    const isDotFile = f.path.split('/').pop()?.startsWith('.') ?? false;
    if (!TEXT_EXT.test(f.path) && !isDotFile) {
      skipped.push(f.path);
      continue;
    }
    const bytes = Buffer.byteLength(f.content);
    totalBytes += bytes;
    out.push({ file: f.path, data: f.content, encoding: 'utf-8' });
  }
  return { files: out, skipped, fileCount: out.length, totalBytes };
}

/** 字节数 → 人类可读 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 各平台上传限流：单文件不宜过大，超过则截断提示（生成产物通常远小于此） */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export function assertFileSizes(files: GeneratedFile[]): string[] {
  return files.filter((f) => Buffer.byteLength(f.content) > MAX_FILE_BYTES).map((f) => f.path);
}

/** 占位：部分平台需要 tar.gz 二进制上传。保持接口稳定，便于后续替换为真实实现。 */
export async function uploadTarball(): Promise<never> {
  throw new Error('tar 上传通道未启用：当前使用内联文件上传（Vercel / Cloudflare / Netlify 均支持）');
}

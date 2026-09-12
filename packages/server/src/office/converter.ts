/**
 * 格式转换（LibreOffice headless）。
 *
 * 合规与可用性设计：
 * - LibreOffice 是**可选**外部依赖，路径由用户通过 SOFFICE_PATH 配置；
 * - 未配置或不可用时，返回明确的可读错误与降级建议，绝不静默产出坏文件；
 * - 转换在独立临时目录进行（沙箱），避免污染工作区；
 * - 有超时保护，避免 soffice 挂死拖垮服务。
 */
import { execFile } from 'node:child_process';
import { access, copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { OfficeFormat } from '@ai/shared';
import { config } from '../config.ts';
import { logger } from '../utils/logger.ts';

const execFileAsync = promisify(execFile);

const CONVERTER_BY_TARGET: Record<string, string> = {
  docx: 'docx:"MS Word 2007 XML"',
  xlsx: 'xlsx:"Calc MS Excel 2007 XML"',
  pptx: 'pptx:"Impress MS PowerPoint 2007 XML"',
  pdf: 'pdf:writer_pdf_Export',
  markdown: 'txt:"Text"',
};

export interface ConvertResult {
  outputPath: string;
  bytes: number;
  converter: string;
  degraded: boolean;
  warnings: string[];
}

export async function isConverterAvailable(): Promise<boolean> {
  const bin = config.office.sofficePath;
  if (!bin) return false;
  try {
    await access(bin);
    return true;
  } catch {
    return false;
  }
}

/**
 * 转换文档格式。
 * @param inputAbs 源文件绝对路径（必须在工作区内，由调用方校验）
 * @param outputDir 输出目录（工作区内）
 */
export async function convertDocument(inputAbs: string, outputDir: string, target: OfficeFormat): Promise<ConvertResult> {
  const filter = CONVERTER_BY_TARGET[target];
  if (!filter) {
    return { outputPath: '', bytes: 0, converter: 'none', degraded: true, warnings: [`不支持转换到 ${target}`] };
  }

  if (!(await isConverterAvailable())) {
    return {
      outputPath: '',
      bytes: 0,
      converter: 'none',
      degraded: true,
      warnings: [
        'LibreOffice headless 未配置：请安装 LibreOffice 并设置环境变量 SOFFICE_PATH（例如 /usr/bin/soffice）。' +
          '未配置时无法做跨格式转换；当前支持同格式读取/编辑与直接生成 docx/xlsx/pptx/pdf。',
      ],
    };
  }

  const workDir = await mkdtemp(path.join(tmpdir(), 'ai-office-'));
  try {
    const localInput = path.join(workDir, path.basename(inputAbs));
    await copyFile(inputAbs, localInput);
    const args = ['--headless', '--norestore', '--invisible', '--convert-to', filter, '--outdir', workDir, localInput];
    try {
      await execFileAsync(config.office.sofficePath, args, {
        timeout: config.office.convertTimeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error('office convert failed', { target, error: msg });
      return { outputPath: '', bytes: 0, converter: config.office.sofficePath, degraded: true, warnings: [`转换失败：${msg.slice(0, 300)}`] };
    }

    const produced = path.join(workDir, `${path.basename(inputAbs, path.extname(inputAbs))}.${target === 'markdown' ? 'txt' : target}`);
    const info = await stat(produced).catch(() => null);
    if (!info) {
      return { outputPath: '', bytes: 0, converter: config.office.sofficePath, degraded: true, warnings: ['转换未产出文件'] };
    }
    const outName = `${path.basename(inputAbs, path.extname(inputAbs))}.${target === 'markdown' ? 'md' : target}`;
    const outAbs = path.join(outputDir, outName);
    await copyFile(produced, outAbs);
    return {
      outputPath: outAbs,
      bytes: info.size,
      converter: config.office.sofficePath,
      degraded: false,
      warnings: target === 'markdown' ? ['LibreOffice 转文本会丢失排版，仅适合做内容提取'] : [],
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 读取转换产物的文本内容（用于 markdown 输出） */
export async function readConvertedText(absPath: string, maxBytes = 200_000): Promise<string> {
  const buf = await readFile(absPath);
  return buf.subarray(0, maxBytes).toString('utf8');
}

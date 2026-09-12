/**
 * Office 文档解析（读取）。
 *
 * 覆盖 docx / xlsx / pptx / pdf / markdown：
 * - docx：用 docx 库写入的文件是 OOXML，这里用最小 ZIP + XML 抽取实现读取（零额外依赖）
 * - xlsx：exceljs 读取（保留公式值、多 sheet）
 * - pptx：读取 ppt/slides/slideN.xml 抽取文本（无需 pptxgenjs 之外的依赖）
 * - pdf：pdf-lib 只能写；读取用轻量 PDF 文本抽取（仅支持未压缩/FlateDecode 的简单文本流）
 *
 * 设计取舍：不引入重量级 native 依赖（如 libreoffice/pdfium），保证离线可跑、可测。
 * 读取能力不足时**显式返回 warnings**，而不是静默返回空内容。
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { inflateSync, inflateRawSync } from 'node:zlib';
import { readZip, type ZipEntry } from './zip.ts';
import path from 'node:path';
import type { OfficeContent, OfficeDocumentInfo, OfficeFormat } from '@ai/shared';

const require = createRequire(import.meta.url);

export interface ParseResult {
  content: OfficeContent;
  meta: OfficeDocumentInfo['meta'];
  warnings: string[];
}

export function detectFormat(filePath: string): OfficeFormat | null {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx' || ext === 'pdf') return ext;
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  return null;
}

/* ZIP 读取复用 ./zip.ts（唯一实现，避免两处维护） */

/** 去掉 XML 标签，保留文本与换行 */
function xmlToText(xml: string): string {
  return xml
    .replace(/<w:br\s*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<a:br\s*\/>/g, '\n')
    .replace(/<\/a:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------- docx ------------------------------- */

export function parseDocx(buf: Buffer): ParseResult {
  const warnings: string[] = [];
  let entries: ZipEntry[] = [];
  try {
    entries = readZip(buf);
  } catch (e) {
    return { content: { text: '' }, meta: {}, warnings: [`docx 解析失败：${e instanceof Error ? e.message : String(e)}`] };
  }
  const doc = entries.find((e) => e.name === 'word/document.xml');
  if (!doc) return { content: { text: '' }, meta: {}, warnings: ['docx 缺少 word/document.xml'] };

  const xml = doc.data.toString('utf8');
  const text = xmlToText(xml);
  const paragraphs = (xml.match(/<w:p[ >]/g) ?? []).length;
  const outline = [...xml.matchAll(/<w:pStyle\s+w:val="Heading(\d)"[^>]*\/>[\s\S]*?<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => ({
    level: Number(m[1]),
    text: m[2] ?? '',
  }));
  if (outline.length === 0) warnings.push('未解析到标题层级（文档未使用内置 Heading 样式）');

  return {
    content: { text, ...(outline.length ? { outline } : {}) },
    meta: { paragraphs, words: text.length },
    warnings,
  };
}

/* ------------------------------- xlsx ------------------------------- */

export async function parseXlsx(buf: Buffer): Promise<ParseResult> {
  const warnings: string[] = [];
  const ExcelJS = require('exceljs') as typeof import('exceljs');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch (e) {
    return { content: { text: '' }, meta: {}, warnings: [`xlsx 解析失败：${e instanceof Error ? e.message : String(e)}`] };
  }

  const tables: NonNullable<OfficeContent['tables']> = [];
  const sheets: NonNullable<OfficeMetaSheets> = [];
  const lines: string[] = [];

  wb.eachSheet((ws) => {
    const rows: (string | number | boolean | null)[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const values: (string | number | boolean | null)[] = [];
      const cellCount = Math.max(row.cellCount, 1);
      for (let i = 1; i <= cellCount; i++) {
        const v = row.getCell(i).value;
        if (v === null || v === undefined) values.push(null);
        else if (typeof v === 'object' && v !== null && 'result' in v) values.push((v as { result?: unknown }).result as string | number | boolean ?? null);
        else if (typeof v === 'object' && v !== null) values.push(String((v as { text?: string }).text ?? JSON.stringify(v)));
        else values.push(v as string | number | boolean);
      }
      rows.push(values);
    });
    tables.push({ sheet: ws.name, rows });
    sheets.push({ name: ws.name, rows: rows.length, cols: rows[0]?.length ?? 0 });
    lines.push(`## ${ws.name}`, ...rows.map((r) => r.map((c) => (c === null ? '' : String(c))).join('\t')));
  });

  if (tables.length === 0) warnings.push('工作簿没有可读工作表');
  return {
    content: { text: lines.join('\n'), tables },
    meta: { sheets },
    warnings,
  };
}

type OfficeMetaSheets = NonNullable<OfficeDocumentInfo['meta']['sheets']>;

/* ------------------------------- pptx ------------------------------- */

export function parsePptx(buf: Buffer): ParseResult {
  const warnings: string[] = [];
  let entries: ZipEntry[] = [];
  try {
    entries = readZip(buf);
  } catch (e) {
    return { content: { text: '' }, meta: {}, warnings: [`pptx 解析失败：${e instanceof Error ? e.message : String(e)}`] };
  }

  const slideEntries = entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => slideIndex(a.name) - slideIndex(b.name));
  if (slideEntries.length === 0) return { content: { text: '', slides: [] }, meta: { slides: 0 }, warnings: ['pptx 中没有幻灯片'] };

  const slides: NonNullable<OfficeContent['slides']> = [];
  const lines: string[] = [];

  for (const entry of slideEntries) {
    const xml = entry.data.toString('utf8');
    const textRuns = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1] ?? '').filter((t) => t.trim().length > 0);
    // 第一段通常是大标题
    const title = textRuns[0] ?? `第 ${slideIndex(entry.name)} 页`;
    const bullets = textRuns.slice(1);
    slides.push({ title, bullets });
    lines.push(`## ${title}`);
    for (const b of bullets) lines.push(`- ${b}`);
  }

  return {
    content: { text: lines.join('\n'), slides },
    meta: { slides: slides.length },
    warnings,
  };
}

function slideIndex(name: string): number {
  return Number(name.match(/slide(\d+)\.xml$/)?.[1] ?? '0');
}

/* -------------------------------- pdf ------------------------------- */

/**
 * PDF 文本抽取（零依赖实现）。
 *
 * 现实情况：现代 PDF（含 pdf-lib / Word / LaTeX 产出）会把目录结构放进
 * **对象流（ObjStm）** 并按 FlateDecode 压缩，页数与文本都藏在压缩流里。
 * 因此这里做两层：
 *  1) 解压所有 FlateDecode 流（含对象流），拼成「逻辑文档」再统计页数、抽文本；
 *  2) 支持 Tj / TJ / ' / " 四种文本操作符，并处理 \\( 转义与 <hex> 字符串。
 *
 * 不追求完整 PDF 规范实现（那需要字体 CMap 与复杂编码解析）。
 * 因此遇到扫描件 / 子集字体时**必须返回 warnings**，让用户去配 LibreOffice 或 OCR，
 * 而不是给出看似成功的空结果。
 */
export function parsePdf(buf: Buffer): ParseResult {
  const warnings: string[] = [];
  const latin = buf.toString('latin1');

  const decodedStreams: string[] = [];
  const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
  let m: RegExpExecArray | null;
  let streamCount = 0;
  while ((m = streamRe.exec(latin)) !== null) {
    streamCount += 1;
    const body = Buffer.from(m[1] ?? '', 'latin1');
    if (body.length > 2 && body[0] === 0x78) {
      try {
        decodedStreams.push(inflateSync(body).toString('latin1'));
      } catch {
        try {
          decodedStreams.push(inflateRawSync(body).toString('latin1'));
        } catch {
          warnings.push('存在无法解压的内容流（可能使用了非标准压缩）');
        }
      }
    } else {
      decodedStreams.push(body.toString('latin1'));
    }
  }

  if (streamCount === 0) warnings.push('PDF 中未找到可解析的内容流');
  // 未压缩部分也要参与（页数、部分文本可能在明文对象里）
  const corpus = `${latin}\n${decodedStreams.join('\n')}`;

  // 页数：兼容 /Type /Page、/Type/Page 与对象流内的写法
  const pages = Math.max(
    (corpus.match(/\/Type\s*\/Pages?\b/g) ?? []).filter((t) => !t.includes('Pages')).length,
    (corpus.match(/\/Type\s*\/Pages\b/g) ?? []).length > 0 ? countPagesInObjStm(decodedStreams) : 0,
  );

  const chunks: string[] = [];
  for (const stream of decodedStreams) {
    if (/\/Type\s*\/ObjStm/.test(latin.slice(0, 100)) && false) continue;
    chunks.push(...extractPdfText(stream));
  }

  const text = chunks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length === 0 && pages > 0) {
    warnings.push('未能提取到文本（可能是扫描件，或使用了 CMap/子集字体编码）。建议配置 SOFFICE_PATH 转换后再读取，或改用 OCR。');
  }

  return { content: { text }, meta: { pages }, warnings };
}

/** 从对象流里统计页对象（ObjStm 内的 /Type/Page 同样可见于解压后的文本） */
function countPagesInObjStm(streams: string[]): number {
  let count = 0;
  for (const s of streams) {
    for (const hit of s.matchAll(/\/Type\s*\/Page(?![s])/g)) {
      void hit;
      count += 1;
    }
  }
  return count;
}

/** 抽取文本操作符内容：Tj / TJ / ' / " */
function extractPdfText(stream: string): string[] {
  const out: string[] = [];
  const re = /\(((?:\\.|[^\\()])*)\)\s*(?:Tj|TJ|'|")|\[((?:[^\]\\]|\\.)*)\]\s*TJ|(<[0-9A-Fa-f\s]+>)\s*Tj/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stream)) !== null) {
    if (m[1] !== undefined) {
      const t = unescapePdf(m[1]);
      if (t.trim()) out.push(t);
    } else if (m[2] !== undefined) {
      // TJ 数组：把相邻字符串与字距调整拼起来（负数 kerning 视为不加空格）
      const parts: string[] = [];
      for (const token of m[2].matchAll(/\(((?:\\.|[^\\()])*)\)|(-?\d+(?:\.\d+)?)/g)) {
        if (token[1] !== undefined) parts.push(unescapePdf(token[1]));
        else if (Number(token[2]) <= -80) parts.push(' ');
      }
      const t = parts.join('');
      if (t.trim()) out.push(t);
    } else if (m[3] !== undefined) {
      const t = hexToString(m[3]);
      if (t.trim()) out.push(t);
    }
  }
  return out;
}

function hexToString(hex: string): string {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
  let s = '';
  for (let i = 0; i + 1 < clean.length; i += 2) s += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
  return s;
}

function unescapePdf(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c: string) => {
    if (/^[0-7]{1,3}$/.test(c)) return String.fromCharCode(parseInt(c, 8));
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' } as Record<string, string>)[c] ?? c;
  });
}

/* ------------------------------ 统一入口 ----------------------------- */

export async function parseOfficeFile(absPath: string, relPath: string): Promise<OfficeDocumentInfo & { warnings: string[] }> {
  const format = detectFormat(absPath);
  if (!format) {
    return {
      fileId: null,
      path: relPath,
      format: 'markdown',
      meta: {},
      content: { text: '' },
      warnings: [`不支持的文件类型：${path.extname(absPath) || '(无扩展名)'}`],
    };
  }

  const buf = await readFile(absPath);
  const result =
    format === 'docx'
      ? parseDocx(buf)
      : format === 'xlsx'
        ? await parseXlsx(buf)
        : format === 'pptx'
          ? parsePptx(buf)
          : format === 'pdf'
            ? parsePdf(buf)
            : { content: { text: buf.toString('utf8') }, meta: { words: buf.length }, warnings: [] as string[] };

  return { fileId: null, path: relPath, format, meta: result.meta, content: result.content, warnings: result.warnings };
}

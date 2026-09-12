import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { ToolDefinition, ToolResult } from './types.ts';
import { safeJoin } from './fs-tools.ts';

export interface OfficeGenerateInput extends Record<string, unknown> {
  format: 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'markdown';
  title: string;
  content: string;
  outputPath?: string;
  sheets?: { name: string; rows: (string | number | boolean | null)[][] }[];
  slides?: { title: string; bullets: string[] }[];
}

/** Markdown 简易解析：仅支持 # 标题 / - 列表 / 普通段落，够生成文档 */
function parseMarkdown(md: string): { level: number; text: string }[] {
  return md
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) return { level: h[1]!.length, text: h[2]! };
      const li = line.match(/^[-*]\s+(.*)$/);
      if (li) return { level: 99, text: li[1]! };
      return { level: 0, text: line };
    });
}

async function buildDocx(input: OfficeGenerateInput): Promise<Buffer> {
  const children: Paragraph[] = [new Paragraph({ text: input.title, heading: HeadingLevel.TITLE })];
  for (const node of parseMarkdown(input.content)) {
    if (node.level === 99) {
      children.push(new Paragraph({ text: node.text, bullet: { level: 0 } }));
    } else if (node.level > 0) {
      const headingMap = [
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4,
        HeadingLevel.HEADING_5,
        HeadingLevel.HEADING_6,
      ];
      children.push(
        new Paragraph({
          text: node.text,
          heading: headingMap[Math.min(node.level, 6) - 1] ?? HeadingLevel.HEADING_6,
        }),
      );
    } else {
      children.push(new Paragraph({ children: [new TextRun(node.text)] }));
    }
  }
  const doc = new Document({ sections: [{ children }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

async function buildXlsx(input: OfficeGenerateInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AI Workbench';
  const sheets = input.sheets?.length
    ? input.sheets
    : [{ name: 'Sheet1', rows: parseMarkdown(input.content).map((n) => [n.text]) }];
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31));
    for (const row of s.rows) ws.addRow(row);
    ws.getRow(1).font = { bold: true };
  }
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}

async function buildPptx(input: OfficeGenerateInput): Promise<Buffer> {
  const pptx = new PptxGenJS();
  const slides = input.slides?.length
    ? input.slides
    : [
        { title: input.title, bullets: [] as string[] },
        ...groupMarkdownIntoSlides(input.content),
      ];
  for (const s of slides) {
    const slide = pptx.addSlide();
    slide.addText(s.title, { x: 0.5, y: 0.4, w: '90%', h: 0.8, fontSize: 24, bold: true, color: '1F2937' });
    if (s.bullets.length) {
      slide.addText(
        s.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
        { x: 0.7, y: 1.4, w: '85%', h: 4, fontSize: 16, color: '374151' },
      );
    }
  }
  const out = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  return out;
}

function groupMarkdownIntoSlides(md: string): { title: string; bullets: string[] }[] {
  const nodes = parseMarkdown(md);
  const slides: { title: string; bullets: string[] }[] = [];
  let current: { title: string; bullets: string[] } | null = null;
  for (const node of nodes) {
    if (node.level > 0 && node.level <= 2) {
      if (current) slides.push(current);
      current = { title: node.text, bullets: [] };
    } else if (current) {
      current.bullets.push(node.text);
    } else {
      current = { title: '概述', bullets: [node.text] };
    }
  }
  if (current) slides.push(current);
  return slides;
}

/**
 * PDF 生成。
 *
 * 已知限制：pdf-lib 内置的 Helvetica 使用 WinAnsi 编码，无法表示 CJK。
 * 处理策略（不静默产出乱码/不崩溃）：
 *  1) 若系统存在可用 CJK 字体（环境变量 PDF_CJK_FONT 或常见路径），嵌入后输出完整中文
 *  2) 否则把非 ASCII 字符替换为占位符，并在文档头部明确标注降级原因
 * Phase 2 将通过 LibreOffice headless 转换提供完整 CJK 支持。
 */
function findCjkFont(): string | null {
  const candidates = [
    process.env.PDF_CJK_FONT,
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/System/Library/Fonts/PingFang.ttc',
    'C:/Windows/Fonts/msyh.ttc',
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** 无 CJK 字体时，把不可编码字符替换为安全的占位符 */
function asciiSafe(text: string): { text: string; lossy: boolean } {
  let lossy = false;
  const out = [...text]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      if (code <= 0xff) return ch;
      lossy = true;
      return '?';
    })
    .join('');
  return { text: out, lossy };
}

async function buildPdf(input: OfficeGenerateInput): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const fontPath = findCjkFont();
  let font;
  let supportsCjk = false;
  if (fontPath) {
    try {
      font = await doc.embedFont(await readFile(fontPath), { subset: true });
      supportsCjk = true;
    } catch {
      font = await doc.embedFont(StandardFonts.Helvetica);
    }
  } else {
    font = await doc.embedFont(StandardFonts.Helvetica);
  }

  let lossy = false;
  const encode = (raw: string): string => {
    if (supportsCjk) return raw;
    const { text, lossy: l } = asciiSafe(raw);
    lossy = lossy || l;
    return text;
  };

  const lines: string[] = [input.title];
  for (const n of parseMarkdown(input.content)) lines.push(n.text);
  if (!supportsCjk) {
    lines.unshift(
      '[Notice] CJK font not found; non-ASCII characters are shown as "?". ' +
        'Set PDF_CJK_FONT to a CJK TTF/TTC path for full Chinese support.',
    );
  }

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 50;
  const fontSize = 11;
  const lineHeight = 16;
  const maxChars = supportsCjk ? 46 : 90;

  let page = doc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;
  for (const raw of lines) {
    for (const line of wrapText(encode(raw), maxChars)) {
      if (y < margin) {
        page = doc.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
      }
      page.drawText(line, { x: margin, y, size: fontSize, font, color: rgb(0.12, 0.16, 0.22) });
      y -= lineHeight;
    }
  }
  if (lossy) {
    // 记录降级事实，便于上层感知（不抛错，保证产物可用）
    (doc as unknown as { __lossy?: boolean }).__lossy = true;
  }
  return Buffer.from(await doc.save());
}

function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > width) {
    out.push(rest.slice(0, width));
    rest = rest.slice(width);
  }
  out.push(rest);
  return out;
}

export const officeGenerateTool: ToolDefinition<OfficeGenerateInput> = {
  name: 'office.generate',
  description: '生成 docx / xlsx / pptx / pdf / markdown 文件并写入工作区',
  dangerous: false,
  permission: 'office:write',
  parameters: {
    format: { type: 'string', description: 'docx | xlsx | pptx | pdf | markdown', required: true },
    title: { type: 'string', description: '文档标题', required: true },
    content: { type: 'string', description: 'Markdown 内容', required: true },
    outputPath: { type: 'string', description: '输出相对路径，默认 out/<title>.<ext>' },
  },
  async run(args, ctx): Promise<ToolResult> {
    const ext = args.format === 'markdown' ? 'md' : args.format;
    const rel = args.outputPath ?? path.posix.join('out', `${sanitize(args.title)}.${ext}`);
    const abs = safeJoin(ctx.workspaceRoot, rel);
    await mkdir(path.dirname(abs), { recursive: true });

    let buf: Buffer;
    switch (args.format) {
      case 'docx':
        buf = await buildDocx(args);
        break;
      case 'xlsx':
        buf = await buildXlsx(args);
        break;
      case 'pptx':
        buf = await buildPptx(args);
        break;
      case 'pdf':
        buf = await buildPdf(args);
        break;
      case 'markdown':
        buf = Buffer.from(`# ${args.title}\n\n${args.content}`, 'utf8');
        break;
      default:
        return { ok: false, error: `不支持的格式: ${String(args.format)}` };
    }
    await writeFile(abs, buf);
    return {
      ok: true,
      data: { path: rel, bytes: buf.length, format: args.format },
      summary: `已生成 ${rel} (${buf.length} 字节)`,
    };
  },
};

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'untitled';
}

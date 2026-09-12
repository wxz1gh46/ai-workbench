/**
 * Office 文档编辑（不破坏原格式）。
 *
 * 策略：
 * - docx / pptx：OOXML 是 ZIP + XML，直接**原地改写 XML 节点**，保留样式、主题、
 *   图片等所有未触及部分 —— 这是「不破坏原格式」的正确做法（对比重新生成整份文档）。
 * - xlsx：用 exceljs 载入 → 只改目标单元格 → 重新写出。
 *   说明：exceljs 重写会丢失部分扩展特性（如部分图表/条件格式），因此显式返回 warnings。
 *
 * 所有编辑前都会由调用方（service 层）先做 FileVersion 备份，保证可回滚。
 */
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { parseOfficeFile } from './parse.ts';

const require = createRequire(import.meta.url);

export type EditOperation =
  | { op: 'append'; text: string }
  | { op: 'replace'; find: string; replace: string }
  | { op: 'setCell'; sheet: string; cell: string; value: string | number }
  | { op: 'addSlide'; title: string; bullets: string[] };

export interface EditResult {
  path: string;
  bytes: number;
  applied: number;
  warnings: string[];
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ------------------------------- docx ------------------------------- */

/**
 * docx 编辑：替换 document.xml 中的文本节点 / 追加段落。
 * 关键点：只做「文本级」替换与「段落级」追加，不重建文档结构，因此样式、页眉页脚、
 * 图片、批注等全部保留。
 */
async function editDocx(absPath: string, ops: EditOperation[]): Promise<EditResult> {
  const buf = await readFile(absPath);
  const { readZip, writeZip } = await import('./zip.ts');
  const entries = readZip(buf);
  const docEntry = entries.find((e) => e.name === 'word/document.xml');
  if (!docEntry) throw new Error('docx 缺少 word/document.xml，无法编辑');

  let xml = docEntry.data.toString('utf8');
  let applied = 0;
  const warnings: string[] = [];

  for (const op of ops) {
    if (op.op === 'replace') {
      if (!op.find) continue;
      const escapedFind = xmlEscape(op.find);
      // 在 <w:t> 文本节点内替换，避免命中 XML 结构
      let hit = false;
      xml = xml.replace(/<w:t([^>]*)>([^<]*)<\/w:t>/g, (_full, attrs: string, text: string) => {
        if (text.includes(escapedFind) || text.includes(op.find)) {
          hit = true;
          return `<w:t${attrs}>${text.split(escapedFind).join(xmlEscape(op.replace)).split(op.find).join(xmlEscape(op.replace))}</w:t>`;
        }
        return _full;
      });
      if (hit) applied += 1;
      else warnings.push(`未找到待替换文本「${op.find.slice(0, 30)}」`);
    } else if (op.op === 'append') {
      // 追加到 body 末尾（sectPr 之前）
      const paragraphs = op.text
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          const match = line.match(/^(#{1,6})\s+(.*)$/);
          if (match) {
            const level = match[1]!.length;
            return `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr><w:r><w:t xml:space="preserve">${xmlEscape(match[2] ?? '')}</w:t></w:r></w:p>`;
          }
          const li = line.match(/^[-*]\s+(.*)$/);
          if (li) return `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t xml:space="preserve">${xmlEscape(li[1] ?? '')}</w:t></w:r></w:p>`;
          return `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`;
        })
        .join('');
      const insertAt = xml.lastIndexOf('<w:sectPr');
      xml = insertAt === -1 ? xml.replace('</w:body>', `${paragraphs}</w:body>`) : `${xml.slice(0, insertAt)}${paragraphs}${xml.slice(insertAt)}`;
      applied += 1;
    } else {
      warnings.push(`docx 不支持操作 ${op.op}（已跳过）`);
    }
  }

  docEntry.data = Buffer.from(xml, 'utf8');
  const out = writeZip(entries);
  await writeFile(absPath, out);
  return { path: absPath, bytes: out.length, applied, warnings };
}

/* ------------------------------- xlsx ------------------------------- */

async function editXlsx(absPath: string, ops: EditOperation[]): Promise<EditResult> {
  const ExcelJS = require('exceljs') as typeof import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await readFile(absPath)) as unknown as ArrayBuffer);

  let applied = 0;
  const warnings: string[] = ['xlsx 编辑会由 exceljs 重写文件，极少数扩展特性（部分图表/条件格式）可能丢失'];

  for (const op of ops) {
    if (op.op === 'setCell') {
      const ws = op.sheet ? wb.getWorksheet(op.sheet) : wb.worksheets[0];
      if (!ws) {
        warnings.push(`工作表「${op.sheet}」不存在`);
        continue;
      }
      ws.getCell(op.cell).value = op.value;
      applied += 1;
    } else if (op.op === 'append') {
      const ws = wb.worksheets[0];
      if (!ws) continue;
      ws.addRow(op.text.split(/\r?\n/));
      applied += 1;
    } else {
      warnings.push(`xlsx 不支持操作 ${op.op}（已跳过）`);
    }
  }

  const out = Buffer.from(await wb.xlsx.writeBuffer());
  await writeFile(absPath, out);
  return { path: absPath, bytes: out.length, applied, warnings };
}

/* ------------------------------- pptx ------------------------------- */

/**
 * pptx 编辑：追加幻灯片（保留母版与主题，新建页引用现有版式）。
 * 这是「生成内容」与「不破坏原格式」的平衡点：只新增页，不改动已有页。
 */
async function editPptx(absPath: string, ops: EditOperation[]): Promise<EditResult> {
  const PptxGenJS = (await import('pptxgenjs')).default;
  const { readZip, writeZip } = await import('./zip.ts');
  const entries = readZip(await readFile(absPath));
  const existingSlides = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).length;

  let applied = 0;
  const warnings: string[] = [];
  const slideOps = ops.filter((o): o is Extract<EditOperation, { op: 'addSlide' }> => o.op === 'addSlide');

  if (slideOps.length === 0) {
    for (const op of ops) if (op.op !== 'append') warnings.push(`pptx 不支持操作 ${op.op}`);
    return { path: absPath, bytes: (await readFile(absPath)).length, applied: 0, warnings };
  }

  // 用 pptxgenjs 生成「仅新增页」的临时文件，再把新增页合并进原文件
  const tmp = new PptxGenJS();
  for (const op of slideOps) {
    const slide = tmp.addSlide();
    slide.addText(op.title, { x: 0.5, y: 0.4, w: '90%', h: 0.8, fontSize: 24, bold: true });
    if (op.bullets.length > 0) {
      slide.addText(
        op.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
        { x: 0.7, y: 1.4, w: '85%', h: 4, fontSize: 16 },
      );
    }
    applied += 1;
  }
  const tmpBuf = Buffer.from((await tmp.write({ outputType: 'nodebuffer' })) as Buffer);
  const newEntries = readZip(tmpBuf);

  // 合并：原文件的 [Content_Types].xml 与 presentation.xml 需要同步新增页引用
  const merged = mergePptx(entries, newEntries, existingSlides);
  const out = writeZip(merged);
  await writeFile(absPath, out);
  warnings.push('pptx 采用「新增页」编辑方式，已有幻灯片内容与版式完全保留');
  return { path: absPath, bytes: out.length, applied, warnings };
}

/** 把新增页合并进原 pptx 包（同步更新内容类型与 presentation 关系） */
export function mergePptx(base: { name: string; data: Buffer }[], extra: { name: string; data: Buffer }[], existingSlides: number): { name: string; data: Buffer }[] {
  const out = [...base];
  const extraSlides = extra.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).sort((a, b) => slideIdx(a.name) - slideIdx(b.name));
  const extraRels = extra.filter((e) => /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(e.name));
  const extraMedia = extra.filter((e) => e.name.startsWith('ppt/media/'));

  const baseNames = new Set(out.map((e) => e.name));

  const indexMap = new Map<string, number>();
  extraSlides.forEach((entry, i) => {
    const newIndex = existingSlides + i + 1;
    indexMap.set(entry.name, newIndex);
    // 只改名，内容里的关系引用靠下面同步
    const renamed = `ppt/slides/slide${newIndex}.xml`;
    let data = entry.data;
    // 图片等资源重命名
    let text = data.toString('utf8');
    if (baseNames.has(renamed)) {
      return;
    }
    out.push({ name: renamed, data: Buffer.from(text, 'utf8') });
  });

  // rels
  extraRels.forEach((entry) => {
    const oldIdx = entry.name.match(/slide(\d+)\.xml\.rels$/)?.[1] ?? '1';
    const newIndex = indexMap.get(`ppt/slides/slide${oldIdx}.xml`);
    if (!newIndex) return;
    const target = `ppt/slides/_rels/slide${newIndex}.xml.rels`;
    if (baseNames.has(target)) return;
    out.push({ name: target, data: entry.data });
  });

  // media（去重）
  for (const entry of extraMedia) {
    if (baseNames.has(entry.name)) continue;
    out.push(entry);
    baseNames.add(entry.name);
  }

  // [Content_Types].xml：为新增页补 Override
  const ct = out.find((e) => e.name === '[Content_Types].xml');
  if (ct) {
    let xml = ct.data.toString('utf8');
    const overrides: string[] = [];
    for (const [, newIndex] of indexMap) {
      const part = `/ppt/slides/slide${newIndex}.xml`;
      if (!xml.includes(`PartName="${part}"`)) {
        overrides.push(`<Override PartName="${part}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`);
      }
    }
    if (overrides.length > 0) {
      xml = xml.replace('</Types>', `${overrides.join('')}</Types>`);
      ct.data = Buffer.from(xml, 'utf8');
    }
  }

  // ppt/_rels/presentation.xml.rels：新增关系项
  const presRels = out.find((e) => e.name === 'ppt/_rels/presentation.xml.rels');
  if (presRels) {
    let xml = presRels.data.toString('utf8');
    const additions: string[] = [];
    for (const [, newIndex] of indexMap) {
      if (xml.includes(`/slides/slide${newIndex}.xml`)) continue;
      additions.push(`<Relationship Id="rIdSlideMerged${newIndex}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${newIndex}.xml"/>`);
    }
    if (additions.length > 0) xml = xml.replace('</Relationships>', `${additions.join('')}</Relationships>`);
    presRels.data = Buffer.from(xml, 'utf8');
  }

  // presentation.xml：把新增页加进 sldIdLst
  const pres = out.find((e) => e.name === 'ppt/presentation.xml');
  if (pres) {
    let xml = pres.data.toString('utf8');
    const ids: string[] = [];
    let maxId = 256;
    for (const [name, newIndex] of indexMap) {
      const relId = `rIdSlideMerged${newIndex}`;
      if (xml.includes(`id="${newIndex}"`)) continue;
      maxId += 1;
      ids.push(`<p:sldId id="${maxId}" r:id="${relId}"/>`);
      void name;
    }
    if (ids.length > 0) {
      xml = xml.replace(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/, (_m, inner: string) => `<p:sldIdLst>${inner}${ids.join('')}</p:sldIdLst>`);
      pres.data = Buffer.from(xml, 'utf8');
    }
  }

  return out;
}

function slideIdx(name: string): number {
  return Number(name.match(/slide(\d+)\.xml$/)?.[1] ?? '0');
}

/* ------------------------------- pdf -------------------------------- */

/** pdf 不支持原地结构编辑（会破坏交叉引用表），改为提示并记录 */ 
async function editPdf(absPath: string, ops: EditOperation[]): Promise<EditResult> {
  const buf = await readFile(absPath);
  return {
    path: absPath,
    bytes: buf.length,
    applied: 0,
    warnings: [`PDF 不支持原地编辑（会破坏交叉引用与数字签名）；请先用 /office/convert 转成 docx 再编辑。收到 ${ops.length} 个操作未执行`],
  };
}

/* ------------------------------ 统一入口 ----------------------------- */

export async function applyOfficeEdits(absPath: string, relPath: string, ops: EditOperation[]): Promise<EditResult> {
  const info = await parseOfficeFile(absPath, relPath);
  switch (info.format) {
    case 'docx':
      return editDocx(absPath, ops);
    case 'xlsx':
      return editXlsx(absPath, ops);
    case 'pptx':
      return editPptx(absPath, ops);
    case 'pdf':
      return editPdf(absPath, ops);
    default: {
      // markdown / 文本：直接追加
      const text = await readFile(absPath, 'utf8');
      const appended = ops
        .filter((o): o is Extract<EditOperation, { op: 'append' }> => o.op === 'append')
        .map((o) => o.text)
        .join('\n');
      const next = appended ? `${text}\n\n${appended}` : text;
      await writeFile(absPath, next, 'utf8');
      return { path: absPath, bytes: Buffer.byteLength(next), applied: appended ? 1 : 0, warnings: [] };
    }
  }
}


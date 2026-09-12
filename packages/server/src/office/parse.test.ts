import assert from 'node:assert/strict';
import test from 'node:test';
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { detectFormat, parseDocx, parsePdf, parsePptx, parseXlsx } from './parse.ts';

test('detectFormat：识别扩展名', () => {
  assert.equal(detectFormat('a/b.docx'), 'docx');
  assert.equal(detectFormat('x.XLSX'), 'xlsx');
  assert.equal(detectFormat('p.pptx'), 'pptx');
  assert.equal(detectFormat('r.pdf'), 'pdf');
  assert.equal(detectFormat('n.md'), 'markdown');
  assert.equal(detectFormat('n.txt'), null);
});

test('parseDocx：读取段落文本与标题层级', async () => {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: '调研报告', heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ children: [new TextRun('正文第一段：装机量 120GW。')] }),
          new Paragraph({ children: [new TextRun('正文第二段。')] }),
        ],
      },
    ],
  });
  const buf = Buffer.from(await Packer.toBuffer(doc));
  const r = parseDocx(buf);
  assert.equal(r.warnings.length, 0, `不应有警告：${r.warnings.join(',')}`);
  assert.ok(r.content.text.includes('调研报告'));
  assert.ok(r.content.text.includes('120GW'));
  assert.ok((r.meta.paragraphs ?? 0) >= 3);
  assert.ok((r.content.outline ?? []).some((o) => o.level === 1 && o.text.includes('调研报告')));
});

test('parseDocx：非 docx 输入返回警告而不是抛错', () => {
  const r = parseDocx(Buffer.from('garbage'));
  assert.ok(r.warnings.length > 0);
  assert.equal(r.content.text, '');
});

test('parseXlsx：读取多 sheet 与单元格值', async () => {
  const wb = new ExcelJS.Workbook();
  const ws1 = wb.addWorksheet('数据');
  ws1.addRow(['年份', '装机量']);
  ws1.addRow([2024, 100]);
  ws1.addRow([2025, 120]);
  const ws2 = wb.addWorksheet('备注');
  ws2.addRow(['说明']);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());

  const r = await parseXlsx(buf);
  assert.equal(r.content.tables?.length, 2);
  assert.equal(r.content.tables?.[0]?.sheet, '数据');
  assert.deepEqual(r.content.tables?.[0]?.rows[0], ['年份', '装机量']);
  assert.equal(r.content.tables?.[0]?.rows[2]?.[1], 120);
  assert.equal(r.meta.sheets?.length, 2);
});

test('parsePptx：抽取幻灯片标题与要点', async () => {
  const pptx = new PptxGenJS();
  const s1 = pptx.addSlide();
  s1.addText('方案总览', { x: 1, y: 1 });
  s1.addText('背景\n目标\n范围', { x: 1, y: 2 });
  const s2 = pptx.addSlide();
  s2.addText('实施路径', { x: 1, y: 1 });
  const buf = Buffer.from((await pptx.write({ outputType: 'nodebuffer' })) as Buffer);

  const r = parsePptx(buf);
  assert.equal(r.meta.slides, 2);
  assert.equal(r.content.slides?.[0]?.title, '方案总览');
  assert.ok((r.content.slides?.[0]?.bullets.length ?? 0) >= 1);
  assert.equal(r.content.slides?.[1]?.title, '实施路径');
});

test('parsePdf：抽取未压缩文本、统计页数；扫描件给出明确警告', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([400, 200]);
  page.drawText('Energy storage 2025 report', { x: 20, y: 100, size: 14, font });
  const buf = Buffer.from(await doc.save());

  const r = parsePdf(buf);
  assert.equal(r.meta.pages, 1);
  // pdf-lib 会压缩内容流，能解压则能取到文本
  if (r.content.text.includes('Energy storage')) {
    assert.ok(r.content.text.includes('2025'));
  } else {
    assert.ok(r.warnings.length > 0, '未取到文本时必须给出警告，不能静默为空');
  }
});

test('parsePdf：非 PDF 输入返回警告', () => {
  const r = parsePdf(Buffer.from('not a pdf'));
  assert.ok(r.warnings.length > 0);
});

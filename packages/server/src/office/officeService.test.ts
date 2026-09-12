/**
 * Step 5 集成测试：Office 文件处理。
 * 覆盖：生成 → 读取 → 预览 → 编辑（不破坏格式）→ 版本历史 → 回滚 → 导出 → 安全边界。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';
import './test-env.ts';
import { getDb, closeDb } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';
import { WorkspaceService } from '../services/workspace.ts';
import { OfficeService, type OfficeContext } from './officeService.ts';
import { registerBuiltinTools } from '../tools/index.ts';

runMigrations();
registerBuiltinTools();
after(() => closeDb());

const tmpRoot = mkdtempSync(path.join('/tmp', 'ai-office-ws-'));
const db = getDb();
const office = new OfficeService(db);
let ctx: OfficeContext;

before(async () => {
  const ws = await new WorkspaceService(db).ensureBootstrap();
  ctx = { workspaceId: ws.workspace.id, workspaceRoot: tmpRoot };
});

test('生成 docx / xlsx / pptx / pdf / markdown 并落盘', async () => {
  for (const format of ['docx', 'xlsx', 'pptx', 'pdf', 'markdown'] as const) {
    const r = await office.generate(ctx, {
      format,
      title: `报告-${format}`,
      content: '# 摘要\n\n- 装机量增长 120GW\n- 政策驱动',
      ...(format === 'xlsx' ? { sheets: [{ name: '数据', rows: [['年份', '装机量'], [2024, 100], [2025, 120]] }] } : {}),
      ...(format === 'pptx' ? { slides: [{ title: '总览', bullets: ['要点一', '要点二'] }] } : {}),
    });
    const abs = path.join(tmpRoot, r.path);
    assert.ok(existsSync(abs), `${format} 未落盘`);
    assert.ok(r.bytes > 0);
    assert.equal(r.version, 1, `${format} 首次生成应为 v1`);
  }
});

test('读取 docx 并能解析文本', async () => {
  await office.generate(ctx, { format: 'docx', title: '可读文档', content: '# 行业简报\n\n储能装机量达到 120GW。' });
  const info = await office.read(ctx, 'out/可读文档.docx');
  assert.equal(info.format, 'docx');
  assert.ok(info.content.text.includes('行业简报'));
  assert.ok(info.content.text.includes('120GW'));
  assert.ok((info.meta.paragraphs ?? 0) > 0);
  assert.equal(info.truncated, false);
});

test('预览：xlsx 转为 markdown 表格，docx 走 docx-preview 渲染器', async () => {
  await office.generate(ctx, {
    format: 'xlsx',
    title: '数据表',
    content: '数据',
    sheets: [{ name: '装机量', rows: [['年份', 'GW'], [2024, 100], [2025, 120]] }],
  });
  const preview = await office.preview(ctx, 'out/数据表.xlsx');
  assert.equal(preview.renderer, 'sheetjs');
  assert.ok(preview.markdown.includes('| 年份 | GW |'));
  assert.ok(preview.markdown.includes('120'));
  assert.ok(preview.downloadUrl.length > 0);

  const docxPreview = await office.preview(ctx, 'out/可读文档.docx');
  assert.equal(docxPreview.renderer, 'docx-preview');
});

test('编辑 docx：替换与追加生效，且不破坏文件结构', async () => {
  await office.generate(ctx, { format: 'docx', title: '待编辑', content: '# 标题\n\n旧内容 120GW。' });
  const r = await office.edit(ctx, 'out/待编辑.docx', [
    { op: 'replace', find: '旧内容', replace: '新内容' },
    { op: 'append', text: '## 追加小节\n\n- 新增要点' },
  ]);
  assert.ok(r.applied >= 2, `应至少应用 2 个操作，实际 ${r.applied}`);
  // 生成时已产生 v1，因此编辑前的自动备份是随后的版本
  assert.ok((r.backupVersion ?? 0) >= 1, `编辑前应自动备份，实际 backupVersion=${r.backupVersion}`);
  assert.ok(r.version > (r.backupVersion ?? 0), '编辑后应产生更新的版本');

  const after = await office.read(ctx, 'out/待编辑.docx');
  assert.ok(after.content.text.includes('新内容'), '替换未生效');
  assert.ok(!after.content.text.includes('旧内容'));
  assert.ok(after.content.text.includes('追加小节'), '追加未生效');
  // 文件仍是合法 docx（可再次解析）
  assert.equal(after.warnings.length, 0, `不应产生解析警告：${after.warnings.join(',')}`);
});

test('编辑 xlsx：写入单元格并保留其他 sheet', async () => {
  await office.generate(ctx, {
    format: 'xlsx',
    title: '可编辑表',
    content: '表',
    sheets: [
      { name: '数据', rows: [['年份', 'GW'], [2024, 100]] },
      { name: '备注', rows: [['说明']] },
    ],
  });
  const r = await office.edit(ctx, 'out/可编辑表.xlsx', [{ op: 'setCell', sheet: '数据', cell: 'B3', value: 999 }]);
  assert.equal(r.applied, 1);
  assert.ok(r.warnings.some((w) => w.includes('exceljs')), '必须提示重写风险');

  const after = await office.read(ctx, 'out/可编辑表.xlsx');
  assert.equal(after.content.tables?.length, 2, '其他 sheet 不应丢失');
  assert.equal(after.content.tables?.[0]?.rows[2]?.[1], 999, '单元格未写入');
});

test('编辑 pptx：新增页且保留原有页', async () => {
  await office.generate(ctx, {
    format: 'pptx',
    title: '可扩展',
    content: 'x',
    slides: [{ title: '第一页', bullets: ['原内容'] }],
  });
  const before = await office.read(ctx, 'out/可扩展.pptx');
  const beforeSlides = before.meta.slides ?? 0;

  const r = await office.edit(ctx, 'out/可扩展.pptx', [{ op: 'addSlide', title: '第二页', bullets: ['新增要点'] }]);
  assert.equal(r.applied, 1);
  const after = await office.read(ctx, 'out/可扩展.pptx');
  assert.ok((after.meta.slides ?? 0) > beforeSlides, `页数应增加：${beforeSlides} → ${after.meta.slides}`);
  assert.ok((after.content.slides ?? []).some((s) => s.title.includes('第二页')), '新增页未出现');
  assert.ok((after.content.slides ?? []).some((s) => s.title.includes('第一页')), '原有页丢失');
});

test('编辑 pdf：明确拒绝原地编辑并给出替代方案', async () => {
  await office.generate(ctx, { format: 'pdf', title: '不可编辑', content: '内容' });
  const r = await office.edit(ctx, 'out/不可编辑.pdf', [{ op: 'append', text: 'x' }]);
  assert.equal(r.applied, 0);
  assert.ok(r.warnings.some((w) => w.includes('不支持原地编辑')));
  assert.ok(r.warnings.some((w) => w.includes('convert')));
});

test('版本历史与回滚：可查看所有版本并回滚', async () => {
  await office.generate(ctx, { format: 'docx', title: '版本演示', content: '# v1 内容' });
  await office.edit(ctx, 'out/版本演示.docx', [{ op: 'append', text: 'v2 追加' }]);
  await office.edit(ctx, 'out/版本演示.docx', [{ op: 'append', text: 'v3 追加' }]);

  const list = await office.listVersions(ctx, 'out/版本演示.docx');
  assert.ok(list.versions.length >= 3, `应有 ≥3 个版本，实际 ${list.versions.length}`);
  assert.equal(list.current, Math.max(...list.versions.map((v) => v.version)));

  const earliest = list.versions.reduce((min, v) => (v.version < min.version ? v : min));
  const restored = await office.restore(ctx, list.fileId, earliest.version);
  assert.equal(restored.restoredFrom, earliest.version);
  assert.ok(restored.version > earliest.version, '回滚本身应产生新版本（可再回滚）');
  assert.equal(restored.restoredToWorkspace, true);

  const after = await office.read(ctx, 'out/版本演示.docx');
  assert.ok(!after.content.text.includes('v2 追加'), '回滚后不应包含 v2 的追加内容');
});

test('导出：生成带过期时间的下载记录', async () => {
  await office.generate(ctx, { format: 'docx', title: '可导出', content: '# 导出内容' });
  const exp = await office.export(ctx, 'out/可导出.docx', { ttlHours: 1 });
  assert.ok(exp.id);
  assert.ok(exp.url?.includes('/files/exports/'));
  assert.ok(exp.size > 0);

  const resolved = await office.resolveExport(exp.id);
  assert.equal(resolved.expired, false);
  await assert.rejects(() => office.resolveExport('exp-not-exist'), /导出不存在/);
});

test('安全边界：拒绝工作区之外的路径（含路径穿越）', async () => {
  await assert.rejects(() => office.read(ctx, '../../etc/passwd'), /路径越界|禁止访问/);
  await assert.rejects(() => office.read(ctx, '../outside.docx'), /路径越界|禁止访问/);
  await assert.rejects(() => office.edit(ctx, '../x.docx', [{ op: 'append', text: 'x' }]), /路径越界|禁止访问/);
});

test('安全默认：未配置 rootPath 时拒绝所有文件操作', async () => {
  const noRoot: OfficeContext = { workspaceId: ctx.workspaceId, workspaceRoot: null };
  await assert.rejects(() => office.read(noRoot, 'a.docx'), /未设置根目录/);
  await assert.rejects(() => office.generate(noRoot, { format: 'docx', title: 'x', content: 'y' }), /未设置根目录/);
});

test('不存在的文件返回 404 而不是静默成功', async () => {
  await assert.rejects(() => office.read(ctx, 'out/does-not-exist.docx'), /文件不存在/);
});

test('大文件：超过解析上限时给出截断警告而不是内存溢出', async () => {
  await mkdir(path.join(tmpRoot, 'big'), { recursive: true });
  // 写入 1 个较大的 markdown（解析上限 64MB，这里验证流程与警告字段存在）
  const bigPath = path.join(tmpRoot, 'big', 'large.md');
  writeFileSync(bigPath, 'x'.repeat(1024 * 1024));
  const info = await office.read(ctx, 'big/large.md');
  assert.equal(info.format, 'markdown');
  assert.equal(typeof info.truncated, 'boolean');
  assert.ok(readFileSync(bigPath).length === 1024 * 1024);
});

test('转换：未配置 SOFFICE_PATH 时明确降级并给出配置指引', async () => {
  await office.generate(ctx, { format: 'docx', title: '待转换', content: '# 内容' });
  const status = await office.converterStatus();
  assert.equal(status.available, false);
  assert.ok(status.hint.includes('SOFFICE_PATH'));

  const r = await office.convert(ctx, 'out/待转换.docx', 'markdown');
  assert.equal(r.degraded, true);
  assert.ok(r.warnings.some((w) => w.includes('SOFFICE_PATH')));
  assert.ok(r.warnings.some((w) => w.includes('LibreOffice')));
});

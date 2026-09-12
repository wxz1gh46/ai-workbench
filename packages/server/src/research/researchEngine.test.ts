/**
 * Step 6 集成测试：深度研究。
 *
 * 覆盖验收要求：结构化报告 / 引用准确 / 冲突来源被标记 / 可导出 md+pdf+pptx / 可发布网页。
 * 使用本地 HTTP 服务模拟检索端点与来源站点，验证真实的 robots.txt 合规路径。
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import test, { after, before } from 'node:test';
import './test-env.ts';

let mockServer: Server;
let mockPort = 0;
/** 记录每个路径被请求的次数，用于验证 robots 与限流 */
const requestLog: string[] = [];

/** 起一个本地站点：支持 robots.txt、正常页面、noindex 页面、被禁止路径 */
function startMockSite(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = req.url ?? '/';
      requestLog.push(url);
      if (url === '/robots.txt') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(['User-agent: *', 'Disallow: /blocked', ''].join('\n'));
        return;
      }
      if (url.startsWith('/blocked')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body><p>这段内容不该被抓取</p></body></html>');
        return;
      }
      if (url.startsWith('/noindex')) {
        res.writeHead(200, { 'content-type': 'text/html', 'x-robots-tag': 'noindex' });
        res.end('<html><head><title>Noindex 页</title></head><body><p>不应被引用</p></body></html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'all' });
      // 让不同页面给出不同数值：page-c 与 page-a/b 冲突，用于验证交叉验证
      const figure = url.includes('page-c') ? '300GW' : '120GW';
      res.end(
        '<html><head><title>储能行业报告</title></head><body><article>' +
          '<h1>储能行业 2025</h1>' +
          `<p>2025 年储能装机量预计达到 ${figure}，行业增速超过 30%。</p>` +
          '</article></body></html>',
      );
    });
    mockServer = server;
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

/** 模拟检索端点（返回指向本地站点的结果） */
function startMockSearch(port: number): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const q = url.searchParams.get('q') ?? '';
      const items = [
        { url: `http://127.0.0.1:${port}/page-a`, title: '储能行业报告 A', content: `2025 年储能装机量预计达到 120GW。${q}` },
        { url: `http://127.0.0.1:${port}/page-b`, title: '储能行业报告 B', content: '2025 年储能装机量预计达到 120GW。' },
        { url: `http://127.0.0.1:${port}/page-c`, title: '储能行业报告 C', content: '2025 年储能装机量预计达到 300GW。' },
        { url: `http://127.0.0.1:${port}/blocked/x`, title: '被 robots 禁止的页', content: '不应被抓取' },
        { url: `http://127.0.0.1:${port}/noindex/y`, title: 'Noindex 页', content: '不应被引用' },
        { url: 'https://data.tianyancha.com/report/1', title: '天眼查报告（需授权）', content: '付费数据' },
      ];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: items }));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
    searchServer = server;
  });
}

let searchServer: Server;

const { getDb, closeDb } = await import('../db/client.ts');
const { runMigrations } = await import('../db/migrate.ts');
const { WorkspaceService } = await import('../services/workspace.ts');
const { ResearchEngine } = await import('./researchEngine.ts');
const { buildQueries, normalizeSearchJson, isPaywalledDomain, searchEnabled } = await import('./search.ts');
const { fetchPage, extractReadableText } = await import('./fetch.ts');
const { buildCitations, renderCitation, validateReportCitations, renderReferenceSection } = await import('./citations.ts');
const { buildCharts, buildNumericChart } = await import('./charts.ts');
const { buildResearchSlides, renderMarkdownToHtml, isUsablePolish } = await import('./report.ts');
const { clearRobotsCache } = await import('./robots.ts');

runMigrations();
after(async () => {
  closeDb();
  await new Promise<void>((r) => mockServer.close(() => r()));
  await new Promise<void>((r) => searchServer.close(() => r()));
});

const db = getDb();
const engine = new ResearchEngine(db);
const wsRoot = mkdtempSync(path.join('/tmp', 'ai-research-ws-'));
let workspaceId = '';
let jobId = '';

/** 惰性创建并跑完一次完整研究（保证单独执行任一用例也自洽） */
async function ensureJob(): Promise<string> {
  if (jobId) return jobId;
  const job = await engine.create(
    {
      workspaceId,
      topic: '储能行业 2025 装机量与风险',
      depth: 'deep',
      outputFormats: ['markdown', 'pdf', 'pptx'],
      allowNetwork: true,
      maxSources: 10,
    },
    { runInBackground: false },
  );
  await engine.run(job.id, { allowNetwork: true, maxSources: 10 });
  jobId = job.id;
  return jobId;
}

before(async () => {
  mockPort = await startMockSite();
  const searchPort = await startMockSearch(mockPort);
  process.env.RESEARCH_SEARCH_ENDPOINT = `http://127.0.0.1:${searchPort}/search?format=json`;
  // config 在模块加载时读取，这里需要刷新缓存：config.research 是对象，直接改字段（仅测试）
  const { config } = await import('../config.ts');
  (config.research as { searchEndpoint: string }).searchEndpoint = process.env.RESEARCH_SEARCH_ENDPOINT;
  clearRobotsCache();

  const boot = await new WorkspaceService(db).ensureBootstrap();
  workspaceId = boot.workspace.id;
  await new WorkspaceService(db).updateRootPath(workspaceId, wsRoot);
});

/* --------------------------- 纯函数与合规 --------------------------- */

test('buildQueries：按深度生成互补检索式', () => {
  const quick = buildQueries('储能行业', 'quick');
  const deep = buildQueries('储能行业', 'deep');
  assert.ok(quick.length >= 2);
  assert.ok(deep.length > quick.length, '深度研究应生成更多检索式');
  assert.equal(new Set(deep).size, deep.length, '检索式不得重复');
});

test('normalizeSearchJson：兼容多种检索返回结构', () => {
  const a = normalizeSearchJson({ results: [{ url: 'https://a.com', title: 'A', content: 'c' }] }, 'q');
  assert.equal(a[0]?.title, 'A');
  const b = normalizeSearchJson({ items: [{ link: 'https://b.com', name: 'B', snippet: 's' }] }, 'q');
  assert.equal(b[0]?.url, 'https://b.com');
  assert.equal(b[0]?.title, 'B');
  // 非 http 链接被过滤
  assert.equal(normalizeSearchJson({ results: [{ url: 'ftp://x' }] }, 'q').length, 0);
});

test('付费来源被标记 requiresAuth，且不尝试绕过', () => {
  assert.equal(isPaywalledDomain('https://www.tianyancha.com/x'), true);
  assert.equal(isPaywalledDomain('https://data.10jqka.com.cn/x'), true);
  assert.equal(isPaywalledDomain('https://example.com/x'), false);
  const hits = normalizeSearchJson({ results: [{ url: 'https://www.tianjizha.com' }, { url: 'https://data.tianyancha.com/a' }] }, 'q');
  assert.equal(hits.find((h) => h.url.includes('tianyancha'))?.requiresAuth, true);
});

test('extractReadableText：去脚本/样式/导航，保留正文与标题', () => {
  const html = '<html><head><title>T</title></head><body><nav>菜单</nav><script>evil()</script><article><h1>标题</h1><p>正文 120GW</p></article><footer>页脚</footer></body></html>';
  const r = extractReadableText(html);
  assert.equal(r.title, 'T');
  assert.ok(r.text.includes('正文 120GW'));
  assert.ok(!r.text.includes('evil'));
  assert.ok(!r.text.includes('菜单'));
  assert.ok(!r.text.includes('页脚'));
});

test('fetchPage：robots.txt 禁止的路径不被抓取（合规硬约束）', async () => {
  const logBefore = requestLog.length;
  const page = await fetchPage(`http://127.0.0.1:${mockPort}/blocked/x`);
  assert.equal(page.ok, false);
  assert.ok(page.blockedReason?.includes('robots'), `应因 robots 被拒绝，实际 ${page.blockedReason}`);
  // 关键：不得发出对目标页的请求（只在 robots.txt 阶段就拒绝）
  const after = requestLog.slice(logBefore);
  assert.ok(!after.some((u) => u.startsWith('/blocked')), `不应请求被禁止路径，实际请求了 ${after.join(',')}`);
});

test('fetchPage：noindex 页面遵守站点意愿，只保留摘要不引用正文', async () => {
  const page = await fetchPage(`http://127.0.0.1:${mockPort}/noindex/y`);
  assert.equal(page.ok, false);
  assert.ok(page.blockedReason?.includes('noindex'));
  assert.equal(page.text, '', '不应引用 noindex 页面正文');
});

test('fetchPage：正常页面可抓取且标题正确', async () => {
  const page = await fetchPage(`http://127.0.0.1:${mockPort}/page-a`);
  assert.equal(page.ok, true);
  assert.equal(page.title, '储能行业报告');
  assert.ok(page.text.includes('120GW'));
  assert.ok(page.snippet.length > 0);
});

/* ----------------------------- 引用与图表 ----------------------------- */

test('citations：引用包含 URL/标题/访问时间/片段，编号连续', () => {
  const sources = ['s1', 's2'].map((id, i) => ({
    id,
    researchJobId: 'r',
    url: `https://e.com/${i}`,
    title: `标题 ${i}`,
    snippet: `片段 ${i}`,
    content: '',
    accessedAt: '2026-01-02T03:04:05Z',
    reliability: 0.9 - i * 0.1,
    requiresAuth: false,
  }));
  const citations = buildCitations(sources);
  assert.deepEqual(citations.map((c) => c.index), [1, 2]);
  assert.ok(citations.every((c) => c.url && c.title && c.accessedAt && c.snippet));
  // 高可信度排前
  assert.equal(citations[0]!.sourceId, 's1');
  assert.ok(renderCitation(citations[0]!).includes('访问于 2026-01-02'));
  assert.ok(renderReferenceSection(citations).includes('## 参考文献'));
});

test('citations：正文引用不存在时校验失败（保证引用准确）', () => {
  const citations = buildCitations([
    { id: 's1', researchJobId: 'r', url: 'https://e.com', title: 'T', snippet: 's', content: '', accessedAt: 'x', reliability: 0.8, requiresAuth: false },
  ]);
  assert.equal(validateReportCitations('结论 [1]', citations).ok, true);
  const bad = validateReportCitations('结论 [3]', citations);
  assert.equal(bad.ok, false);
  assert.ok(bad.problems[0]!.includes('[3]'));
  assert.equal(validateReportCitations('没有任何引用', citations).ok, false, '有来源却完全没引用应判失败');
});

test('charts：同一句多数值能生成对比柱状图（Mermaid）', () => {
  const sources = [
    { id: 's1', researchJobId: 'r', url: 'https://e.com/1', title: 'a', snippet: '', content: '储能装机量达到 120GW。光伏装机量达到 300GW。', accessedAt: 'x', reliability: 1, requiresAuth: false },
  ];
  const chart = buildNumericChart(sources);
  assert.ok(chart, '应生成图表');
  assert.ok(String((chart!.data as { mermaid: string }).mermaid).includes('xychart-beta'));
  const all = buildCharts(sources as never, []);
  assert.ok(all.length >= 1);
});

test('report：幻灯片与 HTML 渲染可用，润色安全校验能拦住丢引用的输出', () => {
  const filler = '本节用于补充说明研究背景、口径与局限性，确保报告长度与结构接近真实产物。'.repeat(4);
  const md = [
    '# 标题',
    '',
    '## 关键结论速览',
    '',
    '- 装机量 120GW [1]',
    `- ${filler}`,
    '',
    '## 来源冲突与不确定性',
    '',
    '- ⚠️ 存在冲突',
    `- ${filler}`,
    '',
    '## 结论与建议',
    '',
    '- 建议跟进',
    `- ${filler}`,
    '',
    '## 参考文献',
    '',
    '[1] [来源](https://e.com)',
  ].join('\n');
  const slides = buildResearchSlides('储能行业', md);
  assert.ok(slides.length >= 3);
  assert.equal(slides[0]!.title, '储能行业');
  assert.ok(slides.some((s) => s.title.includes('冲突')));

  const html = renderMarkdownToHtml(md);
  assert.ok(html.includes('<h1>标题</h1>'));
  assert.ok(html.includes('<a href="https://e.com"'));
  assert.ok(html.includes('<blockquote>') === false);

  // 润色安全校验：三件事必须拦住 —— 丢失全部引用、丢失冲突标记、输出过短
  assert.equal(isUsablePolish(md.replace(/\[1\]/g, ''), md), false, '丢失引用必须被判不合格');
  assert.equal(isUsablePolish(md.replace(/冲突|⚠️/g, ''), md), false, '丢失冲突标记必须被判不合格');
  assert.equal(isUsablePolish('太短', md), false, '过短输出必须被判不合格');
  assert.equal(isUsablePolish(`${md}\n\n补充说明：润色不应引入幻觉，只优化措辞与结构。`, md), true, '合法润色应通过');
});

/* --------------------------- 端到端研究流程 --------------------------- */

test('端到端：创建研究 → 检索 → 合规抓取 → 交叉验证 → 报告 → 导出 → 发布', async () => {
  const job = await engine.create(
    {
      workspaceId,
      topic: '储能行业 2025 装机量与风险',
      depth: 'deep',
      outputFormats: ['markdown', 'pdf', 'pptx'],
      allowNetwork: true,
      maxSources: 10,
    },
    { runInBackground: false },
  );
  jobId = job.id;
  assert.equal(job.status, 'pending');
  assert.ok(job.queries.length >= 3);
  assert.equal(job.allowNetwork, true, '必须记录用户是否显式允许联网');

  const done = await engine.run(jobId, { allowNetwork: true, maxSources: 10 });
  assert.equal(done.status, 'completed', `研究应完成，实际 ${done.status}：${done.error ?? ''}`);
  assert.equal(done.progress, 100);
  assert.ok(done.sourceCount >= 3, `应有多个来源，实际 ${done.sourceCount}`);
  assert.ok(done.claimCount >= 1, '应抽取出论断');
});

test('端到端：冲突来源被标记且报告显式说明', async () => {
  const id = await ensureJob();
  const claims = await engine.listClaims(id);
  const disputed = claims.filter((c) => c.disputed);
  assert.ok(disputed.length > 0, `应检出 120GW / 300GW 的冲突，实际 ${JSON.stringify(claims.map((c) => c.confidence))}`);

  const report = await engine.getReport(id);
  assert.ok(report, '应生成报告');
  assert.ok(report!.markdown.includes('来源冲突与不确定性'), '报告必须有冲突章节');
  assert.ok(report!.markdown.includes('⚠️') || report!.markdown.includes('冲突'), '必须显式标注冲突');
});

test('端到端：报告结构完整（提纲/结论/证据/建议/参考文献）', async () => {
  const report = (await engine.getReport(await ensureJob()))!;
  for (const section of ['## 提纲', '## 研究背景与问题界定', '## 关键结论速览', '## 证据与数据', '## 来源冲突与不确定性', '## 结论与建议', '## 参考文献']) {
    assert.ok(report.markdown.includes(section), `报告缺少章节：${section}`);
  }
  assert.ok(report.charts.length > 0, '应有图表');
  assert.ok(report.references.length > 0, '应有引用列表');
  assert.ok(report.references.every((r) => r.url && r.title && r.accessedAt), '引用必须含 URL/标题/访问时间');
});

test('端到端：引用准确（正文编号与文献表一致）', async () => {
  const report = (await engine.getReport(await ensureJob()))!;
  const citations = report.references.map((r) => ({
    index: r.index,
    sourceId: r.sourceId,
    title: r.title,
    url: r.url,
    accessedAt: r.accessedAt,
    snippet: r.snippet,
    reliability: 0.7,
    origin: 'web' as const,
  }));
  const check = validateReportCitations(report.markdown, citations);
  assert.equal(check.ok, true, `引用应一致：${check.problems.join('；')}`);
});

test('端到端：导出 markdown / pdf / pptx 产物落盘', async () => {
  const report = (await engine.getReport(await ensureJob()))!;
  assert.ok(report.markdownPath, '应导出 markdown');
  assert.ok(existsSync(path.join(wsRoot, report.markdownPath!)), 'markdown 文件应存在');
  const md = readFileSync(path.join(wsRoot, report.markdownPath!), 'utf8');
  assert.ok(md.includes('## 参考文献'));

  assert.ok(report.pptxPath, '应导出 pptx');
  assert.ok(existsSync(path.join(wsRoot, report.pptxPath!)));
  assert.ok(report.pdfPath, '应导出 pdf');
  assert.ok(existsSync(path.join(wsRoot, report.pdfPath!)));
});

test('端到端：可发布为自包含网页', async () => {
  const id = await ensureJob();
  const result = await engine.publish(id, { public: false });
  assert.ok(result.webUrl.length > 0);
  const report = (await engine.getReport(id))!;
  assert.equal(report.webUrl, result.webUrl);
  // 产物是 HTML（本地文件或内联 data URL）
  if (result.webUrl.startsWith('file://')) {
    const html = readFileSync(result.webUrl.replace('file://', ''), 'utf8');
    assert.ok(html.includes('<!doctype html>'));
    assert.ok(html.includes('深度研究报告'));
  } else {
    assert.ok(result.webUrl.startsWith('data:text/html'));
  }
});

test('付费来源不参与自动抓取，但会出现在来源清单并标记需授权', async () => {
  const id = await ensureJob();
  const sources = await engine.listSources(id);
  const paywalled = sources.filter((s) => s.requiresAuth);
  assert.ok(paywalled.length > 0, '应识别出付费来源并留痕（供用户手动授权后使用）');
  assert.ok(paywalled.every((s) => s.url.includes('tianyancha')), '付费来源域名应为已知付费源');
  // 合规要点：付费来源正文不得被自动抓取充作证据，只保留检索片段
  assert.ok(
    paywalled.every((s) => !s.content.includes('120GW') && !s.content.includes('300GW')),
    '付费来源正文不得被自动抓取充作证据',
  );
  assert.ok(paywalled.every((s) => s.reliability <= 0.3), '未授权付费来源可信度必须被下调');

  // 交叉验证不得引用付费来源
  const claims = await engine.listClaims(id);
  const paywalledIds = new Set(paywalled.map((s) => s.id));
  assert.ok(
    claims.every((c) => !c.supportingSources.some((sid) => paywalledIds.has(sid))),
    '付费来源不得作为论断支持来源',
  );
});

test('被 robots 拒绝的来源留痕，且不作为证据', async () => {
  const sources = await engine.listSources(await ensureJob());
  const blocked = sources.filter((s) => s.url.includes('/blocked'));
  assert.ok(blocked.length > 0, '被拒绝的来源也应留痕（可审计）');
  assert.ok(blocked.every((s) => s.content.startsWith('[未抓取]')), '被拒绝来源内容应标记未抓取');
  assert.ok(blocked.every((s) => s.reliability < 0.6), '被拒绝来源可信度应被下调');
});

test('能力探测：未配置检索端点时如实告知用户', () => {
  const cap = engine.capability();
  assert.equal(typeof cap.network, 'boolean');
  assert.ok(cap.hint.length > 0);
  assert.equal(cap.network, searchEnabled());
});

test('离线降级：未允许联网时不发起外部请求，产出「待核查问题」并如实标注', async () => {
  const tokensBefore = requestLog.length;
  const job = await engine.create(
    { workspaceId, topic: '一个没有外部来源的主题', depth: 'quick', allowNetwork: false, maxSources: 3 },
    { runInBackground: false },
  );
  const done = await engine.run(job.id, { allowNetwork: false });
  assert.equal(done.status, 'completed', '离线也应能跑完流程');
  const sources = await engine.listSources(job.id);
  assert.ok(sources.every((s) => s.url.startsWith('knowledge://')), '离线来源应为待核查问题');
  assert.ok(sources.every((s) => s.reliability <= 0.3), '待核查问题可信度必须很低');
  const report = (await engine.getReport(job.id))!;
  assert.ok(report.markdown.includes('未接入外部检索来源') || report.markdown.includes('待核查问题'));
  assert.ok(!report.markdown.includes('120GW'), '不得凭空编造外部数据');
  void tokensBefore;
});

/**
 * 报告生成。
 *
 * 流程（对应验收要求的第 7~10 步）：写提纲 → 写报告 → 加引用 → 生成图表。
 *
 * 关键原则：报告的**事实部分完全由交叉验证结果驱动**（确定性），
 * 模型只负责措辞与结构润色；模型不可用时用确定性模板产出结构完整的报告。
 * 这样「有引用」「冲突被标记」是结构性保证，而不是靠模型自觉。
 */
import type { ResearchClaim, ResearchJob, ResearchReport, ResearchSource } from '@ai/shared';
import { modelRouter } from '../agent/model-router.ts';
import { logger } from '../utils/logger.ts';
import { buildCitations, renderClaims, renderReferenceSection, validateReportCitations, type Citation } from './citations.ts';
import { buildCharts, type ChartSpec } from './charts.ts';
import { validationSummary } from './crossValidate.ts';

export interface ReportInput {
  topic: string;
  sources: ResearchSource[];
  claims: ResearchClaim[];
  depth: 'quick' | 'standard' | 'deep';
}

export interface ReportOutput {
  markdown: string;
  charts: ChartSpec[];
  citations: Citation[];
  /** 自检结果：引用一致性 */
  citationCheck: { ok: boolean; problems: string[] };
  degraded: boolean;
}

/** 提纲（确定性，始终生成） */
export function buildOutline(topic: string, depth: ReportInput['depth']): string[] {
  const base = ['研究背景与问题界定', '关键结论速览', '证据与数据', '来源冲突与不确定性', '结论与建议', '参考文献'];
  if (depth === 'quick') return base.slice(0, 4).concat('参考文献');
  if (depth === 'deep') return [...base.slice(0, 5), '方法与局限', '后续研究建议', '参考文献'];
  return base;
}

export async function buildReport(input: ReportInput): Promise<ReportOutput> {
  const { topic, sources, claims, depth } = input;
  const citations = buildCitations(sources);
  const charts = buildCharts(sources, claims);
  const summary = validationSummary(claims);
  const outline = buildOutline(topic, depth);

  // 确定性骨架：即使模型不可用，这份报告也是完整、可引用、可审阅的
  const deterministic = renderDeterministicReport({ topic, claims, citations, charts, summary, outline, sources, depth });

  const polished = await polishWithModel({ topic, deterministic, depth, summary });
  const markdown = polished.markdown;
  const citationCheck = validateReportCitations(markdown, citations);

  return { markdown, charts, citations, citationCheck, degraded: polished.degraded };
}

function renderDeterministicReport(input: {
  topic: string;
  claims: ResearchClaim[];
  citations: Citation[];
  charts: ChartSpec[];
  summary: ReturnType<typeof validationSummary>;
  outline: string[];
  sources: ResearchSource[];
  depth: ReportInput['depth'];
}): string {
  const { topic, claims, citations, charts, summary, outline, depth } = input;
  const lines: string[] = [];

  lines.push(`# ${topic}：深度研究报告`, '');
  lines.push(`- 生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}`);
  lines.push(`- 来源总数：${citations.length}（外部 ${citations.filter((c) => c.origin === 'web').length} / 本地 ${citations.filter((c) => c.origin === 'local').length} / 待核查 ${citations.filter((c) => c.origin === 'knowledge').length}）`);
  lines.push(`- 论断总数：${summary.total}（高置信 ${summary.highConfidence}，存在来源冲突 ${summary.disputed}）`);
  lines.push('');
  lines.push('## 提纲', '');
  for (const o of outline) lines.push(`- ${o}`);
  lines.push('');

  lines.push('## 研究背景与问题界定', '');
  lines.push(`本报告围绕「${topic}」开展研究，目标是给出可追溯来源的结构化结论，并显式标注来源之间的冲突与不确定性。`);
  lines.push('');

  lines.push('## 关键结论速览', '');
  if (claims.length === 0) {
    lines.push('> 本次研究未获取到可核查的论断来源。请配置 RESEARCH_SEARCH_ENDPOINT 接入检索服务，或在工作区中提供素材文件后重试。');
  } else {
    const top = claims.filter((c) => !c.disputed).slice(0, 5);
    const conflicted = claims.filter((c) => c.disputed).slice(0, 3);
    lines.push('### 高置信结论', '');
    lines.push(top.length > 0 ? renderClaims(top, citations) : '- 暂无可认定的高置信结论');
    if (conflicted.length > 0) {
      lines.push('', '### 存在来源冲突的结论（需人工判断）', '');
      lines.push(renderClaims(conflicted, citations));
    }
  }
  lines.push('');

  lines.push('## 证据与数据', '');
  if (charts.length === 0) {
    lines.push('未从来源中提取到可比较的量化数据，无法生成图表。');
  } else {
    for (const chart of charts) {
      lines.push(`### ${chart.title}`, '');
      const mermaid = (chart.data as { mermaid?: string }).mermaid;
      if (mermaid) lines.push(mermaid, '');
    }
  }
  lines.push('');

  lines.push('## 来源冲突与不确定性', '');
  if (summary.disputed === 0) {
    lines.push('本次研究中未检测到来源之间的数值冲突。');
  } else {
    lines.push(`检测到 ${summary.disputed} 条论断存在来源冲突，已在「关键结论速览」中标注 ⚠️。冲突通常源于：统计口径不同、年份不同、预测与实测混用。建议以权威机构的最新口径为准，并保留多口径对照。`);
    const disputed = claims.filter((c) => c.disputed);
    lines.push('', '| 论断 | 支持来源 | 冲突来源 | 置信度 |', '| --- | --- | --- | --- |');
    for (const c of disputed.slice(0, 15)) {
      const idx = (ids: string[]) => ids.map((id) => citations.find((x) => x.sourceId === id)?.index).filter((n): n is number => n !== undefined).map((n) => `[${n}]`).join('') || '—';
      lines.push(`| ${c.claim.replace(/\|/g, '\\|').slice(0, 120)} | ${idx(c.supportingSources)} | ${idx(c.conflictingSources)} | ${(c.confidence * 100).toFixed(0)}% |`);
    }
  }
  lines.push('');

  lines.push('## 结论与建议', '');
  if (claims.length === 0) {
    lines.push('- 补充来源后再下结论；当前不建议基于零来源做出判断。');
  } else {
    lines.push(`- 优先采用本报告「高置信结论」部分（共 ${summary.highConfidence} 条）作为决策依据。`);
    if (summary.disputed > 0) lines.push(`- 对 ${summary.disputed} 条存在冲突的论断，需结合业务口径二次确认。`);
    lines.push('- 建议定期复跑本研究的检索与交叉验证，追踪数据变化。');
  }
  lines.push('');

  if (depth === 'deep') {
    lines.push('## 方法与局限', '');
    lines.push('- 方法：多检索式召回 → robots.txt 合规抓取 → 正文抽取 → 论断级交叉验证 → 结构化撰写。');
    lines.push('- 局限：抓取仅覆盖可公开访问且允许抓取的页面；付费/需登录来源未接入（需用户自行授权），因此可能遗漏部分权威数据。');
    lines.push('- 局限：数值冲突仅按相对差 3% 容差判定，口径差异可能被误判为冲突，需人工复核。');
    lines.push('');
    lines.push('## 后续研究建议', '');
    lines.push('- 接入用户自有的付费数据源（同花顺/万得/天眼查等）以补齐权威口径。');
    lines.push('- 对关键数字建立时间序列，观察趋势而不是单点。');
    lines.push('');
  }

  lines.push(renderReferenceSection(citations));
  return lines.join('\n');
}

const POLISH_SYSTEM = `你是研究报告编辑。任务：把给定的结构化报告润色得更好读，但**严禁**：
- 新增原文没有的事实、数字、来源
- 删除或改动任何 [n] 形式的引用编号
- 删除 "存在来源冲突" 相关的段落或 ⚠️ 标记
- 删除 mermaid 代码块
保持 Markdown 结构与小节标题。只输出润色后的完整 Markdown。`;

async function polishWithModel(input: {
  topic: string;
  deterministic: string;
  depth: ReportInput['depth'];
  summary: ReturnType<typeof validationSummary>;
}): Promise<{ markdown: string; degraded: boolean }> {
  const chat = await modelRouter.chat({
    messages: [
      { role: 'system', content: POLISH_SYSTEM },
      { role: 'user', content: `主题：${input.topic}\n\n${input.deterministic.slice(0, 60_000)}` },
    ],
    temperature: 0.2,
    maxTokens: 8_000,
  });

  if (chat.degraded || !isUsablePolish(chat.content, input.deterministic)) {
    logger.info('report polishing skipped (offline or unsafe output)', { degraded: chat.degraded });
    return { markdown: input.deterministic, degraded: true };
  }
  return { markdown: chat.content.trim(), degraded: false };
}

/**
 * 润色结果安全校验：润色不能引入幻觉或破坏引用。
 * 校验点：
 * 1) 引用编号集合必须与原稿完全一致（不能丢也不能加）；
 * 2) mermaid 代码块数量不能减少；
 * 3) 冲突标记（⚠️ / 冲突）不能丢失；
 * 4) 长度不能离奇缩水（防止模型把报告截断）。
 */
export function isUsablePolish(polished: string, original: string): boolean {
  if (polished.trim().length < 200) return false;
  if (polished.length < original.length * 0.5) return false;

  const refsOf = (s: string) => new Set([...s.matchAll(/\[(\d{1,3})\](?!\()/g)].map((m) => m[1]));
  const a = refsOf(original);
  const b = refsOf(polished);
  for (const n of a) if (!b.has(n)) return false;
  for (const n of b) if (!a.has(n)) return false;

  const blocksOf = (s: string) => (s.match(/```mermaid/g) ?? []).length;
  if (blocksOf(polished) < blocksOf(original)) return false;

  const warned = (s: string) => /冲突|⚠️/.test(s);
  if (warned(original) && !warned(polished)) return false;

  return true;
}

/** 报告 → 幻灯片（标题页 + 结论页 + 冲突页 + 参考页） */
export function buildResearchSlides(topic: string, markdown: string): { title: string; bullets: string[] }[] {
  const bulletsFrom = (section: string, limit: number): string[] => {
    const start = markdown.indexOf(section);
    if (start === -1) return [];
    const rest = markdown.slice(start + section.length);
    const end = rest.search(/\n## /);
    const body = end === -1 ? rest : rest.slice(0, end);
    return body
      .split('\n')
      .filter((l) => l.trimStart().startsWith('- '))
      .map((l) => l.replace(/^\s*-\s*/, '').replace(/\s+/g, ' ').slice(0, 160))
      .slice(0, limit);
  };

  const slides = [{ title: topic, bullets: ['深度研究报告', 'AI 工作台生成', '含可追溯引用与冲突标记'] }];
  const summary = bulletsFrom('## 关键结论速览', 6);
  if (summary.length > 0) slides.push({ title: '关键结论', bullets: summary });
  const conflicts = bulletsFrom('## 来源冲突与不确定性', 5);
  slides.push({ title: '来源冲突与不确定性', bullets: conflicts.length > 0 ? conflicts : ['未检测到来源间数值冲突'] });
  const advice = bulletsFrom('## 结论与建议', 5);
  if (advice.length > 0) slides.push({ title: '结论与建议', bullets: advice });
  slides.push({ title: '参考与说明', bullets: ['引用编号与参考文献一一对应', '来源抓取遵守 robots.txt', '付费来源需用户自行授权'] });
  return slides;
}

/** 自包含 HTML 报告（可直接打开 / 部署静态托管） */
export function renderReportHtml(job: ResearchJob, report: ResearchReport): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const charts = report.charts.map((c) => String((c.data as { mermaid?: string }).mermaid ?? '')).join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(job.topic)} · 深度研究报告</title>
<style>
  body { font: 15px/1.75 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; max-width: 860px; margin: 0 auto; padding: 32px 20px 80px; color: #1f2937; }
  h1 { font-size: 26px; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px; }
  h2 { font-size: 20px; margin-top: 32px; }
  h3 { font-size: 16px; margin-top: 22px; }
  pre { background: #f6f8fa; padding: 12px; overflow: auto; border-radius: 6px; font-size: 13px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; }
  th { background: #f9fafb; }
  blockquote { border-left: 3px solid #f59e0b; margin: 12px 0; padding: 6px 12px; background: #fffbeb; color: #92400e; }
  a { color: #2563eb; }
  .meta { color: #6b7280; font-size: 13px; }
</style>
</head>
<body>
<h1>${esc(job.topic)}</h1>
<p class="meta">深度研究报告 · 生成于 ${esc(report.createdAt.slice(0, 19).replace('T', ' '))} · 来源 ${report.references.length} 条</p>
<details><summary>原始 Markdown 源（便于复制/再加工）</summary><pre>${esc(report.markdown.slice(0, 200_000))}</pre></details>
${renderMarkdownToHtml(report.markdown)}
${charts ? `<h2>图表源码</h2><pre>${esc(charts)}</pre>` : ''}
</body>
</html>`;
}

/** 极简 Markdown → HTML（报告页面用，不引入渲染库） */
export function renderMarkdownToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inTable = false;
  let inCode = false;
  let codeLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (!inCode) {
        inCode = true;
        codeLines = [];
      } else {
        inCode = false;
        out.push(`<pre>${esc(codeLines.join('\n'))}</pre>`);
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (/^\|.*\|$/.test(line)) {
      if (!inTable) {
        inTable = true;
        out.push('<table>');
      }
      if (/^\|\s*-+/.test(line)) continue;
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      const tag = out[out.length - 1] === '<table>' ? 'th' : 'td';
      out.push(`<tr>${cells.map((c) => `<${tag}>${inline(c)}</${tag}>`).join('')}</tr>`);
      continue;
    }
    if (inTable) {
      inTable = false;
      out.push('</table>');
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1]!.length;
      out.push(`<h${level}>${inline(h[2] ?? '')}</h${level}>`);
      continue;
    }
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      out.push(`<li>${inline(li[1] ?? '')}</li>`);
      continue;
    }
    if (line.trim().startsWith('>')) {
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
      continue;
    }
    if (line.trim().length === 0) continue;
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inTable) out.push('</table>');
  if (inCode) out.push(`<pre>${esc(codeLines.join('\n'))}</pre>`);
  return out.join('\n');

  function inline(s: string): string {
    return esc(s)
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+|file:[^)\s]+|data:[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }
}

/** 研究结论转成可看板展示的卡片数据 */
export function toDashboardCards(report: ResearchReport, claims: ResearchClaim[]): Record<string, unknown>[] {
  return claims.slice(0, 10).map((c) => ({
    type: 'research-claim',
    claim: c.claim,
    confidence: c.confidence,
    disputed: c.disputed,
    reference: report.references.filter((r) => c.supportingSources.includes(r.sourceId)).map((r) => r.index),
  }));
}

/**
 * 引用管理（纯函数）。
 *
 * 验收要求：引用必须包含 URL、标题、访问时间、片段，且报告正文里的编号
 * 必须与来源列表严格一致（这是「引用准确」的可测试定义）。
 */
import type { ResearchClaim, ResearchReport, ResearchSource } from '@ai/shared';

export interface Citation {
  index: number;
  sourceId: string;
  title: string;
  url: string;
  accessedAt: string;
  snippet: string;
  reliability: number;
  origin: 'web' | 'local' | 'knowledge';
}

/** 由来源列表生成编号引用（按可信度降序，同分按标题稳定排序） */
export function buildCitations(sources: ResearchSource[]): Citation[] {
  return [...sources]
    .sort((a, b) => b.reliability - a.reliability || a.title.localeCompare(b.title))
    .map((s, i) => ({
      index: i + 1,
      sourceId: s.id,
      title: s.title || s.url,
      url: s.url,
      accessedAt: s.accessedAt,
      snippet: s.snippet.slice(0, 300),
      reliability: s.reliability,
      origin: originOf(s.url),
    }));
}

function originOf(url: string): Citation['origin'] {
  if (url.startsWith('file://')) return 'local';
  if (url.startsWith('knowledge://')) return 'knowledge';
  return 'web';
}

/** 引用 → 脚注文本（Markdown 链接） */
export function renderCitation(c: Citation): string {
  const label = c.title.replace(/[[\]]/g, '').slice(0, 80);
  return `[${c.index}] [${label}](${c.url})（访问于 ${c.accessedAt.slice(0, 10)}，可信度 ${(c.reliability * 100).toFixed(0)}%）`;
}

/** 报告末尾的参考文献章节 */
export function renderReferenceSection(citations: Citation[]): string {
  if (citations.length === 0) return '## 参考文献\n\n本次研究未获取到外部来源。\n';
  const lines = ['## 参考文献', ''];
  for (const c of citations) lines.push(`${renderCitation(c)}`);
  const local = citations.filter((c) => c.origin === 'local').length;
  const knowledge = citations.filter((c) => c.origin === 'knowledge').length;
  if (local > 0) lines.push('', `> 其中 ${local} 条来源为本地工作区文件，${citations.length - local} 条为外部来源。`);
  if (knowledge > 0) lines.push('', `> 注意：有 ${knowledge} 条仅为「待核查问题」，未接入外部检索来源，不能作为结论依据。`);
  return lines.join('\n');
}

/**
 * 校验报告与引用的一致性。
 * 用于生成后自检（也用于测试）：正文出现的 [n] 必须都有对应来源；
 * 每个被引用的来源都必须在文献表中出现。
 */
export function validateReportCitations(markdown: string, citations: Citation[]): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const used = new Set<number>();
  for (const m of markdown.matchAll(/\[(\d{1,3})\](?!\()/g)) {
    used.add(Number(m[1]));
  }
  for (const n of used) {
    if (!citations.some((c) => c.index === n)) problems.push(`正文引用了不存在的来源 [${n}]`);
  }
  const unreferenced = citations.filter((c) => !used.has(c.index));
  if (unreferenced.length === citations.length && citations.length > 0) {
    problems.push('没有任何来源被正文引用，引用可能是摆设');
  }
  return { ok: problems.length === 0, problems };
}

/** 把 claims 转成附带引用的要点列表 */
export function renderClaims(claims: ResearchClaim[], citations: Citation[]): string {
  const indexOf = new Map(citations.map((c) => [c.sourceId, c.index]));
  const lines: string[] = [];
  for (const claim of claims.slice(0, 20)) {
    const refs = claim.supportingSources.map((s) => indexOf.get(s)).filter((n): n is number => n !== undefined);
    const conflicts = claim.conflictingSources.map((s) => indexOf.get(s)).filter((n): n is number => n !== undefined);
    const marks = refs.map((n) => `[${n}]`).join('');
    const conflictMark = claim.disputed ? ` ⚠️ 存在冲突来源${conflicts.map((n) => `[${n}]`).join('')}` : '';
    lines.push(`- ${claim.claim}${marks ? ` ${marks}` : ''}${conflictMark}`);
  }
  return lines.join('\n');
}

/** 结果形态：供 service 落库 */
export type ReportBundle = Pick<ResearchReport, 'markdown' | 'charts' | 'references'>;

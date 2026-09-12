/**
 * 检索（search）。
 *
 * 合规与可用性：
 * - 不内置任何第三方搜索 API Key；用户通过 RESEARCH_SEARCH_ENDPOINT 接入
 *   自建检索服务（如 SearXNG）或自己的搜索网关（兼容返回 items/url/title/snippet 的 JSON）。
 * - 未配置时不联网，而是使用**确定性本地检索**：从工作区文件与已有知识中找相关片段。
 *   这样「深度研究」在没有网络的环境下依然可跑通全流程并可测试，且产出如实标注来源类型。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.ts';
import { logger } from '../utils/logger.ts';
import { safeJoin } from '../tools/fs-tools.ts';

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  /** 来源类型：web=真实联网；local=工作区文件；knowledge=内置知识骨架 */
  origin: 'web' | 'local' | 'knowledge';
  /** 是否需要用户授权（付费/登录类来源） */
  requiresAuth: boolean;
}

export interface SearchOptions {
  maxResults?: number;
  /** 工作区根目录（本地检索用） */
  workspaceRoot?: string | null;
  /** 本地检索的候选文件相对路径 */
  localFiles?: string[];
}

export function searchEnabled(): boolean {
  return config.research.searchEndpoint.trim().length > 0;
}

/** 生成检索式：把主题拆成多个互补查询，提高召回覆盖 */
export function buildQueries(topic: string, depth: 'quick' | 'standard' | 'deep' = 'standard'): string[] {
  const base = topic.trim().replace(/\s+/g, ' ');
  const variations = depth === 'quick' ? 1 : depth === 'standard' ? 2 : 3;
  const suffixes = ['市场规模 增长率', '政策 监管 合规', '主要企业 竞争格局', '风险 挑战 不确定性', '技术趋势', '数据 统计 指标'];
  const queries = [base];
  for (let i = 0; i < variations; i++) {
    const suffix = suffixes[i % suffixes.length]!;
    queries.push(`${base} ${suffix}`);
  }
  // 深度研究额外加「数据来源」与「对比」两类
  if (depth === 'deep') {
    queries.push(`${base} 数据来源 权威报告`, `${base} 对比 优劣势`);
  }
  return [...new Set(queries)];
}

/**
 * 执行检索。
 * @param allowNetwork 用户必须显式允许联网（默认 false），不允许时自动降级为本地检索
 */
export async function search(queries: string[], opts: SearchOptions & { allowNetwork?: boolean } = {}): Promise<SearchHit[]> {
  const maxResults = opts.maxResults ?? 20;
  const allowNetwork = opts.allowNetwork === true && searchEnabled();

  if (allowNetwork) {
    const web = await searchWeb(queries, maxResults);
    if (web.length > 0) return dedupe(web).slice(0, maxResults);
    logger.warn('web search returned no results, falling back to local');
  }

  return searchLocal(queries, opts, maxResults);
}

/** 调用用户配置的检索端点（兼容 OpenAI 之外的通用 JSON 结构） */
async function searchWeb(queries: string[], maxResults: number): Promise<SearchHit[]> {
  const endpoint = config.research.searchEndpoint.replace(/\/$/, '');
  const out: SearchHit[] = [];
  for (const q of queries) {
    try {
      const url = new URL(endpoint);
      if (!url.searchParams.has('q')) url.searchParams.set('q', q);
      if (!url.searchParams.has('format')) url.searchParams.set('format', 'json');
      const res = await fetch(url.toString(), {
        headers: {
          accept: 'application/json',
          'user-agent': config.research.userAgent,
          ...(config.research.searchApiKey ? { authorization: `Bearer ${config.research.searchApiKey}` } : {}),
        },
        signal: AbortSignal.timeout(config.research.fetchTimeoutMs),
      });
      if (!res.ok) {
        logger.warn('search endpoint returned non-ok', { status: res.status, query: q });
        continue;
      }
      const json = (await res.json()) as unknown;
      out.push(...normalizeSearchJson(json, q));
      if (out.length >= maxResults) break;
    } catch (e) {
      logger.warn('search request failed', { query: q, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/** 兼容常见检索返回结构：{results:[]} / {items:[]} / SearXNG {results:[{url,title,content}]} */
export function normalizeSearchJson(json: unknown, query: string): SearchHit[] {
  const pickArray = (v: unknown): unknown[] => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      for (const key of ['results', 'items', 'data', 'hits', 'organic']) {
        if (Array.isArray(obj[key])) return obj[key] as unknown[];
      }
    }
    return [];
  };

  return pickArray(json)
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    .map((r) => {
      const url = String(r.url ?? r.link ?? r.href ?? '');
      const title = String(r.title ?? r.name ?? url);
      const snippet = String(r.snippet ?? r.content ?? r.description ?? r.text ?? '').slice(0, 1200);
      return {
        url,
        title,
        snippet: snippet || `（检索式：${query}）`,
        origin: 'web' as const,
        // 付费/登录类来源由域名判定，安装/调用前强制用户授权
        requiresAuth: isPaywalledDomain(url),
      };
    })
    .filter((h) => h.url.startsWith('http'));
}

/** 常见付费/需登录数据源：默认标记 needsAuth，不尝试绕过 */
const PAYWALL_PATTERNS = [
  /10jqka\.com\.cn/i,
  /tianyancha\.com/i,
  /wind\.com\.cn/i,
  /hs\.cn/i,
  /spglobal\.com/i,
  /imf\.org/i,
  /pkulaw\.com/i,
  /cnki\.net/i,
  /wanfangdata\.com/i,
  /ieee\.org/i,
  /sciencedirect\.com/i,
  /jstor\.org/i,
];

export function isPaywalledDomain(url: string): boolean {
  return PAYWALL_PATTERNS.some((re) => re.test(url));
}

/**
 * 本地检索（离线可用）：在工作区文件中做关键词/向量命中，产出可溯源的来源。
 * 明确标注 origin='local'，不冒充网络来源。
 */
async function searchLocal(queries: string[], opts: SearchOptions, maxResults: number): Promise<SearchHit[]> {
  const { localFiles, workspaceRoot } = opts;
  if (!workspaceRoot || !localFiles || localFiles.length === 0) {
    return knowledgeSkeleton(queries, maxResults);
  }

  const { recall } = await import('../context/vectorRecall.ts');
  const hits: SearchHit[] = [];
  for (const rel of localFiles.slice(0, 50)) {
    try {
      const abs = safeJoin(workspaceRoot, rel);
      const buf = await readFile(abs);
      const text = buf.subarray(0, 200_000).toString('utf8');
      // 按段落切块，便于定位
      const blocks = text.split(/\n{2,}/).filter((b) => b.trim().length > 0);
      const candidates = blocks.map((b, i) => ({
        id: `${rel}#${i}`,
        kind: 'file' as const,
        text: b,
        createdAt: new Date().toISOString(),
      }));
      for (const q of queries) {
        for (const hit of recall(q, candidates, { topK: 3, minScore: 0.08, halfLifeHours: 0 })) {
          hits.push({
            url: `file://${rel}${hit.id.split('#')[1] ? `#p${hit.id.split('#')[1]}` : ''}`,
            title: `${path.basename(rel)} 片段 ${hit.id.split('#')[1] ?? '0'}`,
            snippet: hit.text.slice(0, 800),
            origin: 'local',
            requiresAuth: false,
          });
        }
      }
    } catch (e) {
      logger.debug('local search file skipped', { file: rel, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return dedupe(hits).slice(0, maxResults);
}

/**
 * 内置知识骨架：完全没有外部与本地素材时的兜底。
 * 关键：明确标注 origin='knowledge'，报告里会写明「未接入外部来源」，
 * 绝不把兜底内容伪装成检索结果。
 */
function knowledgeSkeleton(queries: string[], maxResults: number): SearchHit[] {
  return queries.slice(0, maxResults).map((q, i) => ({
    url: `knowledge://query/${i + 1}`,
    title: `待核查问题：${q}`,
    snippet: `尚未接入外部检索来源。请配置 RESEARCH_SEARCH_ENDPOINT（如自建 SearXNG）或在「工作区文件」中提供素材，系统随后会基于来源生成可溯源的报告。当前条目仅为待核查问题清单。`,
    origin: 'knowledge',
    requiresAuth: false,
  }));
}

function dedupe(hits: SearchHit[]): SearchHit[] {
  const map = new Map<string, SearchHit>();
  for (const h of hits) {
    const key = h.url.split('#')[0]! + '|' + h.title;
    const prev = map.get(key);
    if (!prev || h.snippet.length > prev.snippet.length) map.set(key, h);
  }
  return [...map.values()];
}

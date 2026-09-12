/**
 * 抓取（fetch）。
 *
 * 合规：
 * - 抓取前必须通过 robots.txt 检查（见 ./robots.ts），拒绝即不抓取；
 * - 支持 RoboMeta（noindex/nofollow）与 X-Robots-Tag 识别，命中即只保留摘要；
 * - 限流（并发 + 每域最小间隔），避免对站点造成压力；
 * - 有超时与响应体大小上限，防内存与挂死。
 *
 * 落地能力：抽取正文（去脚本/样式/导航），产出可引用的 snippet 与全文片段。
 */
import { config } from '../config.ts';
import { logger } from '../utils/logger.ts';
import { checkRobots } from './robots.ts';

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  snippet: string;
  ok: boolean;
  /** 被 robots 或元标签拒绝时说明原因 */
  blockedReason?: string;
  status?: number;
  bytes: number;
}

const lastAccessByHost = new Map<string, number>();
const MIN_INTERVAL_MS = 800;

async function throttle(host: string): Promise<void> {
  const last = lastAccessByHost.get(host) ?? 0;
  const wait = MIN_INTERVAL_MS - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastAccessByHost.set(host, Date.now());
}

/** 从 HTML 抽取可读正文（去脚本/样式/导航/页脚） */
export function extractReadableText(html: string): { title: string; text: string; noindex: boolean } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  const title = stripTags(titleMatch?.[1] ?? '').trim().slice(0, 200);
  const metaRobots = [...html.matchAll(/<meta[^>]+name=["']?robots["']?[^>]+content=["']([^"']+)["']/gi)]
    .map((m) => (m[1] ?? '').toLowerCase())
    .join(',');
  const noindex = metaRobots.includes('noindex');

  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ');

  // 优先主内容容器
  const article = body.match(/<(article|main)[^>]*>([\s\S]*?)<\/\1>/i);
  if (article?.[2]) body = article[2];

  body = body
    .replace(/<\/(p|div|section|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');

  const text = stripTags(body)
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((l) => l.length > 0)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text, noindex };
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&[a-z]+;/gi, ' ');
}

/** 抓取单个页面（含 robots 合规检查） */
export async function fetchPage(url: string): Promise<FetchedPage> {
  const decision = await checkRobots(url);
  if (!decision.allowed) {
    logger.info('fetch blocked by robots.txt', { url, reason: decision.reason });
    return { url, title: '', text: '', snippet: '', ok: false, blockedReason: decision.reason, bytes: 0 };
  }

  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    return { url, title: '', text: '', snippet: '', ok: false, blockedReason: '非法 URL', bytes: 0 };
  }
  await throttle(host);

  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': config.research.userAgent,
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(config.research.fetchTimeoutMs),
      redirect: 'follow',
    });
    const xRobots = (res.headers.get('x-robots-tag') ?? '').toLowerCase();
    const contentType = res.headers.get('content-type') ?? '';
    const buf = Buffer.from(await res.arrayBuffer());
    const truncated = buf.length > config.research.maxBytesPerPage;
    const limited = truncated ? buf.subarray(0, config.research.maxBytesPerPage) : buf;
    const raw = limited.toString('utf8');

    const isHtml = contentType.includes('html') || raw.trimStart().startsWith('<');
    const parsed = isHtml ? extractReadableText(raw) : { title: url, text: raw.trim(), noindex: false };

    if (!res.ok) {
      return {
        url,
        title: parsed.title || url,
        text: '',
        snippet: '',
        ok: false,
        blockedReason: `HTTP ${res.status}`,
        status: res.status,
        bytes: limited.length,
      };
    }
    if (xRobots.includes('noindex') || parsed.noindex) {
      return {
        url,
        title: parsed.title || url,
        text: '',
        snippet: parsed.text.slice(0, 300),
        ok: false,
        blockedReason: '页面声明 noindex：遵守站点意愿，仅保留摘要不引用正文',
        status: res.status,
        bytes: limited.length,
      };
    }

    return {
      url,
      title: parsed.title || url,
      text: parsed.text.slice(0, 100_000),
      snippet: parsed.text.slice(0, 800),
      ok: true,
      status: res.status,
      bytes: limited.length,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn('fetch failed', { url, error: msg });
    return { url, title: '', text: '', snippet: '', ok: false, blockedReason: `抓取失败: ${msg}`, bytes: 0 };
  }
}

/** 并发受限的批量抓取 */
export async function fetchAll(urls: string[], concurrency = config.research.fetchConcurrency): Promise<FetchedPage[]> {
  const out: FetchedPage[] = [];
  const queue = [...urls];
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, 8)) }, async () => {
    for (;;) {
      const url = queue.shift();
      if (!url) return;
      out.push(await fetchPage(url));
    }
  });
  await Promise.all(workers);
  return out;
}

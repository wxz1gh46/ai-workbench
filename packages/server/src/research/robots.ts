/**
 * robots.txt 合规检查。
 *
 * 合规硬约束（用户明确要求「不得绕过官方限制」）：
 * - 抓取前必须检查 robots.txt；
 * - Disallow 命中即拒绝抓取，且**不允许**通过配置关闭（config.research.respectRobots 恒为 true）；
 * - 检查失败（网络错误）按「保守拒绝」处理，除非明确得到 404（表示无 robots 限制）。
 */
import { config } from '../config.ts';
import { logger } from '../utils/logger.ts';

export interface RobotsDecision {
  allowed: boolean;
  reason: string;
  /** robots.txt 内容（截断），便于审计留痕 */
  snippet?: string;
}

interface CacheEntry {
  rules: { allow: string[]; disallow: string[] };
  fetchedAt: number;
  /** 是否成功获取到 robots.txt */
  fetched: boolean;
}

const CACHE_TTL_MS = 30 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

/** 解析 robots.txt 中与目标 UA 相关的规则（支持 User-agent: * 与指定 UA） */
export function parseRobots(text: string, userAgent: string): { allow: string[]; disallow: string[] } {
  const lines = text.split(/\r?\n/);
  const uaToken = userAgent.split('/')[0]!.toLowerCase();
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  let current: { agents: string[]; allow: string[]; disallow: string[] } | null = null;

  for (const raw of lines) {
    const line = raw.split('#')[0]!.trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(':');
    const key = (rawKey ?? '').trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      if (!current || current.agents.length === 0) {
        current = { agents: [value.toLowerCase()], allow: [], disallow: [] };
        groups.push(current);
      } else if (current.allow.length === 0 && current.disallow.length === 0) {
        current.agents.push(value.toLowerCase());
      } else {
        current = { agents: [value.toLowerCase()], allow: [], disallow: [] };
        groups.push(current);
      }
    } else if (current && (key === 'allow' || key === 'disallow')) {
      if (value) current[key].push(value);
    }
  }

  // 优先级：精确匹配 UA > *
  const exact = groups.filter((g) => g.agents.some((a) => a !== '*' && (a.includes(uaToken) || uaToken.includes(a))));
  const wildcard = groups.filter((g) => g.agents.includes('*'));
  const applicable = exact.length > 0 ? exact : wildcard;

  return {
    allow: applicable.flatMap((g) => g.allow),
    disallow: applicable.flatMap((g) => g.disallow),
  };
}

/** 路径是否被 rules 允许。最长匹配优先（robots 规范），Allow 与 Disallow 等长时 Allow 胜出。 */
export function isPathAllowed(pathname: string, rules: { allow: string[]; disallow: string[] }): boolean {
  const matchLen = (patterns: string[]) =>
    patterns
      .filter((p) => p === '/' || pathname.startsWith(p.replace(/\*$/, '')))
      .reduce((max, p) => Math.max(max, p.length), -1);

  const allowLen = matchLen(rules.allow);
  const disallowLen = matchLen(rules.disallow);
  if (disallowLen === -1) return true;
  if (allowLen === -1) return false;
  return allowLen >= disallowLen;
}

/** 检查是否允许抓取该 URL */
export async function checkRobots(targetUrl: string): Promise<RobotsDecision> {
  if (!config.research.respectRobots) {
    // 该分支在代码层不可达（配置为常量 true），保留以防未来误改
    return { allowed: false, reason: 'robots.txt 检查被禁用，出于合规默认拒绝抓取' };
  }

  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return { allowed: false, reason: `非法 URL: ${targetUrl}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: `不支持的协议: ${url.protocol}` };
  }

  const origin = url.origin;
  const cached = cache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    const rules = cached.rules;
    return isPathAllowed(url.pathname, rules)
      ? { allowed: true, reason: 'robots.txt 未禁止该路径' }
      : { allowed: false, reason: 'robots.txt 禁止抓取该路径' };
  }

  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { 'user-agent': config.research.userAgent, accept: 'text/plain' },
      signal: AbortSignal.timeout(8_000),
      redirect: 'follow',
    });
    if (res.status === 404 || res.status === 410) {
      const rules = { allow: [], disallow: [] };
      cache.set(origin, { rules, fetchedAt: Date.now(), fetched: false });
      return { allowed: true, reason: '站点无 robots.txt（404），按允许处理' };
    }
    if (!res.ok) {
      return { allowed: false, reason: `robots.txt 返回 ${res.status}，保守拒绝抓取` };
    }
    const text = (await res.text()).slice(0, 100_000);
    const rules = parseRobots(text, config.research.userAgent);
    cache.set(origin, { rules, fetchedAt: Date.now(), fetched: true });
    return isPathAllowed(url.pathname, rules)
      ? { allowed: true, reason: 'robots.txt 未禁止该路径', snippet: text.slice(0, 500) }
      : { allowed: false, reason: 'robots.txt 禁止抓取该路径', snippet: text.slice(0, 500) };
  } catch (e) {
    logger.warn('robots.txt check failed, conservatively denying', {
      origin,
      error: e instanceof Error ? e.message : String(e),
    });
    return { allowed: false, reason: `robots.txt 检查失败（网络错误），保守拒绝抓取: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** 供测试与运维清理缓存 */
export function clearRobotsCache(): void {
  cache.clear();
}

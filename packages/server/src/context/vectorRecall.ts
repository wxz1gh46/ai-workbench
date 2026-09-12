/**
 * 向量召回（纯函数 + 存储无关）。
 *
 * 为什么自研而不是直接上 LanceDB：
 * - Phase 2 验收要求「有检索、有溯源」，本地 SQLite + 内存向量在百万 token 量级仍可接受；
 * - 保持零外部依赖，离线可跑、可单测；
 * - 接口设计成 `RecallIndex`，后续替换为 LanceDB/Qdrant 只需换实现。
 *
 * 打分 = 余弦相似度 * 时间衰减 * 重要度，并强制返回来源 ID（溯源的硬要求）。
 */
import type { Message } from '@ai/shared';
import { cosineSimilarity, localEmbed } from './embedding.ts';
import { estimateTokens } from '../agent/tokens.ts';

export interface RecallCandidate {
  id: string;
  text: string;
  /** 预先算好的向量；缺省时用 text 现场计算（兼容历史数据未落库 embedding 的情况） */
  vector?: number[] | null;
  /** ISO 时间，用于时间衰减 */
  createdAt: string;
  importance?: number;
  kind: 'message' | 'fact' | 'file' | 'summary';
}

export interface RecallHit {
  id: string;
  kind: RecallCandidate['kind'];
  text: string;
  score: number;
  createdAt: string;
}

export interface RecallOptions {
  topK?: number;
  /** 时间衰减半衰期（小时）；0 表示不衰减 */
  halfLifeHours?: number;
  /** 最少相似度阈值，过滤噪声 */
  minScore?: number;
  /** token 上限 */
  budgetTokens?: number;
  /** 参考时间（便于测试确定性） */
  now?: Date;
}

/**
 * 召回：向量相似度 + 时间衰减 + 重要度加权。
 * 相似度本身已归一化（向量 L2 归一），因此加权后仍落在 [0,1] 附近，可直接作为 score 展示。
 */
export function recall(query: string, candidates: RecallCandidate[], opts: RecallOptions = {}): RecallHit[] {
  const topK = opts.topK ?? 20;
  const halfLife = opts.halfLifeHours ?? 72;
  const minScore = opts.minScore ?? 0.05;
  const now = opts.now ?? new Date();
  if (!query.trim() || candidates.length === 0) return [];

  const qv = localEmbed(query);
  const scored: RecallHit[] = [];

  for (const c of candidates) {
    if (!c.text.trim()) continue;
    const cv = c.vector && c.vector.length > 0 ? c.vector : localEmbed(c.text);
    const sim = cosineSimilarity(qv, cv);
    if (sim <= 0) continue;
    const decay = halfLife > 0 ? timeDecay(c.createdAt, now, halfLife) : 1;
    const importance = 0.7 + 0.3 * (c.importance ?? 0.5);
    const score = sim * decay * importance;
    if (score < minScore) continue;
    scored.push({ id: c.id, kind: c.kind, text: c.text, score, createdAt: c.createdAt });
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const limited = scored.slice(0, topK);
  if (opts.budgetTokens === undefined) return limited;

  // 预算截断：按分数从高到低累加，超预算的条目直接丢弃（比截断正文更可解释）
  const out: RecallHit[] = [];
  let used = 0;
  for (const hit of limited) {
    const t = estimateTokens(hit.text);
    if (used + t > opts.budgetTokens) continue;
    used += t;
    out.push(hit);
  }
  return out;
}

/** 指数时间衰减，返回 (0,1] */
export function timeDecay(createdAt: string, now: Date, halfLifeHours: number): number {
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return 1;
  const hours = Math.max(0, (now.getTime() - t) / 3_600_000);
  return Math.pow(0.5, hours / halfLifeHours);
}

/** 把消息转换为召回候选 */
export function messagesToCandidates(messages: Message[], vectors?: Map<string, number[]>): RecallCandidate[] {
  return messages.map((m) => ({
    id: m.id,
    kind: 'message' as const,
    text: m.content,
    vector: vectors?.get(m.id) ?? null,
    createdAt: m.createdAt,
  }));
}

/**
 * 关键词召回的补充通道（BM25 近似）。
 * 向量召回对「精确术语/编号」不敏感，两者合并后再去重，可显著提升召回准确率。
 */
export function keywordRecall(query: string, candidates: RecallCandidate[], topK = 10): RecallHit[] {
  const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_]{2,}|[\u4e00-\u9fff]{2,}/g) ?? [])];
  if (terms.length === 0) return [];
  const hits: RecallHit[] = [];
  for (const c of candidates) {
    const hay = c.text.toLowerCase();
    let raw = 0;
    for (const t of terms) {
      const hits_ = hay.split(t).length - 1;
      if (hits_ > 0) raw += 1 + Math.log(1 + hits_);
    }
    if (raw <= 0) continue;
    // 归一化到 (0,1)，与向量分数可比
    hits.push({ id: c.id, kind: c.kind, text: c.text, score: Math.min(1, raw / (terms.length + 1)), createdAt: c.createdAt });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, topK);
}

/** 融合两路召回：按 id 取最大分，向量略有权重倾斜 */
export function hybridRecall(
  query: string,
  candidates: RecallCandidate[],
  opts: RecallOptions & { vectorWeight?: number } = {},
): RecallHit[] {
  const vw = opts.vectorWeight ?? 0.7;
  const vectorHits = recall(query, candidates, { ...opts, topK: (opts.topK ?? 20) * 2 });
  const keywordHits = keywordRecall(query, candidates, (opts.topK ?? 20) * 2);
  const merged = new Map<string, RecallHit & { _v?: number; _k?: number }>();
  for (const h of vectorHits) {
    const prev = merged.get(h.id);
    merged.set(h.id, { ...h, _v: h.score, _k: prev?._k ?? 0 });
  }
  for (const h of keywordHits) {
    const prev = merged.get(h.id);
    merged.set(h.id, {
      ...(prev ?? h),
      _v: prev?._v ?? 0,
      _k: h.score,
    });
  }
  const out = [...merged.values()].map((h) => ({
    id: h.id,
    kind: h.kind,
    text: h.text,
    createdAt: h.createdAt,
    score: vw * (h._v ?? 0) + (1 - vw) * (h._k ?? 0),
  }));
  out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const topK = opts.topK ?? 20;
  const limited = out.slice(0, topK);
  if (opts.budgetTokens === undefined) return limited;
  const result: RecallHit[] = [];
  let used = 0;
  for (const hit of limited) {
    const t = estimateTokens(hit.text);
    if (used + t > opts.budgetTokens) continue;
    used += t;
    result.push(hit);
  }
  return result;
}

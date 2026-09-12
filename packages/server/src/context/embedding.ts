/**
 * 本地确定性 embedding。
 *
 * 设计取舍：
 * - 不强制依赖外部 embedding API：未配置密钥时也能做语义召回，保证功能可用、可测试。
 * - 采用 hashing trick + 字符 n-gram（对中文友好，中文二字词即 n-gram）+ L2 归一化。
 * - 如果用户配置了 AI_EMBEDDING_MODEL（OpenAI 兼容 /embeddings），则优先调用远端，
 *   远端失败自动回落到本地，不阻塞主流程。
 *
 * 说明：这是「近似语义」而非深度语义，但足以支撑百万 Token 对话的召回与溯源；
 * 后续可平滑替换为 LanceDB/Qdrant + bge/text-embedding 模型，接口保持不变。
 */
import { config } from '../config.ts';
import { logger } from '../utils/logger.ts';

export const EMBEDDING_DIM = 256;

const CJK = /[\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef]/;

/** 分词：CJK 取 1-gram 与 2-gram，拉丁取小写词 */
export function tokenizeForEmbedding(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  const cjkChars = [...lower].filter((c) => CJK.test(c));
  for (const c of cjkChars) tokens.push(c);
  for (let i = 0; i + 1 < cjkChars.length; i++) tokens.push(cjkChars[i]! + cjkChars[i + 1]!);
  const latin = lower.match(/[a-z0-9_]{2,}/g) ?? [];
  tokens.push(...latin);
  return tokens;
}

/** FNV-1a 32bit，稳定且快，用于 hashing trick */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 本地 embedding：hashing trick + 词频平方根加权 + L2 归一化 */
export function localEmbed(text: string, dim = EMBEDDING_DIM): number[] {
  const vec = new Array<number>(dim).fill(0);
  const counts = new Map<string, number>();
  for (const t of tokenizeForEmbedding(text)) counts.set(t, (counts.get(t) ?? 0) + 1);
  for (const [token, count] of counts) {
    const h = fnv1a(token);
    const idx = h % dim;
    const sign = (h >>> 31) === 0 ? 1 : -1;
    vec[idx] = (vec[idx] ?? 0) + sign * Math.sqrt(count);
    // 二次散列降低冲突
    const idx2 = (h >>> 7) % dim;
    vec[idx2] = (vec[idx2] ?? 0) + sign * 0.5 * Math.sqrt(count);
  }
  return l2normalize(vec);
}

export function l2normalize(vec: number[]): number[] {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec;
  return vec.map((v) => v / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

export interface EmbeddingResult {
  vector: number[];
  /** true 表示走了本地近似实现 */
  local: boolean;
  model: string;
}

/**
 * 统一 embedding 入口：远端优先，失败回落本地。
 * 远端调用必须显式配置 AI_EMBEDDING_MODEL，未配置则不发起网络请求。
 */
export async function embed(text: string): Promise<EmbeddingResult> {
  const remoteModel = config.ai.embeddingModel;
  if (remoteModel && config.ai.apiKey && text.trim().length > 0) {
    try {
      const res = await fetch(`${config.ai.baseUrl.replace(/\/$/, '')}/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.ai.apiKey}` },
        body: JSON.stringify({ model: remoteModel, input: text.slice(0, 8000) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        const json = (await res.json()) as { data?: { embedding?: number[] }[] };
        const vector = json.data?.[0]?.embedding;
        if (Array.isArray(vector) && vector.length > 0) {
          return { vector: l2normalize(vector), local: false, model: remoteModel };
        }
      }
      logger.warn('embedding provider failed, falling back to local', { status: res.status });
    } catch (e) {
      logger.warn('embedding provider error, falling back to local', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { vector: localEmbed(text), local: true, model: 'local-hashing-v1' };
}

/** 同步版本，供不适合 await 的纯函数路径使用 */
export function embedSync(text: string): EmbeddingResult {
  return { vector: localEmbed(text), local: true, model: 'local-hashing-v1' };
}

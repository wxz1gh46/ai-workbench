import { and, asc, desc, eq, gt } from 'drizzle-orm';
import type { MemoryFact, Message } from '@ai/shared';
import { TOKEN_BUDGET } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { conversationSummaries, memoryFacts, messages } from '../db/schema/index.ts';
import { estimateTokens } from './tokens.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';

export interface ContextBundle {
  /** 拼进 prompt 的上下文块 */
  blocks: { kind: 'summary' | 'fact' | 'recent' | 'retrieval'; content: string; sourceIds: string[] }[];
  totalTokens: number;
  citations: string[];
}

/**
 * 分层上下文管理（百万 Token 场景核心）。
 *
 * 预算分配：
 *   近期原文 35% / 滚动摘要 20% / 向量召回 25% / 关键事实 10% / 输出预留 10%
 * 当消息总量未超预算时，退化为「全量原文」，不引入额外开销。
 */
export class MemoryService {
  constructor(private readonly db: Db) {}

  /** 触发滚动摘要的条件：未摘要消息 token 超过预算的 1.5 倍 */
  private summarizeThreshold(): number {
    return Math.floor(TOKEN_BUDGET.total * TOKEN_BUDGET.recentRawRatio * 1.5);
  }

  async appendMessage(input: {
    conversationId: string;
    role: Message['role'];
    content: string;
    citations?: string[];
  }): Promise<Message> {
    const row = {
      id: newId('msg'),
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      citations: input.citations ?? [],
      tokenCount: estimateTokens(input.content),
      summarized: false,
      createdAt: nowIso(),
    };
    await this.db.insert(messages).values(row);
    return row;
  }

  async listMessages(conversationId: string, limit = 50): Promise<Message[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(limit);
    return rows.reverse();
  }

  /**
   * 构建上下文。
   * @param conversationId 会话
   * @param query 当前用户输入，用于向量召回（Phase 1 用关键词打分，Phase 2 换 LanceDB/Qdrant）
   */
  async buildContext(conversationId: string, query: string): Promise<ContextBundle> {
    const recent = await this.listMessages(conversationId, 40);
    const blocks: ContextBundle['blocks'] = [];
    const citations: string[] = [];

    const all = await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt));

    const total = all.reduce((s, m) => s + m.tokenCount, 0);
    const budget = TOKEN_BUDGET.total;

    // 1) 关键事实（10%）
    const facts = await this.db
      .select()
      .from(memoryFacts)
      .where(eq(memoryFacts.conversationId, conversationId))
      .orderBy(desc(memoryFacts.importance))
      .limit(30);
    if (facts.length) {
      const factBudget = Math.floor(budget * TOKEN_BUDGET.factsRatio);
      let used = 0;
      const picked: MemoryFact[] = [];
      for (const f of facts) {
        const t = estimateTokens(`${f.key}: ${f.value}`);
        if (used + t > factBudget) break;
        used += t;
        picked.push(f);
        if (f.sourceMessageId) citations.push(f.sourceMessageId);
      }
      if (picked.length) {
        blocks.push({
          kind: 'fact',
          content: picked.map((f) => `- ${f.key}: ${f.value}`).join('\n'),
          sourceIds: picked.map((f) => f.sourceMessageId).filter((x): x is string => !!x),
        });
      }
    }

    // 2) 滚动摘要（20%）——取最近若干条摘要
    const summaries = await this.db
      .select()
      .from(conversationSummaries)
      .where(eq(conversationSummaries.conversationId, conversationId))
      .orderBy(desc(conversationSummaries.createdAt))
      .limit(5);
    if (summaries.length) {
      const summaryBudget = Math.floor(budget * TOKEN_BUDGET.summaryRatio);
      let used = 0;
      const picked: typeof summaries = [];
      for (const s of summaries) {
        if (used + s.tokenCount > summaryBudget) break;
        used += s.tokenCount;
        picked.push(s);
      }
      if (picked.length) {
        blocks.push({
          kind: 'summary',
          content: picked
            .reverse()
            .map((s) => `【历史摘要】${s.content}`)
            .join('\n'),
          sourceIds: picked.map((s) => s.toMessageId),
        });
      }
    }

    // 3) 近期原文（35%）
    const recentBudget = Math.floor(budget * TOKEN_BUDGET.recentRawRatio);
    let recentUsed = 0;
    const recentPicked: Message[] = [];
    for (const m of [...recent].reverse()) {
      if (recentUsed + m.tokenCount > recentBudget) break;
      recentUsed += m.tokenCount;
      recentPicked.push(m);
      citations.push(m.id);
    }
    recentPicked.reverse();
    if (recentPicked.length) {
      blocks.push({
        kind: 'recent',
        content: recentPicked.map((m) => `[${m.role}] ${m.content}`).join('\n'),
        sourceIds: recentPicked.map((m) => m.id),
      });
    }

    // 4) 向量召回（25%）——Phase 1 关键词打分，Phase 2 接 LanceDB/pgvector
    const retrievalBudget = Math.floor(budget * TOKEN_BUDGET.retrievalRatio);
    const retrieved = this.keywordRetrieve(all, query, retrievalBudget);
    if (retrieved.length) {
      blocks.push({
        kind: 'retrieval',
        content: retrieved.map((m) => `[历史命中] ${m.content}`).join('\n'),
        sourceIds: retrieved.map((m) => m.id),
      });
      citations.push(...retrieved.map((m) => m.id));
    }

    const totalTokens = blocks.reduce((s, b) => s + estimateTokens(b.content), 0);
    if (total > this.summarizeThreshold()) {
      logger.info('long conversation detected', { conversationId, totalTokens: total });
    }
    return { blocks, totalTokens, citations: [...new Set(citations)] };
  }

  /** 简易 BM25 近似打分，仅用于 Phase 1，保证「召回有来源可溯源」 */
  private keywordRetrieve(history: Message[], query: string, budget: number): Message[] {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    const scored = history
      .map((m) => {
        const hay = m.content.toLowerCase();
        let score = 0;
        for (const t of terms) {
          const hits = hay.split(t).length - 1;
          if (hits > 0) score += 1 + Math.log(1 + hits);
        }
        // 越新越优先
        return { m, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    const out: Message[] = [];
    let used = 0;
    for (const { m } of scored) {
      if (used + m.tokenCount > budget) break;
      used += m.tokenCount;
      out.push(m);
    }
    return out;
  }

  /** 抽取关键事实（Phase 1 用规则；Phase 2 换成 LLM 抽取） */
  async extractFacts(conversationId: string, workspaceId: string, text: string, sourceMessageId: string): Promise<void> {
    const patterns: { key: string; re: RegExp }[] = [
      { key: '偏好', re: /(?:我(?:更)?(?:喜欢|偏好|习惯))([^。！!\n]{1,40})/g },
      { key: '约束', re: /(?:必须|不能|禁止|务必)([^。！!\n]{1,40})/g },
      { key: '决定', re: /(?:决定|确定|就用)([^。！!\n]{1,40})/g },
    ];
    for (const p of patterns) {
      for (const match of text.matchAll(p.re)) {
        const value = (match[1] ?? '').trim();
        if (!value) continue;
        await this.db.insert(memoryFacts).values({
          id: newId('fact'),
          workspaceId,
          conversationId,
          key: p.key,
          value,
          sourceMessageId,
          importance: 0.6,
          createdAt: nowIso(),
        });
      }
    }
  }

  async upsertSummary(input: {
    conversationId: string;
    fromMessageId: string;
    toMessageId: string;
    content: string;
  }): Promise<void> {
    await this.db.insert(conversationSummaries).values({
      id: newId('sum'),
      conversationId: input.conversationId,
      fromMessageId: input.fromMessageId,
      toMessageId: input.toMessageId,
      content: input.content,
      tokenCount: estimateTokens(input.content),
      createdAt: nowIso(),
    });
    await this.db
      .update(messages)
      .set({ summarized: true })
      .where(and(eq(messages.conversationId, input.conversationId), gt(messages.createdAt, '')));
  }

  async listFacts(conversationId: string): Promise<MemoryFact[]> {
    return this.db.select().from(memoryFacts).where(eq(memoryFacts.conversationId, conversationId));
  }
}

function tokenize(q: string): string[] {
  const lower = q.toLowerCase();
  const words = lower.match(/[a-z0-9_]{2,}|[\u4e00-\u9fff]{2,}/g) ?? [];
  return [...new Set(words)];
}

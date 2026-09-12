/**
 * MemoryService：Phase 1 的分层上下文兼容层。
 *
 * Phase 2 起真实实现迁到 `context/ContextManager`（滚动摘要 + 向量召回 + 预算 + 路由），
 * 这里保留原有 API 签名，避免破坏 Phase 1 的路由与测试；内部全部委派。
 */
import type { Message } from '@ai/shared';
import { TOKEN_BUDGET } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { estimateTokens } from './tokens.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { ContextManager } from '../context/contextManager.ts';
import { extractFactsByRules } from '../context/factExtractor.ts';
import { embed } from '../context/embedding.ts';
import { conversationSummaries, memoryFacts } from '../db/schema/index.ts';

/**
 * 兼容壳：Phase 1 的 buildContext 返回旧结构（kind: summary|fact|recent|retrieval）。
 * 新代码请使用 ContextManager.buildContext，返回带预算与路由信息的完整结构。
 */
export class MemoryService {
  private readonly ctx: ContextManager;

  constructor(private readonly db: Db) {
    this.ctx = new ContextManager(db);
  }

  get manager(): ContextManager {
    return this.ctx;
  }

  appendMessage(input: { conversationId: string; role: Message['role']; content: string; citations?: string[] }): Promise<Message> {
    return this.ctx.appendMessage(input);
  }

  listMessages(conversationId: string, limit = 50): Promise<Message[]> {
    return this.ctx.listMessages(conversationId, limit);
  }

  async buildContext(conversationId: string, query: string): Promise<{
    blocks: { kind: 'summary' | 'fact' | 'recent' | 'retrieval'; content: string; sourceIds: string[] }[];
    totalTokens: number;
    citations: string[];
  }> {
    const bundle = await this.ctx.buildContext(conversationId, { query });
    const normalize = (k: string): 'summary' | 'fact' | 'recent' | 'retrieval' => {
      if (k === 'recent') return 'recent';
      if (k === 'facts') return 'fact';
      if (k === 'summary') return 'summary';
      return 'retrieval';
    };
    return {
      blocks: bundle.blocks
        .filter((b) => b.kind !== 'goal' && b.kind !== 'file')
        .map((b) => ({ kind: normalize(b.kind), content: b.content, sourceIds: b.sourceIds })),
      totalTokens: bundle.totalTokens,
      citations: bundle.citations,
    };
  }

  /** 事实抽取（规则 + 向量落库），Phase 1 签名保持不变 */
  async extractFacts(conversationId: string, workspaceId: string, text: string, sourceMessageId: string): Promise<void> {
    const facts = extractFactsByRules(text, sourceMessageId);
    for (const f of facts) {
      const { vector } = await embed(`${f.key}: ${f.value}`);
      await this.db.insert(memoryFacts).values({
        id: newId('fact'),
        workspaceId,
        conversationId,
        key: f.key,
        value: f.value,
        sourceMessageId,
        importance: f.importance,
        embedding: vector,
        recallCount: 0,
        factType: f.factType,
        updatedAt: nowIso(),
        createdAt: nowIso(),
      });
    }
  }

  async upsertSummary(input: { conversationId: string; fromMessageId: string; toMessageId: string; content: string }): Promise<void> {
    await this.db
      .insert(conversationSummaries)
      .values({
        id: newId('sum'),
        conversationId: input.conversationId,
        fromMessageId: input.fromMessageId,
        toMessageId: input.toMessageId,
        content: input.content,
        tokenCount: estimateTokens(input.content),
        kind: 'rolling',
        coveredCount: 0,
        createdAt: nowIso(),
      });
  }

  listFacts(conversationId: string) {
    return this.ctx.listFacts(conversationId);
  }

  async pendingTokens(conversationId: string): Promise<number> {
    return this.ctx.pendingTokens(conversationId);
  }

  compactThreshold(): number {
    return Math.floor(TOKEN_BUDGET.total * TOKEN_BUDGET.recentRawRatio * 1.5);
  }
}

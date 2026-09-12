/**
 * ContextManager：百万 Token 分层上下文的统一入口。
 *
 * 职责：
 * 1) 原始消息存储（永不删除，保证溯源）；
 * 2) 滚动摘要：超过阈值自动压缩旧消息（含事实抽取）；
 * 3) 向量召回 + 关键词召回混合，命中片段带 sourceId 溯源；
 * 4) Token 预算分配（纯函数 tokenBudget 负责计算，这里负责取数与持久化）；
 * 5) 模型路由：按组装后的 token 估算自动切换长上下文模型；
 * 6) 文件上下文注入（把工作区文件按预算裁剪后纳入）。
 *
 * 与 Phase 1 MemoryService 的关系：MemoryService 保留为兼容层，内部委派到本类。
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type {
  ContextBlock,
  ContextBundle,
  Message,
  CompactResult,
  MemoryFactRecord,
  TokenBudgetUsage,
} from '@ai/shared';
import type { Db } from '../db/client.ts';
import { getSqlite } from '../db/client.ts';
import { conversationSummaries, conversations, memoryFacts, messages } from '../db/schema/index.ts';
import { config } from '../config.ts';
import { eventBus } from '../events/bus.ts';
import { EventType } from '@ai/shared';
import { estimateTokens } from '../agent/tokens.ts';
import { modelRouter } from '../agent/model-router.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';
import { AppError } from '../utils/errors.ts';
import { assembleContext, emptyUsage, planBudget, type BudgetPlan } from './tokenBudget.ts';
import { pickSummarizeRange, summarize } from './summarizer.ts';
import { extractFactsByRules, mergeFacts, extractFactsByModel } from './factExtractor.ts';
import { hybridRecall, messagesToCandidates } from './vectorRecall.ts';
import { embed } from './embedding.ts';

/** 默认保留最近多少条原文不参与摘要 */
export const DEFAULT_KEEP_RECENT = 12;

export interface BuildContextOptions {
  /** 当前用户输入，用于召回 */
  query: string;
  /** 工作区 id，用于落事实与文件上下文 */
  workspaceId?: string;
  /** 附加的文件上下文（已解析为文本）：{ 标题, 内容, 来源 } */
  files?: { title: string; content: string; sourceId: string }[];
  /** 目标上下文（目标模式下把 objective + 验收标准注入） */
  goal?: { objective: string; acceptanceCriteria: string[]; sourceId: string };
  /** 总预算覆盖 */
  budget?: number;
  keepRecent?: number;
  topK?: number;
}

export class ContextManager {
  constructor(private readonly db: Db) {}

  /* ----------------------------- 写入 ----------------------------- */

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
    return row as Message;
  }

  /**
   * 批量写入消息（大文件 / 整本书 / 整仓库导入场景）。
   *
   * 性能与稳定性要点（实测踩坑，详见 DECISIONS.md）：
   * - 逐条 / 中等批量走 Drizzle 的 `insert().values(rows)` 时，每行都会新建 prepared statement，
   *   本环境下累计约 350 条以上就会让 better-sqlite3 内部语句缓存失控，
   *   表现为进程退出时原生断言 abort（`RemoveEnvironmentCleanupHook`）。
   * - 解决方式：复用**单个** prepared statement，并在一个事务里批量执行，
   *   语句创建次数从 O(n) 降到 O(1)，1000 行导入稳定通过。
   *
   * @param chunkSize 每个事务的行数上限（过大会拉长写锁，默认 500）
   * @returns 写入的消息数组（保持传入顺序）
   */
  async appendMessages(
    conversationId: string,
    items: { role: Message['role']; content: string }[],
    chunkSize = 500,
  ): Promise<Message[]> {
    if (items.length === 0) return [];
    const sqlite = getSqlite();
    const insertStmt = sqlite.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, citations, token_count, summarized, created_at)
       VALUES (@id, @conversationId, @role, @content, @citations, @tokenCount, @summarized, @createdAt)`,
    );

    const out: Message[] = [];
    const base = Date.now();
    const size = Math.max(1, Math.min(chunkSize, 2_000));
    for (let i = 0; i < items.length; i += size) {
      const chunk = items.slice(i, i + size).map((item, j) => {
        const seq = i + j;
        return {
          id: newId('msg'),
          conversationId,
          role: item.role,
          content: item.content,
          citations: '[]',
          tokenCount: estimateTokens(item.content),
          summarized: 0,
          // 时间单调递增，保证读取顺序稳定
          createdAt: new Date(base + seq).toISOString(),
        };
      });
      const tx = sqlite.transaction((rows: typeof chunk) => {
        for (const row of rows) insertStmt.run(row);
      });
      tx(chunk);
      out.push(
        ...(chunk.map((r) => ({
          id: r.id,
          conversationId: r.conversationId,
          role: r.role,
          content: r.content,
          citations: [],
          tokenCount: r.tokenCount,
          summarized: false,
          createdAt: r.createdAt,
        })) as Message[]),
      );
    }
    logger.info('bulk messages appended', { conversationId, count: out.length, chunkSize: size });
    return out;
  }

  async listMessages(conversationId: string, limit = 100): Promise<Message[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(desc(messages.createdAt))
      .limit(limit);
    return (rows as Message[]).reverse();
  }

  async allMessages(conversationId: string): Promise<Message[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt));
    return rows as Message[];
  }

  /* --------------------------- 构建上下文 --------------------------- */

  async buildContext(conversationId: string, opts: BuildContextOptions): Promise<ContextBundle> {
    const budgetTotal = opts.budget ?? config.ai.contextBudget;
    const plan = planBudget(budgetTotal);
    const keepRecent = opts.keepRecent ?? DEFAULT_KEEP_RECENT;

    const all = await this.allMessages(conversationId);
    const recent = all.slice(-keepRecent);

    // ---- 分区 1：近期原文（最高优先级，必须完整保留最近对话）----
    const recentItems = recent.map((m) => ({
      content: `[${m.role}] ${m.content}`,
      sourceIds: [m.id],
      tokens: m.tokenCount,
    }));

    // ---- 分区 2：目标上下文 ----
    const goalItems = opts.goal
      ? [
          {
            content: `【目标】${opts.goal.objective}\n【验收标准】\n${opts.goal.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
            sourceIds: [opts.goal.sourceId],
            tokens: estimateTokens(opts.goal.objective) + opts.goal.acceptanceCriteria.reduce((s, c) => s + estimateTokens(c), 0),
          },
        ]
      : [];

    // ---- 分区 3：滚动摘要（最新的排前） ----
    const summaryRows = await this.db
      .select()
      .from(conversationSummaries)
      .where(eq(conversationSummaries.conversationId, conversationId))
      .orderBy(desc(conversationSummaries.createdAt))
      .limit(8);
    const summaryItems = summaryRows.map((s) => ({
      content: `【历史摘要 ${s.fromMessageId.slice(-6)}→${s.toMessageId.slice(-6)}】\n${s.content}`,
      sourceIds: [s.fromMessageId, s.toMessageId],
      tokens: s.tokenCount,
    }));

    // ---- 分区 4：关键事实（按重要度）----
    const factRows = (await this.db
      .select()
      .from(memoryFacts)
      .where(eq(memoryFacts.conversationId, conversationId))
      .orderBy(desc(memoryFacts.importance))
      .limit(60)) as MemoryFactRecord[];
    const factItems = factRows.map((f) => ({
      content: `- [${f.factType}] ${f.key}: ${f.value}`,
      sourceIds: f.sourceMessageId ? [f.sourceMessageId] : [],
      tokens: estimateTokens(`${f.key}: ${f.value}`),
    }));

    // ---- 分区 5：向量 + 关键词混合召回（排除已作为近期原文的条目）----
    const recentIds = new Set(recent.map((m) => m.id));
    const olderMessages = all.filter((m) => !recentIds.has(m.id));
    const candidates = messagesToCandidates(olderMessages);
    const retrievalBudget = plan.limits.retrieval;
    const hits = hybridRecall(opts.query, candidates, {
      topK: opts.topK ?? 24,
      budgetTokens: retrievalBudget,
      halfLifeHours: 24 * 30,
      minScore: 0.02,
    });
    const retrievedIds = hits.map((h) => h.id);
    const retrievalItems = hits.map((h) => ({
      content: `【历史命中】${h.text}`,
      sourceIds: [h.id],
      tokens: estimateTokens(h.text),
      score: h.score,
    }));

    // 命中事实召回计数 +1（重要度自增强，但做上限保护）
    const recalledFacts = factRows.filter((f) => f.sourceMessageId && retrievedIds.includes(f.sourceMessageId));
    if (recalledFacts.length) {
      await this.db
        .update(memoryFacts)
        .set({ recallCount: recalledFacts.length })
        .where(inArray(memoryFacts.id, recalledFacts.map((f) => f.id)));
    }
    // 未召回但被向量命中的事实：单独做一次事实级召回，提升「记忆命中」体验
    const factQueryHits = hybridRecall(
      opts.query,
      factRows.map((f) => ({
        id: f.id,
        kind: 'fact' as const,
        text: `${f.key}: ${f.value}`,
        createdAt: f.createdAt,
        importance: f.importance,
      })),
      { topK: 8, minScore: 0.05 },
    );
    const factBoostIds = new Set(factQueryHits.map((h) => h.id));
    // 命中的事实提到最前（预算内优先）
    factItems.sort((a, b) => {
      const ai = factRows.find((f) => a.content.includes(f.value))?.id ?? '';
      const bi = factRows.find((f) => b.content.includes(f.value))?.id ?? '';
      return Number(factBoostIds.has(bi)) - Number(factBoostIds.has(ai));
    });

    // ---- 分区 6：文件上下文 ----
    const fileItems = (opts.files ?? []).map((f) => ({
      content: `【文件 ${f.title}】\n${f.content}`,
      sourceIds: [f.sourceId],
      tokens: estimateTokens(f.content),
    }));

    const assembled = assembleContext(plan, {
      candidates: [
        { kind: 'recent', items: recentItems },
        { kind: 'goal', items: goalItems },
        { kind: 'summary', items: summaryItems },
        { kind: 'facts', items: factItems },
        { kind: 'retrieval', items: retrievalItems },
        { kind: 'file', items: fileItems },
      ],
    });

    const inputTokens = assembled.blocks.reduce((s, b) => s + b.tokens, 0);
    const model = modelRouter.selectModel(inputTokens);
    const routedByLength = inputTokens >= config.ai.longContextThreshold;

    return {
      blocks: assembled.blocks as ContextBlock[],
      totalTokens: assembled.totalTokens,
      citations: assembled.citations,
      budget: assembled.usage,
      model,
      routedByLength,
    };
  }

  /** 只算预算，不落库、不调模型，用于 UI 预览 */
  async previewBudget(conversationId: string): Promise<TokenBudgetUsage> {
    const total = config.ai.contextBudget;
    const rows = await this.db
      .select({ tokens: messages.tokenCount })
      .from(messages)
      .where(eq(messages.conversationId, conversationId));
    const plan = planBudget(total);
    const rawTokens = rows.reduce((s, r) => s + r.tokens, 0);
    return {
      ...emptyUsage(total),
      used: Math.min(plan.inputTotal, rawTokens) + plan.outputReserve,
      byKind: {
        ...emptyUsage(total).byKind,
        recent: Math.min(rawTokens, plan.limits.recent),
      },
      overBudget: rawTokens > plan.inputTotal,
    };
  }

  /* ---------------------------- 滚动摘要 ---------------------------- */

  /** 未摘要区间的 token 量 */
  async pendingTokens(conversationId: string): Promise<number> {
    const rows = await this.db
      .select({ tokens: messages.tokenCount })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.summarized, false)));
    return rows.reduce((s, r) => s + r.tokens, 0);
  }

  /**
   * 触发压缩的阈值。
   *
   * 语义：未摘要消息的 token 量「超过一次上下文装配能装下的量」就该压缩。
   * 装配时未摘要消息只有一部分能进 recent 分区、其余靠向量召回，因此这里取
   * 近期原文分区预算（默认总预算的 35%）作为阈值——超过它，继续追加必然导致
   * 早期消息被挤出组装结果，必须压缩成摘要才能保持「不丢失上下文」。
   *
   * 环境变量 AI_COMPACT_THRESHOLD 可覆盖（便于按模型能力调优）。
   */
  compactThreshold(): number {
    if (config.ai.compactThreshold > 0) return config.ai.compactThreshold;
    const plan: BudgetPlan = planBudget(config.ai.contextBudget);
    return Math.max(2_000, Math.floor(plan.limits.recent));
  }

  async shouldCompact(conversationId: string): Promise<boolean> {
    return (await this.pendingTokens(conversationId)) > this.compactThreshold();
  }

  /**
   * 压缩会话：摘要旧消息 + 抽取事实 + 落库 + 广播事件。
   * 幂等：重复调用不会重复摘要同一区间（summarized 标记）。
   */
  async compact(
    conversationId: string,
    opts: { workspaceId?: string; force?: boolean; keepRecent?: number } = {},
  ): Promise<CompactResult> {
    const keepRecent = opts.keepRecent ?? DEFAULT_KEEP_RECENT;
    const before = await this.pendingTokens(conversationId);
    const all = await this.allMessages(conversationId);
    const { toSummarize } = pickSummarizeRange(all, keepRecent, opts.force ? 1 : this.compactThreshold());

    if (toSummarize.length === 0) {
      return {
        conversationId,
        summarizedMessages: 0,
        summaryId: null,
        summary: '',
        tokensBefore: before,
        tokensAfter: before,
        factsExtracted: 0,
        degraded: true,
      };
    }

    const lastSummary = (
      await this.db
        .select()
        .from(conversationSummaries)
        .where(eq(conversationSummaries.conversationId, conversationId))
        .orderBy(desc(conversationSummaries.createdAt))
        .limit(1)
    )[0];

    const result = await summarize({
      messages: toSummarize,
      ...(lastSummary ? { previousSummary: lastSummary.content } : {}),
    });

    const summaryId = newId('sum');
    const now = nowIso();
    await this.db.insert(conversationSummaries).values({
      id: summaryId,
      conversationId,
      fromMessageId: result.fromMessageId,
      toMessageId: result.toMessageId,
      content: result.content,
      tokenCount: result.tokens,
      kind: opts.force ? 'manual' : 'rolling',
      coveredCount: result.coveredCount,
      createdAt: now,
    });

    // 标记已摘要（只标记本区间，保留原文用于溯源）
    await this.db
      .update(messages)
      .set({ summarized: true })
      .where(inArray(messages.id, toSummarize.map((m) => m.id)));

    // 事实抽取：规则 + 模型
    const ruleFacts = toSummarize.flatMap((m) => extractFactsByRules(m.content, m.id));
    const modelFacts = result.degraded ? [] : await extractFactsByModel(toSummarize.map((m) => m.content).join('\n').slice(0, 12_000));
    const merged = mergeFacts(ruleFacts, modelFacts, toSummarize[toSummarize.length - 1]!.id);

    const workspaceId = opts.workspaceId ?? (await this.resolveWorkspaceId(conversationId));
    let factsExtracted = 0;
    for (const f of merged) {
      const exists = await this.db
        .select({ id: memoryFacts.id })
        .from(memoryFacts)
        .where(
          and(
            eq(memoryFacts.conversationId, conversationId),
            eq(memoryFacts.key, f.key),
            eq(memoryFacts.value, f.value),
          ),
        )
        .limit(1);
      if (exists.length > 0) continue;
      const { vector } = await embed(`${f.key}: ${f.value}`);
      await this.db.insert(memoryFacts).values({
        id: newId('fact'),
        workspaceId,
        conversationId,
        key: f.key,
        value: f.value,
        sourceMessageId: f.sourceMessageId,
        importance: f.importance,
        embedding: vector,
        recallCount: 0,
        factType: f.factType,
        updatedAt: now,
        createdAt: now,
      });
      factsExtracted += 1;
    }

    const after = await this.pendingTokens(conversationId);
    const compactResult: CompactResult = {
      conversationId,
      summarizedMessages: toSummarize.length,
      summaryId,
      summary: result.content,
      tokensBefore: before,
      tokensAfter: after,
      factsExtracted,
      degraded: result.degraded,
    };

    eventBus.publishBuffered(
      EventType.CONTEXT_COMPACTED,
      { ...compactResult, workspaceId },
      { workspaceId, goalId: null, taskId: null },
    );
    logger.info('conversation compacted', {
      conversationId,
      messages: toSummarize.length,
      tokensBefore: before,
      tokensAfter: after,
      facts: factsExtracted,
      degraded: result.degraded,
    });
    return compactResult;
  }

  /** 事实向量补算（历史数据在 Phase 2 之前没有 embedding） */
  async backfillFactEmbeddings(conversationId: string, limit = 200): Promise<number> {
    const rows = (await this.db
      .select()
      .from(memoryFacts)
      .where(eq(memoryFacts.conversationId, conversationId))
      .limit(limit)) as MemoryFactRecord[];
    let updated = 0;
    for (const f of rows) {
      if (f.embedding && f.embedding.length > 0) continue;
      const { vector } = await embed(`${f.key}: ${f.value}`);
      await this.db.update(memoryFacts).set({ embedding: vector }).where(eq(memoryFacts.id, f.id));
      updated += 1;
    }
    return updated;
  }

  async listFacts(conversationId: string): Promise<MemoryFactRecord[]> {
    return (await this.db
      .select()
      .from(memoryFacts)
      .where(eq(memoryFacts.conversationId, conversationId))
      .orderBy(desc(memoryFacts.importance))) as MemoryFactRecord[];
  }

  async listSummaries(conversationId: string) {
    return this.db
      .select()
      .from(conversationSummaries)
      .where(eq(conversationSummaries.conversationId, conversationId))
      .orderBy(desc(conversationSummaries.createdAt));
  }

  /**
   * 组装给模型的 messages（含 system 上下文块）。
   * 用于对话接口，避免调用方重复拼装逻辑。
   */
  async buildPromptMessages(
    conversationId: string,
    userContent: string,
    opts: Omit<BuildContextOptions, 'query'> = {},
  ): Promise<{ bundle: ContextBundle; messages: { role: 'system' | 'user' | 'assistant'; content: string }[] }> {
    const bundle = await this.buildContext(conversationId, { ...opts, query: userContent });
    const systemParts: string[] = [
      '你是 AI 工作台的对话助手。以下分层上下文按优先级排列，引用片段末尾的 [src:xxx] 可溯源。',
    ];
    for (const b of bundle.blocks) {
      const label = {
        recent: '近期对话',
        goal: '当前目标',
        summary: '历史摘要',
        facts: '关键事实',
        retrieval: '相关历史召回',
        file: '文件上下文',
      }[b.kind];
      systemParts.push(`# ${label}\n${b.content}`);
    }
    return {
      bundle,
      messages: [
        { role: 'system', content: systemParts.join('\n\n') },
        { role: 'user', content: userContent },
      ],
    };
  }

  private async resolveWorkspaceId(conversationId: string): Promise<string> {
    const rows = await this.db
      .select({ workspaceId: conversations.workspaceId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    const ws = rows[0]?.workspaceId;
    if (!ws) throw AppError.notFound(`会话不存在: ${conversationId}`);
    return ws;
  }
}

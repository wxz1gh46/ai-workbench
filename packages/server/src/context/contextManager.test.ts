/**
 * Step 1 集成测试：百万 Token 分层上下文。
 * 覆盖：原始存储 → 滚动摘要 → 事实抽取 → 向量召回溯源 → 预算不超限 → 模型路由。
 * 使用独立临时 SQLite，不污染开发数据。
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

// 环境变量必须在加载 config.ts 之前设置：ESM import 会被提升，所以先做副作用再 import。
// 采用「预置模块」方式：`./test-env.ts` 里设置 env 并创建目录，import 顺序天然保证其先执行。
import './test-env.ts';
import { getDb, closeDb } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';
import { WorkspaceService } from '../services/workspace.ts';
import { ContextManager } from './contextManager.ts';
import { conversations } from '../db/schema/index.ts';
import { newId, nowIso } from '../utils/ids.ts';

runMigrations();

// better-sqlite3 是原生模块，测试结束必须显式关闭连接，否则 Node 24 在退出时会触发原生断言
after(() => closeDb());

const db = getDb();
const cm = new ContextManager(db);
const wsService = new WorkspaceService(db);

/** 惰性拿到默认工作区（避免在 test 定义期间访问原生 DB） */
let cachedWorkspaceId = '';
async function workspaceId(): Promise<string> {
  if (!cachedWorkspaceId) cachedWorkspaceId = (await wsService.ensureBootstrap()).workspace.id;
  return cachedWorkspaceId;
}

/** 新建会话并返回 id */
async function newConversation(title: string): Promise<string> {
  const id = newId('conv');
  await db.insert(conversations).values({
    id,
    workspaceId: await workspaceId(),
    title,
    goalId: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  return id;
}

let conversationId = '';

before(async () => {
  conversationId = await newConversation('百万 token 测试会话');
});

test('准备会话：可读取新建会话', async () => {
  assert.ok(conversationId.length > 0);
  assert.equal((await cm.allMessages(conversationId)).length, 0);
});

test('原始消息存储与读取（时间升序）', async () => {
  await cm.appendMessage({ conversationId, role: 'user', content: '第一条消息' });
  await cm.appendMessage({ conversationId, role: 'assistant', content: '第二条消息' });
  const all = await cm.allMessages(conversationId);
  assert.equal(all[0]!.content, '第一条消息');
  assert.equal(all.at(-1)!.content, '第二条消息');
  assert.ok(all[0]!.tokenCount > 0, '落库时必须计算 token 数');
});

test('buildContext：返回分层块、预算与模型路由信息', async () => {
  await cm.appendMessage({ conversationId, role: 'user', content: '我们决定使用 SQLite 作为本地存储。' });
  await cm.appendMessage({ conversationId, role: 'user', content: '研究一下储能行业的装机量。' });
  const bundle = await cm.buildContext(conversationId, { query: '本地存储用什么' });
  assert.ok(bundle.blocks.length >= 1);
  assert.ok(bundle.blocks.some((b) => b.kind === 'recent'));
  assert.ok(bundle.totalTokens > 0);
  assert.ok(bundle.budget.total > 0);
  assert.ok(bundle.budget.used <= bundle.budget.total, '用量不得超过总预算');
  assert.equal(bundle.budget.overBudget, false);
  assert.ok(bundle.model.length > 0);
  assert.equal(typeof bundle.routedByLength, 'boolean');
});

test('buildContext：召回片段可溯源到具体消息 id', async () => {
  const seed = await cm.appendMessage({ conversationId, role: 'user', content: '向量召回必须带溯源，能跳回原始消息这条消息。' });
  const bundle = await cm.buildContext(conversationId, { query: '向量召回溯源跳回原始消息', keepRecent: 1, budget: 20_000 });
  const retrieval = bundle.blocks.find((b) => b.kind === 'retrieval');
  assert.ok(retrieval, '应产生召回块');
  assert.ok(bundle.citations.includes(seed.id), `召回来源应包含 ${seed.id}，实际 ${bundle.citations.join(',')}`);
});

test('buildContext：目标与文件上下文被注入且计入预算', async () => {
  const bundle = await cm.buildContext(conversationId, {
    query: '继续',
    goal: { objective: '完成 Phase 2 核心能力', acceptanceCriteria: ['百万 token 不崩溃', '有审计报告'], sourceId: 'goal-1' },
    files: [{ title: 'architecture.md', content: '# 架构\n分层上下文管理', sourceId: 'file-1' }],
    budget: 20_000,
  });
  assert.ok(bundle.blocks.some((b) => b.kind === 'goal'));
  assert.ok(bundle.blocks.some((b) => b.kind === 'file'));
  assert.ok(bundle.citations.includes('goal-1'));
  assert.ok(bundle.citations.includes('file-1'));
  assert.ok(bundle.totalTokens <= bundle.budget.total - bundle.budget.outputReserve + 1);
});

test('compact：超阈值触发滚动摘要，写入摘要并保留原文', async () => {
  const convId = await newConversation('压缩测试');
  // 造足够多的消息超过阈值：用批量写入（内部复用单个 prepared statement + 事务）
  const CHUNK = `填充内容用于增加 token 数量。${'补充说明。'.repeat(40)}`;
  await cm.appendMessages(
    convId,
    Array.from({ length: 60 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `第 ${i} 轮：我们决定采用方案 ${i}，必须保证可回滚。${CHUNK}`,
    })),
  );
  const before = await cm.pendingTokens(convId);
  assert.ok(await cm.shouldCompact(convId), '应判定需要压缩');
  const result = await cm.compact(convId, { workspaceId: await workspaceId() });
  assert.ok(result.summarizedMessages > 0, '应摘要若干条消息');
  assert.ok(result.tokensAfter < before, '压缩后未摘要 token 应下降');
  assert.ok(result.summary.includes('关键决策'), '摘要必须包含关键决策小节');
  assert.ok(result.factsExtracted > 0, '应抽取到关键事实');

  // 原文保留（可溯源）
  const all = await cm.allMessages(convId);
  assert.equal(all.length, 60, '原始消息不得被删除');
  assert.ok(all.some((m: { summarized: boolean }) => m.summarized), '应存在已摘要标记');
  const kept = all.filter((m: { summarized: boolean }) => !m.summarized);
  assert.ok(kept.length <= 12 + 1, `最近原文应保留，实际未摘要 ${kept.length} 条`);

  // 幂等：再次压缩不再重复摘要同一区间
  const second = await cm.compact(convId, { workspaceId: await workspaceId() });
  assert.equal(second.summarizedMessages, 0);
});

test('compact：事实带溯源与向量，可被召回', async () => {
  // 事实来自「压缩测试」会话：压缩时由规则抽取，必须带 sourceMessageId 与向量
  const convId = await newConversation('事实溯源测试');
  const CHUNK = `补充说明。${'内容补充。'.repeat(40)}`;
  await cm.appendMessages(
    convId,
    Array.from({ length: 40 }, (_, i) => ({
      role: 'user' as const,
      content: `第 ${i} 轮：我们决定采用方案 ${i}，必须保证可回滚。${CHUNK}`,
    })),
  );
  const result = await cm.compact(convId, { workspaceId: await workspaceId() });
  assert.ok(result.factsExtracted > 0, '压缩应抽取到事实');

  const facts = await cm.listFacts(convId);
  assert.ok(facts.length > 0);
  assert.ok(
    facts.every((f) => f.sourceMessageId),
    '每条事实都必须带 sourceMessageId（可点击跳回原消息）',
  );
  assert.ok(facts.some((f) => (f.embedding ?? []).length > 0), '事实应带向量');
  assert.ok(facts.every((f) => ['preference', 'constraint', 'decision', 'fact'].includes(f.factType)));

  // 事实来源确实指向该会话中的真实消息
  const allIds = new Set((await cm.allMessages(convId)).map((m) => m.id));
  for (const f of facts) assert.ok(allIds.has(f.sourceMessageId!), `事实来源 ${f.sourceMessageId} 必须存在`);
});

test('compact：force 可压缩最近窗口内的消息（用户手动触发）', async () => {
  const convId = await newConversation('手动压缩');
  await cm.appendMessages(convId, Array.from({ length: 8 }, (_, i) => ({ role: 'user' as const, content: `短消息 ${i}` })));
  const forced = await cm.compact(convId, { workspaceId: await workspaceId(), force: true, keepRecent: 2 });
  assert.ok(forced.summarizedMessages > 0);
  assert.equal((await cm.allMessages(convId)).filter((m) => !m.summarized).length, 2, '应保留 2 条最近原文');
});

test('百万 Token 规模：加载整本书不崩溃，预算不超限，可继续对话', async () => {
  const convId = await newConversation('百万 token 压测');

  // 目标：总 token ≥ 100 万（验收要求「百万 Token 对话不崩溃」）。
  // 规模用 AI_SCALE_TOKENS 可调：CI 跑百万级，本地快速回归可调小。
  //
  // 必须走 appendMessages 批量写入（内部复用单个 prepared statement + 事务）：
  // 逐条 insert 会创建上千个语句并触发 better-sqlite3 原生断言 abort（升级 13.x 后已解决，
  // 但仍保留批量路径，因为它是大文件/整仓库导入的正确做法）。
  const required = Number(process.env.AI_SCALE_TOKENS ?? '1000000');
  const paragraph = '储能行业装机量持续增长，政策驱动明显，2025 年预计新增 120GW，需关注产能过剩风险。';
  const chunk = paragraph.repeat(40); // ~1400 字 ≈ 1400 token

  let total = 0;
  let written = 0;
  while (total < required) {
    const batchSize = Math.max(1, Math.min(200, Math.ceil((required - total) / chunk.length) + 5));
    const rows = Array.from({ length: batchSize }, (_, i) => ({
      role: (i % 10 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `第 ${written + i} 段：${chunk}`,
    }));
    const appended = await cm.appendMessages(convId, rows);
    written += appended.length;
    total += appended.reduce((s, m) => s + m.tokenCount, 0);
  }
  const all = await cm.allMessages(convId);
  assert.ok(total >= required, `应达到百万级 token，实际 ${total}`);
  assert.equal(all.length, written, '批量写入不得丢行');

  const started = Date.now();
  const bundle = await cm.buildContext(convId, { query: '2025 年储能新增装机量是多少', budget: 200_000 });
  const elapsed = Date.now() - started;

  assert.ok(
    bundle.totalTokens <= bundle.budget.total - bundle.budget.outputReserve,
    `组装结果不得超过输入预算：totalTokens=${bundle.totalTokens} inputTotal=${bundle.budget.total - bundle.budget.outputReserve}`,
  );
  assert.equal(bundle.budget.overBudget, false);
  assert.ok(bundle.blocks.some((b) => b.kind === 'recent'), '必须保留最近对话');
  assert.ok(bundle.citations.length > 0, '必须给出可溯源引用');
  assert.ok(elapsed < 30_000, `组装耗时应可接受，实际 ${elapsed}ms`);

  // 压缩后仍可继续对话，且出现历史摘要分区
  const compactResult = await cm.compact(convId, { workspaceId: await workspaceId() });
  assert.ok(compactResult.summarizedMessages > 0);
  assert.ok(compactResult.tokensAfter < compactResult.tokensBefore, '压缩后未摘要 token 应下降');
  const after = await cm.buildContext(convId, { query: '继续，讲一下风险', budget: 200_000 });
  assert.ok(after.blocks.some((b) => b.kind === 'summary'), '压缩后应有历史摘要分区');
  assert.equal(after.budget.overBudget, false);
});

test('previewBudget：用于 UI 的 Token 使用条', async () => {
  const usage = await cm.previewBudget(conversationId);
  assert.ok(usage.total > 0);
  assert.ok(usage.used >= usage.outputReserve);
  assert.ok(usage.limits.recent > 0);
});

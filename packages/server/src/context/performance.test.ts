/**
 * Step 8：上下文组装的性能回归测试。
 *
 * 目的：把「百万 token 不崩溃、响应时间可接受、内存可控」变成可自动断言的指标，
 * 而不是靠人肉观察。这里用纯函数（不落库）做大输入压测，运行时间稳定。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { assembleContext, planBudget } from './tokenBudget.ts';
import { hybridRecall, type RecallCandidate } from './vectorRecall.ts';
import { localEmbed } from './embedding.ts';
import { estimateTokens } from '../agent/tokens.ts';
import { extractiveSummarize } from './summarizer.ts';
import { extractFactsByRules } from './factExtractor.ts';
import type { Message } from '@ai/shared';

function longText(chars: number): string {
  const base = '储能行业装机量持续增长，政策驱动明显，2025 年预计新增 120GW，需关注产能过剩风险。';
  return base.repeat(Math.ceil(chars / base.length)).slice(0, chars);
}

test('性能：百万 token 规模的上下文组装在预算内完成且不超限', () => {
  const plan = planBudget(200_000);
  // 模拟 1000 条历史消息（约 100 万 token）
  const items = Array.from({ length: 1000 }, (_, i) => {
    const content = longText(1000);
    return { content, sourceIds: [`m${i}`], tokens: estimateTokens(content) };
  });

  const started = Date.now();
  const out = assembleContext(plan, {
    candidates: [
      { kind: 'recent', items: items.slice(-12) },
      { kind: 'retrieval', items },
      { kind: 'summary', items: items.slice(0, 3) },
      { kind: 'facts', items: items.slice(0, 20) },
    ],
  });
  const elapsed = Date.now() - started;

  assert.ok(out.totalTokens <= plan.inputTotal, `不得超过输入预算：${out.totalTokens} > ${plan.inputTotal}`);
  assert.equal(out.usage.overBudget, false);
  assert.ok(elapsed < 3_000, `组装应快速完成，实际 ${elapsed}ms`);
  assert.ok(out.citations.length > 0, '必须保留溯源信息');
});

test('性能：对 2000 条候选做混合召回，结果稳定且耗时可控', () => {
  const candidates: RecallCandidate[] = Array.from({ length: 2000 }, (_, i) => ({
    id: `m${i}`,
    kind: 'message' as const,
    text: i % 3 === 0 ? '储能装机量与政策驱动分析' : `普通对话内容 ${i} ${longText(200)}`,
    vector: i % 10 === 0 ? localEmbed('储能装机量与政策驱动分析') : null,
    createdAt: new Date(Date.now() - i * 60_000).toISOString(),
  }));

  const started = Date.now();
  const hits = hybridRecall('储能装机量政策', candidates, { topK: 24, budgetTokens: 40_000 });
  const elapsed = Date.now() - started;

  assert.ok(hits.length > 0, '应召回结果');
  assert.ok(hits.length <= 24, '不得超过 topK');
  assert.ok(elapsed < 20_000, `召回耗时应可控，实际 ${elapsed}ms`);
  assert.equal(new Set(hits.map((h) => h.id)).size, hits.length, '结果不得重复');
});

test('性能：万级消息的离线摘要生成不超时且保留关键决策', () => {
  const messages: Message[] = Array.from({ length: 5_000 }, (_, i) => ({
    id: `m${i}`,
    conversationId: 'c1',
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: i % 50 === 0 ? `第 ${i} 轮：我们决定采用方案 A，必须保证可回滚。` : `第 ${i} 轮：普通讨论内容，继续推进。`,
    citations: [],
    tokenCount: 20,
    summarized: false,
    createdAt: new Date(Date.now() - i * 1000).toISOString(),
  }));

  const started = Date.now();
  const summary = extractiveSummarize(messages);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 5_000, `摘要耗时应可控，实际 ${elapsed}ms`);
  assert.ok(summary.includes('## 关键决策'), '必须保留关键决策小节');
  assert.ok(summary.includes('必须保证可回滚') || summary.includes('采用方案 A'), '应保留关键约束/决策');
});

test('性能：单条消息的事实抽取不会因超长文本退化', () => {
  const huge = `${longText(200_000)}我们决定采用方案 B，必须保证密钥不硬编码。`;
  const started = Date.now();
  const facts = extractFactsByRules(huge, 'm1');
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, `抽取耗时应可控，实际 ${elapsed}ms`);
  assert.ok(facts.length > 0, '应抽取到事实');
  assert.ok(facts.every((f) => f.sourceMessageId === 'm1'), '事实必须可溯源');
});

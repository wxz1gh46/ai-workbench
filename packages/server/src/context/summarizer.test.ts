import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '@ai/shared';
import { SUMMARY_SECTIONS, extractiveSummarize, pickSummarizeRange } from './summarizer.ts';

function msg(id: string, content: string, summarized = false, tokens = 100): Message {
  return { id, conversationId: 'c1', role: 'user', content, citations: [], tokenCount: tokens, summarized, createdAt: `2026-01-01T00:00:0${id.slice(-1)}Z` };
}

test('pickSummarizeRange：未超阈值时不压缩', () => {
  const messages = [msg('m1', 'a', false, 10), msg('m2', 'b', false, 10)];
  const r = pickSummarizeRange(messages, 12, 1_000);
  assert.deepEqual(r.toSummarize, []);
});

test('pickSummarizeRange：超阈值时保留最近 N 条原文，压缩更早区间', () => {
  const messages = Array.from({ length: 40 }, (_, i) => msg(`m${i}`, `消息 ${i}`, false, 100));
  const r = pickSummarizeRange(messages, 12, 500);
  assert.equal(r.toSummarize.length, 28, '40 - 12 = 28 条应被压缩');
  assert.equal(r.toSummarize[0]!.id, 'm0');
  assert.equal(r.toSummarize.at(-1)!.id, 'm27');
  // 最近 12 条绝不被摘要
  const ids = new Set(r.toSummarize.map((m) => m.id));
  for (let i = 28; i < 40; i++) assert.ok(!ids.has(`m${i}`), `m${i} 属于最近消息，不应被摘要`);
});

test('pickSummarizeRange：已摘要消息不重复参与，最近消息保留原文', () => {
  const messages = [msg('m0', 'old', true, 100), msg('m1', 'mid', false, 100), msg('m2', 'latest', false, 100)];
  const r = pickSummarizeRange(messages, 1, 1);
  // m0 已摘要；m2 属于最近 1 条保留原文 → 只剩 m1
  assert.deepEqual(r.toSummarize.map((m) => m.id), ['m1']);
});

test('extractiveSummarize：离线也能保留关键决策与约束', () => {
  const messages = [
    msg('m1', '我们决定使用 SQLite 作为本地数据库。'),
    msg('m2', '必须保证所有密钥不硬编码，从环境变量读取。'),
    msg('m3', '今天天气很好。'),
    msg('m4', '装机量达到 120 GW。'),
  ];
  const summary = extractiveSummarize(messages);
  for (const section of SUMMARY_SECTIONS) assert.ok(summary.includes(`## ${section}`), `缺少小节 ${section}`);
  assert.ok(summary.includes('SQLite'), '应保留关键决策');
  assert.ok(summary.includes('不硬编码'), '应保留约束');
  assert.ok(summary.includes('120'), '应保留指标数字');
  assert.ok(!summary.includes('今天天气很好'), '寒暄不应进入摘要');
});

test('extractiveSummarize：空消息不抛错', () => {
  const s = extractiveSummarize([]);
  assert.ok(s.includes('## 关键决策'));
});

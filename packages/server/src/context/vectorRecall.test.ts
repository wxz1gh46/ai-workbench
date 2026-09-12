import assert from 'node:assert/strict';
import test from 'node:test';
import { hybridRecall, keywordRecall, recall, timeDecay, type RecallCandidate } from './vectorRecall.ts';

const NOW = new Date('2026-01-10T00:00:00.000Z');

function cand(id: string, text: string, createdAt = '2026-01-09T23:00:00.000Z', importance?: number): RecallCandidate {
  return { id, kind: 'message', text, createdAt, ...(importance === undefined ? {} : { importance }) };
}

const candidates: RecallCandidate[] = [
  cand('m1', '我们决定使用 SQLite 作为本地数据库，配合 Drizzle ORM'),
  cand('m2', '目标模式需要任务 DAG 与完成审计环节'),
  cand('m3', '今天中午吃什么比较好呢'),
  cand('m4', '向量召回需要支持溯源，每个片段要能跳回原始消息', '2025-12-01T00:00:00.000Z'),
];

test('recall：语义相关片段排在前，无关文本被阈值过滤', () => {
  const hits = recall('本地数据库用什么存储', candidates, { now: NOW });
  assert.ok(hits.length > 0);
  assert.equal(hits[0]!.id, 'm1', `应召回数据库相关消息，实际 ${hits.map((h) => h.id).join(',')}`);
  assert.ok(!hits.some((h) => h.id === 'm3' && h.score > 0.3), '无关寒暄不应高分');
});

test('recall：每个命中都带来源 id（溯源硬要求）', () => {
  const hits = recall('任务 DAG 审计', candidates, { now: NOW });
  for (const h of hits) {
    assert.ok(h.id.length > 0);
    assert.ok(candidates.some((c) => c.id === h.id));
    assert.ok(h.score > 0 && h.score <= 1.5);
  }
});

test('recall：时间衰减让新消息优于同样相关的旧消息', () => {
  const fresh = cand('fresh', '长上下文摘要策略需要覆盖关键决策', '2026-01-09T23:00:00.000Z');
  const stale = cand('stale', '长上下文摘要策略需要覆盖关键决策', '2025-10-01T00:00:00.000Z');
  const hits = recall('长上下文摘要策略', [stale, fresh], { now: NOW });
  assert.equal(hits[0]!.id, 'fresh');
});

test('timeDecay：半衰期后权重为 0.5', () => {
  const d = timeDecay('2026-01-09T12:00:00.000Z', new Date('2026-01-10T00:00:00.000Z'), 12);
  assert.ok(Math.abs(d - 0.5) < 1e-6, `实际 ${d}`);
});

test('recall：预算截断后不超预算，且不返回半截内容', () => {
  const long = Array.from({ length: 20 }, (_, i) => cand(`m${i}`, `向量召回预算测试 ${'内容'.repeat(200)}`));
  const hits = recall('向量召回预算', long, { now: NOW, budgetTokens: 300 });
  const total = hits.reduce((s, h) => s + h.text.length, 0);
  assert.ok(hits.length < long.length);
  assert.ok(total < long.reduce((s, c) => s + c.text.length, 0));
});

test('recall：无查询或空候选返回空数组', () => {
  assert.deepEqual(recall('', candidates, { now: NOW }), []);
  assert.deepEqual(recall('任意', [], { now: NOW }), []);
});

test('keywordRecall：精确术语命中（向量不敏感的编号/专有名词）', () => {
  const hits = keywordRecall('SQLite Drizzle', candidates);
  assert.ok(hits.some((h) => h.id === 'm1'));
});

test('hybridRecall：融合两路召回，结果去重', () => {
  const hits = hybridRecall('SQLite 数据库 溯源', candidates, { now: NOW, topK: 10 });
  const ids = hits.map((h) => h.id);
  assert.equal(new Set(ids).size, ids.length, '不应出现重复 id');
  assert.ok(ids.includes('m1'));
  assert.ok(ids.includes('m4') || ids.includes('m2'));
});

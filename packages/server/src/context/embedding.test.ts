import assert from 'node:assert/strict';
import test from 'node:test';
import { EMBEDDING_DIM, cosineSimilarity, localEmbed, l2normalize, tokenizeForEmbedding } from './embedding.ts';
import { validateRatios } from './tokenBudget.ts';

test('localEmbed：维度固定且已 L2 归一', () => {
  const v = localEmbed('这是一段用于测试的中文文本 with english tokens');
  assert.equal(v.length, EMBEDDING_DIM);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9, `归一后模长应为 1，实际 ${norm}`);
});

test('localEmbed：相同文本得到相同向量（确定性）', () => {
  assert.deepEqual(localEmbed('百万 token 上下文管理'), localEmbed('百万 token 上下文管理'));
});

test('cosineSimilarity：语义相近的文本相似度高于无关文本', () => {
  const q = localEmbed('如何实现百万 token 的长上下文对话记忆');
  const related = localEmbed('长上下文对话记忆需要分层摘要与向量召回');
  const unrelated = localEmbed('今天天气不错适合出门散步');
  const s1 = cosineSimilarity(q, related);
  const s2 = cosineSimilarity(q, unrelated);
  assert.ok(s1 > s2, `相关文本 ${s1} 应高于无关文本 ${s2}`);
});

test('cosineSimilarity：正交/空向量返回 0 而不抛错', () => {
  assert.equal(cosineSimilarity([], []), 0);
  assert.equal(cosineSimilarity(l2normalize([0, 0, 0]), localEmbed('abc')), 0);
});

test('tokenizeForEmbedding：中文取 1-gram 与相邻 2-gram，英文取小写词', () => {
  const tokens = tokenizeForEmbedding('深度研究 Research');
  assert.ok(tokens.includes('研'));
  assert.ok(tokens.includes('深度'), '应包含相邻 2-gram');
  assert.ok(tokens.includes('research'), '英文应小写化');
  assert.ok(!tokens.includes('深研'), '不相邻的字不应组成二字词');
});

test('validateRatios：比例之和不为 1 时立即报错，避免静默算错预算', () => {
  assert.throws(
    () => validateRatios({ recent: 0.5, summary: 0.2, retrieval: 0.2, facts: 0.1, file: 0.05, goal: 0.05, outputReserve: 0.05 }),
    /比例之和必须为 1/,
  );
});

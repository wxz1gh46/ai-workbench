import assert from 'node:assert/strict';
import test from 'node:test';
import { extractFactsByRules, factTokens, mergeFacts } from './factExtractor.ts';

test('extractFactsByRules：抽取约束/决定/偏好/指标四类事实', () => {
  const text = [
    '我们必须保证密钥不硬编码。',
    '我决定采用 Tauri 2 作为桌面壳。',
    '我更喜欢简洁的中文报告。',
    '装机量达到 120 GW。',
  ].join('\n');
  const facts = extractFactsByRules(text, 'msg-1');
  const types = new Set(facts.map((f) => f.factType));
  assert.ok(types.has('constraint'));
  assert.ok(types.has('decision'));
  assert.ok(types.has('preference'));
  assert.ok(types.has('fact'));
  for (const f of facts) {
    assert.equal(f.sourceMessageId, 'msg-1', '每条事实都必须可溯源');
    assert.ok(f.importance > 0 && f.importance <= 1);
  }
});

test('extractFactsByRules：过短命中被丢弃，避免噪声', () => {
  const facts = extractFactsByRules('必须。', null);
  assert.equal(facts.length, 0);
});

test('mergeFacts：按类型+键+值去重并保留更高重要度', () => {
  const rules = [{ key: '约束', value: '必须离线可用', factType: 'constraint' as const, importance: 0.6, sourceMessageId: 'm1' }];
  const model = [{ key: '约束', value: '必须离线可用', factType: 'constraint' as const, importance: 0.9, sourceMessageId: null }];
  const merged = mergeFacts(rules, model, 'm2');
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.importance, 0.9);
  assert.equal(merged[0]!.sourceMessageId, 'm1', '已有溯源信息不应被 null 覆盖');
});

test('mergeFacts：模型事实缺溯源时补上当前消息 id', () => {
  const merged = mergeFacts([], [{ key: '决定', value: '用 SQLite', factType: 'decision' as const, importance: 0.7, sourceMessageId: null }], 'm9');
  assert.equal(merged[0]!.sourceMessageId, 'm9');
});

test('factTokens：中文按字估算', () => {
  assert.ok(factTokens({ key: '约束', value: '必须离线可用' }) >= 6);
});

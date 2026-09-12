import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTokens, taskStatusLabel, truncate } from './utils.ts';

test('truncate 超长文本加省略号', () => {
  assert.equal(truncate('abcdef', 4), 'abcd…');
  assert.equal(truncate('abc', 4), 'abc');
});

test('formatTokens 人类可读', () => {
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(1500), '1.5k');
  assert.equal(formatTokens(2_500_000), '2.5M');
});

test('taskStatusLabel 覆盖全部任务状态', () => {
  const statuses = ['pending', 'ready', 'running', 'blocked', 'succeeded', 'failed', 'cancelled'] as const;
  for (const s of statuses) assert.ok(taskStatusLabel(s).length > 0, `缺少 ${s} 的标签`);
});

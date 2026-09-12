import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVerdict } from './critic.ts';

test('parseVerdict 解析完整审计结果', () => {
  const raw = '```json\n{"passed":false,"score":75,"issues":[{"severity":"high","detail":"缺少来源"}],"nextActions":["补充引用"],"report":"# 报告"}\n```';
  const v = parseVerdict(raw);
  assert.equal(v.passed, false);
  assert.equal(v.score, 75);
  assert.equal(v.issues[0]!.severity, 'high');
  assert.deepEqual(v.nextActions, ['补充引用']);
});

test('parseVerdict 对 score 越界做 clamp，非法 severity 回落 medium', () => {
  const v = parseVerdict('{"passed":true,"score":500,"issues":[{"severity":"apocalyptic","detail":"x"}]}');
  assert.equal(v.score, 100);
  assert.equal(v.issues[0]!.severity, 'medium');
});

test('parseVerdict 非 JSON 抛错', () => {
  assert.throws(() => parseVerdict('无法完成审计'));
});

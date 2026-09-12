import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResearchSource } from '@ai/shared';
import { crossValidate, extractClaims, subjectKey, validationSummary } from './crossValidate.ts';

function source(id: string, content: string, reliability = 0.8): ResearchSource {
  return {
    id,
    researchJobId: 'rj1',
    url: `https://example.com/${id}`,
    title: `来源 ${id}`,
    snippet: content.slice(0, 100),
    content,
    accessedAt: '2026-01-01T00:00:00.000Z',
    reliability,
    requiresAuth: false,
  };
}

test('extractClaims：抽取含量化数值的论断', () => {
  const c = extractClaims(source('s1', '2025 年储能装机量预计达到 120GW。行业增速超过 30%。'));
  assert.ok(c.length >= 2);
  assert.ok(c.some((x) => x.value === 120 && x.unit === 'GW'));
  assert.ok(c.some((x) => x.unit === '%'));
  assert.ok(c.every((x) => x.sourceId === 's1'));
});

test('extractClaims：抽出强断言（无数字但可验证）', () => {
  const c = extractClaims(source('s1', '该政策已正式实施，禁止新增未批产能。'));
  assert.ok(c.length >= 1);
  assert.ok(c.some((x) => x.value === null));
});

test('crossValidate：多源一致 → 不算冲突，置信度随来源数提升', () => {
  const sources = [
    source('s1', '2025 年储能装机量预计达到 120GW。'),
    source('s2', '2025 年储能装机量预计达到 121GW。'),
    source('s3', '2025 年储能装机量预计达到 119GW。'),
  ];
  const claims = crossValidate(sources);
  const target = claims.find((c) => c.supportingSources.length >= 3);
  assert.ok(target, `应聚合成多源支持的论断，实际 ${JSON.stringify(claims.map((c) => [c.claim, c.supportingSources]))}`);
  assert.equal(target!.disputed, false);
  assert.ok(target!.confidence > 0.6, `三源一致置信度应较高，实际 ${target!.confidence}`);
});

test('crossValidate：多源数值冲突 → 标记 disputed 并列出冲突来源', () => {
  const sources = [
    source('s1', '2025 年储能装机量预计达到 120GW。'),
    source('s2', '2025 年储能装机量预计达到 120GW。'),
    source('s3', '2025 年储能装机量预计达到 300GW。'),
  ];
  const claims = crossValidate(sources);
  const disputed = claims.filter((c) => c.disputed);
  assert.ok(disputed.length > 0, '应检出冲突');
  const d = disputed[0]!;
  assert.ok(d.conflictingSources.includes('s3'), `冲突来源应包含 s3，实际 ${d.conflictingSources.join(',')}`);
  assert.ok(d.supportingSources.includes('s1'), '主流来源应保留在支持列表');
  assert.ok(d.confidence < 1, '存在冲突时置信度应被下调');
});

test('crossValidate：小差异（<3%）不判为冲突', () => {
  const sources = [
    source('s1', '2025 年市场规模达到 1000 亿元。'),
    source('s2', '2025 年市场规模达到 1010 亿元。'),
  ];
  const claims = crossValidate(sources);
  assert.ok(claims.every((c) => !c.disputed), '3% 以内差异不应报冲突');
});

test('validationSummary：统计总数/冲突数/高置信数', () => {
  // 3 个来源：两源一致 + 一源冲突 → total ≥ 1，disputed ≥ 1
  const sources = [
    source('s1', '2025 年储能装机量达到 120GW。'),
    source('s2', '2025 年储能装机量达到 300GW。'),
    source('s3', '行业增速超过 30%。'),
  ];
  const s = validationSummary(crossValidate(sources));
  assert.ok(s.total >= 2);
  assert.ok(s.disputed >= 1);
  assert.equal(typeof s.highConfidence, 'number');
});

test('subjectKey：同一主题的不同表述能落到同键（冲突才可能被检出）', () => {
  const a = subjectKey('2025 年储能装机量预计达到 120GW', 'GW');
  const b = subjectKey('2025 年储能装机量将达 300GW', 'GW');
  assert.equal(a, b);
});

test('crossValidate：无来源时返回空数组', () => {
  assert.deepEqual(crossValidate([]), []);
});

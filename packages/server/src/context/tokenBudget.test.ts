import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_BUDGET_RATIOS, assembleContext, emptyUsage, planBudget } from './tokenBudget.ts';

test('planBudget：输出预留从总预算中扣除，各分区之和不超过输入预算', () => {
  const plan = planBudget(200_000);
  assert.equal(plan.total, 200_000);
  assert.equal(plan.outputReserve, 10_000);
  assert.equal(plan.inputTotal, 190_000);
  const sum = Object.values(plan.limits).reduce((a, b) => a + b, 0);
  assert.ok(sum <= plan.inputTotal, `分区上限之和 ${sum} 不应超过 ${plan.inputTotal}`);
});

test('planBudget：比例自洽（不含输出预留时总和为 1）', () => {
  const r = DEFAULT_BUDGET_RATIOS;
  const sum = r.recent + r.summary + r.retrieval + r.facts + r.file + r.goal + r.outputReserve;
  assert.ok(Math.abs(sum - 1) < 1e-9, `比例总和应为 1，实际 ${sum}`);
});

test('assembleContext：按优先级装配并保留来源 ID', () => {
  const plan = planBudget(10_000);
  const out = assembleContext(plan, {
    candidates: [
      { kind: 'recent', items: [{ content: '用户说：你好', sourceIds: ['m1'], tokens: 10 }] },
      { kind: 'facts', items: [{ content: '- 约束: 必须用中文', sourceIds: ['m2'], tokens: 12 }] },
      { kind: 'retrieval', items: [{ content: '【历史命中】旧对话', sourceIds: ['m3'], tokens: 40 }] },
    ],
  });
  assert.deepEqual(
    out.blocks.map((b) => b.kind),
    ['recent', 'facts', 'retrieval'],
  );
  assert.deepEqual(out.citations.sort(), ['m1', 'm2', 'm3']);
  assert.equal(out.usage.overBudget, false);
  assert.equal(out.usage.used, out.totalTokens + plan.outputReserve);
});

test('assembleContext：单条超预算时截断而非丢弃，并提示来源', () => {
  const plan = planBudget(4_000);
  const limit = plan.limits.recent;
  const huge = 'x'.repeat(limit * 20);
  const out = assembleContext(plan, {
    candidates: [{ kind: 'recent', items: [{ content: huge, sourceIds: ['m9'], tokens: limit * 20 }] }],
  });
  assert.equal(out.blocks.length, 1);
  assert.ok(out.blocks[0]!.tokens <= limit, '截断后不得超过分区上限');
  assert.ok(out.blocks[0]!.content.includes('已按 Token 预算截断'));
  assert.deepEqual(out.citations, ['m9']);
});

test('assembleContext：某分区为空时预算可被后续分区借用', () => {
  const plan = planBudget(10_000);
  const bigSummary = 'a'.repeat(plan.limits.summary * 4);
  const out = assembleContext(plan, {
    candidates: [
      { kind: 'summary', items: [{ content: bigSummary, sourceIds: ['s1'], tokens: plan.limits.summary * 4 }] },
      { kind: 'retrieval', items: [{ content: '命中片段', sourceIds: ['s2'], tokens: 20 }] },
    ],
  });
  // summary 被截断到自身上限，retrieval 仍能拿到额度
  assert.ok(out.blocks.find((b) => b.kind === 'retrieval'));
  assert.ok(out.totalTokens <= plan.inputTotal);
});

test('assembleContext：总用量永不超过输入预算', () => {
  const plan = planBudget(5_000);
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ content: 'x'.repeat(400), sourceIds: [`id${i}`], tokens: 100 }));
  const out = assembleContext(plan, {
    candidates: [
      { kind: 'recent', items: items(100) },
      { kind: 'retrieval', items: items(100) },
      { kind: 'file', items: items(100) },
    ],
  });
  assert.ok(out.totalTokens <= plan.inputTotal, `${out.totalTokens} 应 <= ${plan.inputTotal}`);
  assert.equal(out.usage.overBudget, false);
});

test('emptyUsage：初始态包含输出预留', () => {
  const u = emptyUsage(1_000);
  assert.equal(u.total, 1_000);
  assert.equal(u.used, 50);
  assert.equal(u.overBudget, false);
  assert.equal(u.byKind.recent, 0);
});

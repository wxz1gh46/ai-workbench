import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EMPTY_PROMPT_SECTIONS } from '@ai/shared';
import { closeDb, createDb } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';
import { setSecretKeyForTest } from '../security/secrets.ts';
import { SECTION_KEYS, buildVariableSpecs, extractVariables, mergeSections, renderPrompt, renderWithCheck, toCopyableMarkdown } from './promptTemplate.ts';
import { classifyIntent, generatePrompt } from './promptGenerator.ts';
import { ensureConstraints, normalizeSteps, optimizeSections, scoreSections } from './promptOptimizer.ts';
import { PROMPT_LIBRARY, findTemplate } from './promptLibrary.ts';
import { PromptServiceV4 } from './promptServiceV4.ts';
import { aggregateVersion, decide, scoreLength, scoreStructure, scoreVariableCoverage } from './promptABTest.ts';

function setup(name: string) {
  closeDb();
  const dir = mkdtempSync(path.join(tmpdir(), `p4pr-${name}-`));
  setSecretKeyForTest('phase4-prompt-test-key-0123456789');
  process.env.DATA_DIR = dir;
  process.env.DB_FILE = path.join(dir, 'test.db');
  delete process.env.AI_API_KEY;
  const { db, sqlite } = createDb(process.env.DB_FILE);
  runMigrations();
  const now = new Date().toISOString();
  sqlite.prepare('INSERT INTO users (id, name, role, created_at) VALUES (?,?,?,?)').run('u1', 't', 'owner', now);
  sqlite.prepare('INSERT INTO workspaces (id, user_id, name, root_path, created_at, updated_at) VALUES (?,?,?,?,?,?)').run('ws1', 'u1', 'ws', dir, now, now);
  return {
    db,
    workspaceId: 'ws1',
    cleanup: () => {
      closeDb();
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* ------------------------------ 模板与变量 ------------------------------ */

test('变量抽取去重且保持出现顺序', () => {
  const sections = mergeSections(EMPTY_PROMPT_SECTIONS, { task: '{{b}} {{a}} {{b}}', context: '{{c}}' });
  assert.deepEqual(extractVariables(sections), ['b', 'a', 'c']);
});

test('变量类型按名字推断', () => {
  const specs = buildVariableSpecs(mergeSections(EMPTY_PROMPT_SECTIONS, { task: '{{count}} {{isReady}} {{topic}}' }));
  assert.equal(specs.find((s) => s.name === 'count')!.type, 'number');
  assert.equal(specs.find((s) => s.name === 'isReady')!.type, 'boolean');
  assert.equal(specs.find((s) => s.name === 'topic')!.type, 'string');
});

test('缺失变量保留占位而不是变成空串', () => {
  const out = renderPrompt(mergeSections(EMPTY_PROMPT_SECTIONS, { task: '分析 {{topic}} 的 {{unknown}}' }), { topic: '新能源' });
  assert.match(out, /分析 新能源 的 \{\{unknown\}\}/);
});

test('渲染校验：必填缺失、默认值填充、未知变量提示', () => {
  const sections = mergeSections(EMPTY_PROMPT_SECTIONS, { task: '{{a}} {{b}}' });
  const specs = [
    { name: 'a', type: 'string' as const, required: true, defaultValue: null, description: '', options: [] },
    { name: 'b', type: 'string' as const, required: false, defaultValue: '默认', description: '', options: [] },
  ];
  const bad = renderWithCheck(sections, {}, specs);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.missing, ['a']);
  const good = renderWithCheck(sections, { a: 'A' }, specs);
  assert.equal(good.ok, true);
  assert.match(good.rendered, /A 默认/);
  const unknown = renderWithCheck(sections, { a: 'A', zzz: 'Z' }, specs);
  assert.deepEqual(unknown.unknown, ['zzz']);
});

test('一键复制输出可直接粘贴的 Markdown', () => {
  const md = toCopyableMarkdown({ name: '测试模板', sections: mergeSections(EMPTY_PROMPT_SECTIONS, { role: '专家', task: '做事' }), variables: {} });
  assert.match(md, /^# 测试模板/m);
  assert.match(md, /## 角色\n专家/);
});

/* ------------------------------ 生成器 ------------------------------ */

test('意图分类覆盖六类', () => {
  assert.equal(classifyIntent('帮我写一个排序函数'), 'code');
  assert.equal(classifyIntent('写一份季度报告'), 'document');
  assert.equal(classifyIntent('分析这批数据的趋势'), 'data-analysis');
  assert.equal(classifyIntent('调研一下储能行业'), 'research');
  assert.equal(classifyIntent('把这个服务部署到线上'), 'deploy');
  assert.equal(classifyIntent('你好'), 'general');
});

test('生成器产出九要素齐全且可离线运行', () => {
  const res = generatePrompt({ goal: '写一个 LRU 缓存实现' });
  assert.equal(res.intent, 'code');
  for (const k of SECTION_KEYS) {
    if (k === 'examples') continue;
    assert.ok(res.sections[k].trim().length > 0, `缺少章节：${k}`);
  }
  assert.match(res.sections.constraints, /不得编造/);
  assert.match(res.sections.constraints, /不得硬编码/);
  assert.match(res.sections.steps, /^1\./m);
});

test('生成器拒绝空目标', () => {
  assert.throws(() => generatePrompt({ goal: '   ' }), /目标不能为空/);
});

/* ------------------------------ 优化器 ------------------------------ */

test('优化器补全缺失章节并记录说明', () => {
  const res = optimizeSections(mergeSections(EMPTY_PROMPT_SECTIONS, { task: '写点东西' }));
  assert.ok(res.sections.role.trim().length > 0);
  assert.ok(res.sections.outputFormat.trim().length > 0);
  assert.ok(res.sections.acceptance.trim().length > 0);
  assert.ok(res.sections.constraints.includes('不得编造事实'));
  assert.ok(res.sections.context.includes('边界条件'));
  assert.ok(res.notes.length >= 3);
});

test('优化器识别歧义表述并给出可执行建议', () => {
  const res = optimizeSections(mergeSections(EMPTY_PROMPT_SECTIONS, { task: '帮我优化一下代码，尽量好一点' }));
  const details = res.issues.map((i) => i.detail).join(' ');
  assert.match(details, /无法验收|模糊限定词/);
  assert.ok(res.issues.every((i) => i.suggestion.length > 0), '每条问题都要有建议');
});

test('步骤规范化统一为编号列表', () => {
  const out = normalizeSteps('- 第一步\n第二步\n3) 第三步');
  assert.equal(out, '1. 第一步\n2. 第二步\n3. 第三步');
});

test('约束补全不重复添加已有项', () => {
  const once = ensureConstraints('- 不得编造事实');
  assert.equal((once.match(/不得编造事实/g) ?? []).length, 1);
  assert.ok(once.includes('不得硬编码密钥'));
});

test('评分随内容完善度提升', () => {
  const poor = scoreSections(mergeSections(EMPTY_PROMPT_SECTIONS, { task: '做事' }));
  const rich = scoreSections({
    role: '你是资深工程师，只对确认过的事实负责。',
    task: '实现一个可测试的 LRU 缓存，包含边界处理与验证方式。',
    context: '运行在 Node 22，零依赖。边界条件：空输入、超大容量。',
    steps: '1. 明确接口\n2. 实现\n3. 写测试\n4. 自检',
    tools: '可用文件读写与单测工具。',
    constraints: '- 不得编造 API\n- 不得硬编码密钥',
    outputFormat: 'Markdown + 代码块',
    examples: '示例：输入 1,2 输出 2,1',
    acceptance: '所有测试通过，边界情况有明确处理。',
  });
  assert.ok(rich > poor, `${rich} 应大于 ${poor}`);
  assert.ok(rich <= 100 && rich >= 60);
});

/* ------------------------------ 模板库 ------------------------------ */

test('预置模板库九要素齐全且变量可解析', () => {
  assert.ok(PROMPT_LIBRARY.length >= 9, `预置模板应不少于 9 个，实际 ${PROMPT_LIBRARY.length}`);
  for (const t of PROMPT_LIBRARY) {
    const filled = SECTION_KEYS.filter((k) => t.sections[k].trim()).length;
    assert.ok(filled >= 8, `${t.key} 只填了 ${filled} 个章节`);
    const vars = extractVariables(t.sections);
    assert.ok(vars.length >= 1, `${t.key} 应至少有一个变量，方便用户填空`);
  }
});

test('模板 key 唯一且可查询', () => {
  const keys = PROMPT_LIBRARY.map((t) => t.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(findTemplate('code-review')?.name, '代码评审');
  assert.equal(findTemplate('nope'), undefined);
});

/* ------------------------------ 服务：保存 / 版本 / 回滚 ------------------------------ */

test('保存模板生成版本历史，同名递增版本', async () => {
  const ctx = setup('save');
  const svc = new PromptServiceV4(ctx.db);
  const v1 = await svc.save({ workspaceId: ctx.workspaceId, name: '我的模板', sections: mergeSections(EMPTY_PROMPT_SECTIONS, { role: '专家', task: '{{topic}}' }) });
  assert.equal(v1.version, 1);
  const v2 = await svc.save({ workspaceId: ctx.workspaceId, name: '我的模板', sections: mergeSections(EMPTY_PROMPT_SECTIONS, { role: '专家2', task: '{{topic}}' }) });
  assert.equal(v2.version, 2);
  assert.equal(v2.parentId, v1.templateId);

  const list = await svc.list(ctx.workspaceId);
  assert.equal(list.length, 1, '同名模板只应展示为一条');
  assert.deepEqual(list[0]!.versions.sort(), [1, 2]);

  const detail = await svc.detail(ctx.workspaceId, '我的模板');
  assert.equal(detail.version, 2);
  assert.equal(detail.history.length, 2);
  assert.equal(detail.variables.length, 1);
  ctx.cleanup();
});

test('版本回滚生成新版本而不删除历史', async () => {
  const ctx = setup('rollback');
  const svc = new PromptServiceV4(ctx.db);
  await svc.save({ workspaceId: ctx.workspaceId, name: 'T', sections: mergeSections(EMPTY_PROMPT_SECTIONS, { task: 'v1 内容' }) });
  await svc.save({ workspaceId: ctx.workspaceId, name: 'T', sections: mergeSections(EMPTY_PROMPT_SECTIONS, { task: 'v2 内容' }) });
  const rolled = await svc.rollbackVersion(ctx.workspaceId, 'T', 1);
  assert.equal(rolled.version, 3);
  const detail = await svc.detail(ctx.workspaceId, 'T');
  assert.match(detail.sections.task, /v1 内容/);
  assert.equal(detail.history.length, 3, '历史版本必须全部保留');
  ctx.cleanup();
});

test('从预置模板创建到工作区', async () => {
  const ctx = setup('library');
  const svc = new PromptServiceV4(ctx.db);
  const created = await svc.createFromLibrary(ctx.workspaceId, 'deep-research');
  assert.equal(created.version, 1);
  const list = await svc.list(ctx.workspaceId);
  assert.equal(list[0]!.name, '深度调研');
  await assert.rejects(() => svc.createFromLibrary(ctx.workspaceId, 'nope'), /预置模板不存在/);
  ctx.cleanup();
});

test('不存在的模板/版本返回可读错误', async () => {
  const ctx = setup('missing');
  const svc = new PromptServiceV4(ctx.db);
  await assert.rejects(() => svc.detail(ctx.workspaceId, '不存在的模板'), /模板不存在/);
  await svc.save({ workspaceId: ctx.workspaceId, name: 'X', sections: mergeSections(EMPTY_PROMPT_SECTIONS, { task: 'a' }) });
  await assert.rejects(() => svc.detail(ctx.workspaceId, 'X', 99), /不存在版本 99/);
  ctx.cleanup();
});

/* ------------------------------ 离线生成 / 优化 ------------------------------ */

test('无模型密钥时生成与优化仍可用，并标注 degraded', async () => {
  const ctx = setup('offline');
  const svc = new PromptServiceV4(ctx.db);
  const gen = await svc.generate({ workspaceId: ctx.workspaceId, goal: '调研 2026 年储能市场' });
  assert.equal(gen.degraded, true);
  assert.equal(gen.intent, 'research');
  assert.ok(gen.rendered.length > 50);

  const opt = await svc.optimize({ workspaceId: ctx.workspaceId, current: { task: '写报告' } });
  assert.equal(opt.degraded, true);
  assert.ok(opt.notes.some((n) => /未配置模型密钥/.test(n)));
  assert.ok(opt.score > 0);
  ctx.cleanup();
});

test('优化空提示词被拒绝', async () => {
  const ctx = setup('opt-empty');
  const svc = new PromptServiceV4(ctx.db);
  await assert.rejects(() => svc.optimize({ workspaceId: ctx.workspaceId, current: {} }), /不能为空/);
  ctx.cleanup();
});

test('一键复制返回缺失必填变量清单', () => {
  const ctxless = new PromptServiceV4(null as never);
  const res = ctxless.copyable({ sections: mergeSections(EMPTY_PROMPT_SECTIONS, { task: '{{a}}' }) });
  assert.equal(res.ok, true);
  assert.match(res.markdown, /\{\{a\}\}/);
});

/* ------------------------------ A/B 测试与评估 ------------------------------ */

test('A/B 指标校验：人工 1~5、自动 0~5，越界拒绝', async () => {
  const ctx = setup('ab-validate');
  const svc = new PromptServiceV4(ctx.db);
  await svc.save({ workspaceId: ctx.workspaceId, name: 'AB', sections: mergeSections(EMPTY_PROMPT_SECTIONS, { task: 'a' }) });
  await svc.save({ workspaceId: ctx.workspaceId, name: 'AB', sections: mergeSections(EMPTY_PROMPT_SECTIONS, { task: 'b' }) });
  const test0 = await svc.createABTest({ workspaceId: ctx.workspaceId, templateName: 'AB', versionA: 1, versionB: 2 });
  await assert.rejects(() => svc.recordEvaluation({ workspaceId: ctx.workspaceId, abTestId: test0.id, version: 'A', metric: 'accuracy', value: 0, sampleSize: 1 }), /必须在 1~5/);
  await assert.rejects(() => svc.recordEvaluation({ workspaceId: ctx.workspaceId, abTestId: test0.id, version: 'A', metric: 'accuracy', value: 9, sampleSize: 1 }), /必须在 1~5/);
  await assert.rejects(() => svc.recordEvaluation({ workspaceId: ctx.workspaceId, abTestId: test0.id, version: 'A', metric: 'structure', value: 9, sampleSize: 1 }), /必须在 0~5/);
  await assert.rejects(() => svc.recordEvaluation({ workspaceId: ctx.workspaceId, abTestId: test0.id, version: 'A', metric: 'accuracy', value: 3, sampleSize: 0 }), /sampleSize/);
  ctx.cleanup();
});

test('A/B 测试同版本被拒绝', async () => {
  const ctx = setup('ab-same');
  const svc = new PromptServiceV4(ctx.db);
  await svc.save({ workspaceId: ctx.workspaceId, name: 'S', sections: mergeSections(EMPTY_PROMPT_SECTIONS, { task: 'a' }) });
  await assert.rejects(() => svc.createABTest({ workspaceId: ctx.workspaceId, templateName: 'S', versionA: 1, versionB: 1 }), /两个不同版本/);
  ctx.cleanup();
});

test('A/B 自动评估产出结构/长度/变量覆盖三项指标', async () => {
  const ctx = setup('ab-auto');
  const svc = new PromptServiceV4(ctx.db);
  await svc.save({ workspaceId: ctx.workspaceId, name: 'A2', sections: mergeSections(EMPTY_PROMPT_SECTIONS, { role: '专家', task: '做事' }) });
  await svc.save({
    workspaceId: ctx.workspaceId,
    name: 'A2',
    sections: { role: '专家', task: '做事', context: '上下文', steps: '1. a\n2. b', tools: '工具', constraints: '约束', outputFormat: 'md', examples: '例', acceptance: '验收' },
  });
  const t = await svc.createABTest({ workspaceId: ctx.workspaceId, templateName: 'A2', versionA: 1, versionB: 2 });
  const auto = await svc.autoEvaluate({ workspaceId: ctx.workspaceId, abTestId: t.id });
  assert.equal(auto.results.length, 2);
  for (const r of auto.results) {
    const metrics = r.metrics.map((m) => m.metric);
    assert.deepEqual(metrics.sort(), ['length', 'structure', 'variableCoverage']);
  }
  const report = await svc.report(ctx.workspaceId, t.id);
  assert.equal(report.summary.length, 2);
  assert.ok(report.reason.length > 0);
  ctx.cleanup();
});

test('A/B 报告：人工样本不足时明确标注结论仅供参考', async () => {
  const ctx = setup('ab-sample');
  const svc = new PromptServiceV4(ctx.db);
  await svc.save({ workspaceId: ctx.workspaceId, name: 'S2', sections: mergeSections(EMPTY_PROMPT_SECTIONS, { task: 'a' }) });
  await svc.save({ workspaceId: ctx.workspaceId, name: 'S2', sections: mergeSections(EMPTY_PROMPT_SECTIONS, { task: 'a b c' }) });
  const t = await svc.createABTest({ workspaceId: ctx.workspaceId, templateName: 'S2', versionA: 1, versionB: 2 });
  await svc.recordEvaluation({ workspaceId: ctx.workspaceId, abTestId: t.id, version: 'A', metric: 'accuracy', value: 4, sampleSize: 1 });
  await svc.recordEvaluation({ workspaceId: ctx.workspaceId, abTestId: t.id, version: 'B', metric: 'accuracy', value: 2, sampleSize: 1 });
  const report = await svc.report(ctx.workspaceId, t.id);
  assert.equal(report.winner, 'A');
  assert.match(report.reason, /样本不足|仅供参考/);
  ctx.cleanup();
});

test('A/B 结束后再评分被拒绝', async () => {
  const ctx = setup('ab-finished');
  const svc = new PromptServiceV4(ctx.db);
  await svc.save({ workspaceId: ctx.workspaceId, name: 'F', sections: mergeSections(EMPTY_PROMPT_SECTIONS, { task: 'x' }) });
  await svc.save({ workspaceId: ctx.workspaceId, name: 'F', sections: mergeSections(EMPTY_PROMPT_SECTIONS, { task: 'y' }) });
  const t = await svc.createABTest({ workspaceId: ctx.workspaceId, templateName: 'F', versionA: 1, versionB: 2 });
  await svc.finishABTest(ctx.workspaceId, t.id);
  await assert.rejects(() => svc.recordEvaluation({ workspaceId: ctx.workspaceId, abTestId: t.id, version: 'A', metric: 'accuracy', value: 3, sampleSize: 1 }), /测试已结束/);
  ctx.cleanup();
});

test('聚合器权重：人工 0.75 / 自动 0.25', () => {
  const a = aggregateVersion({ version: 'A', metrics: [{ metric: 'accuracy', value: 5, sampleSize: 3 }, { metric: 'structure', value: 1, sampleSize: 1 }] });
  // 5*0.75 + 1*0.25 = 4.0
  assert.equal(a.score, 4);
});

test('胜负判定：持平或差异不显著时不给赢家', () => {
  const tie = decide({
    versionA: { version: 'A', metrics: [{ metric: 'accuracy', value: 3, sampleSize: 5 }] },
    versionB: { version: 'B', metrics: [{ metric: 'accuracy', value: 3, sampleSize: 5 }] },
  });
  assert.equal(tie.winner, null);
  assert.match(tie.reason, /不显著|相同/);

  const clear = decide({
    versionA: { version: 'A', metrics: [{ metric: 'accuracy', value: 5, sampleSize: 5 }] },
    versionB: { version: 'B', metrics: [{ metric: 'accuracy', value: 1, sampleSize: 5 }] },
  });
  assert.equal(clear.winner, 'A');
});

test('自动指标：结构完整度 / 长度合理性 / 变量覆盖', () => {
  assert.equal(scoreStructure(9, 9), 5);
  assert.equal(scoreStructure(0, 9), 0);
  assert.ok(scoreLength(800) > scoreLength(80));
  assert.ok(scoreLength(800) > scoreLength(20000));
  assert.equal(scoreVariableCoverage(0, 0), 5);
  assert.equal(scoreVariableCoverage(2, 1), 2.5);
});

test('A/B 服务不返回其他工作区的测试', async () => {
  const ctx = setup('ab-tenant');
  const svc = new PromptServiceV4(ctx.db);
  await svc.save({ workspaceId: ctx.workspaceId, name: 'X1', sections: mergeSections(EMPTY_PROMPT_SECTIONS, { task: 'x' }) });
  await svc.save({ workspaceId: ctx.workspaceId, name: 'X1', sections: mergeSections(EMPTY_PROMPT_SECTIONS, { task: 'y' }) });
  const t = await svc.createABTest({ workspaceId: ctx.workspaceId, templateName: 'X1', versionA: 1, versionB: 2 });
  const now = new Date().toISOString();
  const { getSqlite } = await import('../db/client.ts');
  getSqlite().prepare('INSERT INTO users (id, name, role, created_at) VALUES (?,?,?,?)').run('u2', 't2', 'owner', now);
  getSqlite().prepare('INSERT INTO workspaces (id, user_id, name, root_path, created_at, updated_at) VALUES (?,?,?,?,?,?)').run('ws2', 'u2', 'ws2', null, now, now);
  await assert.rejects(() => svc.report('ws2', t.id), /不存在/);
  assert.equal((await svc.listABTests('ws2')).length, 0);
  ctx.cleanup();
});

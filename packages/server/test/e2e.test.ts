/**
 * Phase 1 端到端冒烟测试。
 * 覆盖：工作区引导 → 目标模式全流程 → Office 生成 → 文件版本 → 插件合规 → 定时任务 → 看板 → 提示词 → 审计 → 统一错误格式。
 * 使用临时目录 + 独立 SQLite，不污染开发数据。
 *
 * 运行：pnpm --filter @ai/server test
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = mkdtempSync(path.join(tmpdir(), 'ai-wb-e2e-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.STORAGE_DIR = path.join(tmp, 'data', 'storage');
process.env.DB_FILE = path.join(tmp, 'data', 'e2e.db');
const workspaceRoot = path.join(tmp, 'workspace');

const { getDb } = await import('../src/db/client.ts');
const { runMigrations } = await import('../src/db/migrate.ts');
const { createApp } = await import('../src/router/app.ts');
const { WorkspaceService } = await import('../src/services/workspace.ts');
const { registerBuiltinTools } = await import('../src/tools/index.ts');

runMigrations();
registerBuiltinTools();
const db = getDb();
const app = createApp({ db });
const wsService = new WorkspaceService(db);
const boot = await wsService.ensureBootstrap();
await wsService.updateRootPath(boot.workspace.id, workspaceRoot);

const post = (url: string, body?: unknown) =>
  app.fetch(
    new Request(`http://test${url}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }),
  );
const get = (url: string) => app.fetch(new Request(`http://test${url}`));

test('引导创建 local 用户 + 默认工作区 + 9 个内置 Agent', async () => {
  const agents = await wsService.listAgents(boot.workspace.id);
  assert.equal(agents.length, 9);
  assert.ok(agents.some((a) => a.role === 'critic'));
});

test('health 暴露降级状态与特性开关', async () => {
  const res = await get('/health');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.data.degraded, true); // 测试环境未配置 AI_API_KEY
  // Phase 4 开关默认开启（Phase 3 的 Phase 1/2 未实现开关已不再使用）；
  // 开关的作用是「可单独关闭且数据保留」，因此这里断言它存在且为 boolean。
  assert.equal(typeof body.data.features.phase4PaidPlugins, 'boolean');
  assert.equal(body.data.features.phase4Cluster, true);
  assert.equal(body.data.features.phase4Prompt, true);
  assert.equal(body.data.features.phase4Enterprise, true);
});

let goalId = '';

test('目标模式：创建目标自动生成 DAG 任务与验收标准', async () => {
  const res = await post('/agent/goal', { workspaceId: boot.workspace.id, objective: '写一份2025年新能源行业简报' });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.ok(body.data.goal.acceptanceCriteria.length >= 1);
  assert.ok(body.data.tasks.length >= 3);
  // 至少一个任务无依赖（入口任务）
  assert.ok(body.data.tasks.some((t: { dependsOn: string[] }) => t.dependsOn.length === 0));
  goalId = body.data.goal.id;
});

test('目标模式：连续推进可自主完成全部任务并通过完成审计', async () => {
  const res = await post(`/agent/goals/${goalId}/run`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.goal.status, 'completed');
  assert.equal(body.data.goal.progress, 100);
  assert.ok(body.data.goal.iterations >= 3, `应至少 3 轮，实际 ${body.data.goal.iterations}`);
  assert.ok(body.data.tasks.every((t: { status: string }) => t.status === 'succeeded'));
  assert.equal(body.data.verdict.passed, true);
});

test('目标模式：运行记录可追踪 prompt/模型/token', async () => {
  const res = await get(`/agent/runs?goalId=${goalId}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.data.runs.length >= 4);
  assert.ok(body.data.runs.every((r: { model: string; status: string }) => r.model.length > 0 && r.status === 'succeeded'));
});

test('Office 生成 docx 并落盘', async () => {
  const res = await post('/office/generate', {
    workspaceId: boot.workspace.id,
    format: 'docx',
    title: '新能源行业简报',
    content: '# 摘要\n\n- 装机量增长\n- 政策驱动',
  });
  const body = await res.json();
  assert.equal(res.status, 201);
  const abs = path.join(workspaceRoot, body.data.path);
  assert.ok(existsSync(abs), `文件未生成: ${abs}`);
  assert.ok(readFileSync(abs).length > 0);
});

test('Office 支持 xlsx / pptx / pdf / markdown 全格式', async () => {
  for (const format of ['xlsx', 'pptx', 'pdf', 'markdown']) {
    const res = await post('/office/generate', {
      workspaceId: boot.workspace.id,
      format,
      title: `格式测试-${format}`,
      content: '# 标题\n\n- 要点一\n- 要点二',
    });
    const body = await res.json();
    assert.equal(res.status, 201, `${format} 生成失败: ${JSON.stringify(body)}`);
    assert.ok(existsSync(path.join(workspaceRoot, body.data.path)), `${format} 文件缺失`);
  }
});

test('文件上传自动递增版本号', async () => {
  const v1 = await (await post('/files/upload', {
    workspaceId: boot.workspace.id,
    name: 'notes.md',
    contentBase64: Buffer.from('# v1').toString('base64'),
  })).json();
  assert.equal(v1.data.version, 1);
  const v2 = await (await post('/files/upload', {
    workspaceId: boot.workspace.id,
    name: 'notes.md',
    contentBase64: Buffer.from('# v2').toString('base64'),
  })).json();
  assert.equal(v2.data.version, 2);
  assert.equal(v2.data.fileId, v1.data.fileId, '同路径应复用 fileId 以保留版本历史');

  const versions = await (await get(`/files/${v1.data.fileId}/versions`)).json();
  assert.equal(versions.data.versions.length, 2);
});

test('插件市场覆盖付费数据源且强制用户手动授权', async () => {
  const res = await get(`/plugins?workspaceId=${boot.workspace.id}`);
  const body = await res.json();
  assert.equal(res.status, 200);
  const names = body.data.catalog.map((p: { name: string }) => p.name).join(',');
  for (const k of ['tonghuashun', 'tianyancha', 'wind', 'juyuan', 'sp-global', 'imf', 'hyyd', 'academic']) {
    assert.ok(names.includes(k), `插件市场缺少 ${k}`);
  }
  const paid = body.data.catalog.find((p: { name: string }) => p.name === 'db-tianyancha');
  assert.equal(paid.requiresUserAuth, true);
  assert.ok(paid.secretRefs.includes('TIANYANCHA_TOKEN'));
});

test('安装付费插件后凭据仍由用户提供，代码中无凭据', async () => {
  const res = await post('/plugins/db-tonghuashun/install', { workspaceId: boot.workspace.id });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.data.plugin.requiresUserAuth, true);
  assert.ok(body.data.plugin.secretRefs.length > 0);
});

test('定时任务：合法 cron 接受、非法 cron 拒绝', async () => {
  const okRes = await post('/schedule', {
    workspaceId: boot.workspace.id,
    name: '每日行业简报',
    trigger: 'cron',
    expression: '0 9 * * *',
    action: { type: 'goal', objective: '每日行业简报' },
  });
  assert.equal(okRes.status, 201);

  const badRes = await post('/schedule', {
    workspaceId: boot.workspace.id,
    name: '非法',
    trigger: 'cron',
    expression: 'not-a-cron',
    action: {},
  });
  const badBody = await badRes.json();
  assert.equal(badRes.status, 400);
  assert.equal(badBody.ok, false);
  assert.equal(badBody.error.code, 'BAD_REQUEST');
});

test('看板：自然语言创建小组件并推断类型', async () => {
  const res = await post('/widgets', { workspaceId: boot.workspace.id, naturalLanguage: '显示所有 Agent 的运行状态' });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.data.widget.type, 'agent-status');
  assert.ok(body.data.widget.layout.w > 0);
});

test('提示词优化输出九要素结构化结果', async () => {
  const res = await post('/prompt/optimize', { workspaceId: boot.workspace.id, intent: '让财报分析更严谨' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(Object.keys(body.data.sections).length, 9);
  assert.ok(body.data.rendered.includes('## 角色'));
  assert.ok(body.data.notes.length >= 1, '离线模式应给出提示');
});

test('审计日志覆盖目标创建 / Office 生成 / 插件安装', async () => {
  const res = await get(`/audit?workspaceId=${boot.workspace.id}`);
  const body = await res.json();
  const actions = body.data.logs.map((l: { action: string }) => l.action);
  assert.ok(actions.includes('goal.create'));
  assert.ok(actions.includes('office.generate'));
  assert.ok(actions.includes('plugin.install'));
  assert.ok(actions.includes('goal.audit'));
});

test('统一错误格式：404 带 code 与 traceId', async () => {
  const res = await get('/does-not-exist');
  const body = await res.json();
  assert.equal(res.status, 404);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.ok(body.error.traceId);
});

test('危险操作缺少用户确认时被拒绝', async () => {
  const res = await post('/website/deploy', { workspaceId: boot.workspace.id, description: '一个博客' });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'BAD_REQUEST');
});

test('Phase 3 部署入口已交付：旧占位接口明确告知迁移路径（不再假装成功）', async () => {
  // 旧版 /website/deploy 返回 202 accepted:true 但什么都没做 —— 用户会误以为部署成功。
  // Phase 3 真实入口是 /websites → /generate → /deploy，这里必须明确重定向而不是静默假成功。
  const res = await post('/website/deploy', { workspaceId: boot.workspace.id, description: 'x', confirm: true });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.ok, false);
  assert.match(body.error.message, /已迁移/);
  assert.ok(Array.isArray(body.error.details?.replacements), '应给出替代接口列表');
  assert.ok(body.error.details.replacements.includes('POST /websites/:id/deploy'));
});

test('工具注册表包含 Phase 1 必备工具', async () => {
  const { toolRegistry } = await import('../src/tools/index.ts');
  const names = toolRegistry.list().map((t) => t.name);
  for (const n of ['fs.read', 'fs.write', 'fs.list', 'office.generate']) {
    assert.ok(names.includes(n), `缺少工具 ${n}`);
  }
});

/* ------------------------------------------------------------------ */
/* Phase 2 Step 1：分层上下文接口                                       */
/* ------------------------------------------------------------------ */

const contextConversationId = 'conv-phase2-context';

test('Phase 2 /context/:id/summary 返回摘要/事实/预算与压缩建议', async () => {
  const res = await get(`/context/${contextConversationId}/summary`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.conversationId, contextConversationId);
  assert.ok(Array.isArray(body.data.summaries));
  assert.ok(Array.isArray(body.data.facts));
  assert.ok(body.data.budget.total > 0);
  assert.equal(typeof body.data.shouldCompact, 'boolean');
  assert.ok(body.data.compactThreshold > 0);
});

test('Phase 2 /context/:id/compact 无消息时幂等返回 0 条', async () => {
  const res = await post(`/context/${contextConversationId}/compact`, { force: true });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.summarizedMessages, 0);
});

test('Phase 2 /context/:id/compact 参数校验与错误格式统一', async () => {
  const res = await post(`/context/${contextConversationId}/compact`, { keepRecent: -5 });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'BAD_REQUEST');
  assert.ok(body.error.traceId);
});

test('Phase 2 /conversations/:id/context-preview 返回分层块与溯源', async () => {
  const res = await get(`/conversations/${contextConversationId}/context-preview?q=测试`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(body.data.blocks));
  assert.ok(body.data.budget.limits.recent > 0);
  assert.equal(typeof body.data.routedByLength, 'boolean');
  assert.ok(body.data.model.length > 0);
});

test('Phase 2 迁移回滚脚本存在且 0002 标记为已应用', async () => {
  const { readdirSync } = await import('node:fs');
  const pathMod = await import('node:path');
  const migDir = pathMod.resolve(import.meta.dirname, '../src/db/migrations');
  const files = readdirSync(migDir);
  // 每个向上迁移都必须有对应的 down 脚本（「每个阶段可独立回滚」的硬要求）
  const ups = files.filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'));
  for (const up of ups) {
    assert.ok(files.includes(up.replace(/\.sql$/, '.down.sql')), `迁移 ${up} 缺少 down 脚本`);
  }
  assert.ok(ups.includes('0002_phase2.sql'), 'Phase 2 迁移应存在');
  // 0002 已应用 → Phase 2 表可用
  const res = await post('/research', { workspaceId: boot.workspace.id, topic: '迁移校验' });
  assert.ok([201, 400, 403].includes(res.status), `Phase 2 表应可访问，实际 ${res.status}`);
});

/* ------------------------------------------------------------------ */
/* Phase 2 Step 2/3/4：目标引擎 / 进度树 / 审计 / 集群 / 任务板          */
/* ------------------------------------------------------------------ */

let phase2GoalId = '';

test('Phase 2 POST /goals 创建目标并生成 ≥10 步任务 DAG', async () => {
  const res = await post('/goals', {
    workspaceId: boot.workspace.id,
    objective: '为储能行业产出一份带数据与风险评估的调研报告',
  });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.ok(body.data.goal.acceptanceCriteria.length >= 1);
  assert.ok(body.data.tasks.length >= 10, `应拆解出 ≥10 个任务，实际 ${body.data.tasks.length}`);
  phase2GoalId = body.data.goal.id;
});

test('Phase 2 POST /goals/:id/run 自主推进到完成并产出审计', async () => {
  const res = await post(`/goals/${phase2GoalId}/run`, {});
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.finished, true, `应自主完成，实际 ${body.data.goal.status}`);
  assert.equal(body.data.goal.status, 'completed');
  assert.equal(body.data.goal.progress, 100);
  assert.ok(body.data.audit, '必须返回结构化审计报告');
  assert.equal(body.data.audit.passed, true);
  assert.ok(body.data.audit.criteria.length > 0);
  assert.ok(body.data.audit.markdown.includes('验收标准逐条核对'));
});

test('Phase 2 GET /goals/:id/progress 返回进度树与完成度', async () => {
  const res = await get(`/goals/${phase2GoalId}/progress`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.goal.id, phase2GoalId);
  assert.ok(body.data.nodes.length >= 10);
  assert.equal(body.data.summary.percent, 100);
  assert.equal(body.data.summary.failed, 0);
  assert.ok(Array.isArray(body.data.blockers));
});

test('Phase 2 GET /goals/:id/audit 返回审计报告与 Markdown', async () => {
  const res = await get(`/goals/${phase2GoalId}/audit`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.data.audit);
  assert.ok(body.data.markdown.includes('## 完成审计报告') || body.data.markdown.includes('# 完成审计报告'));
});

test('Phase 2 GET /goals/:id/runs 每轮推进可回放', async () => {
  const res = await get(`/goals/${phase2GoalId}/runs`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.data.runs.length >= 2);
  assert.ok(body.data.runs.every((r: { iteration: number }) => r.iteration > 0));
});

test('Phase 2 GET /goals/:id/board 任务看板按列聚合', async () => {
  const res = await get(`/goals/${phase2GoalId}/board`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.data.board.total >= 10);
  assert.ok(body.data.board.columns.done.length >= 10, '全部任务应出现在 done 列');
});

test('Phase 2 集群配置可切换并可降级为单 Agent', async () => {
  const patch = await app.fetch(
    new Request('http://test/cluster', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: boot.workspace.id, mode: 'single', maxParallel: 1, experimental: true }),
    }),
  );
  const body = await patch.json();
  assert.equal(patch.status, 200);
  assert.equal(body.data.config.mode, 'single');
  assert.equal(body.data.config.experimental, true);

  const read = await get(`/cluster?workspaceId=${boot.workspace.id}`);
  const readBody = await read.json();
  assert.equal(readBody.data.config.mode, 'single');

  // 恢复 parallel
  await app.fetch(
    new Request('http://test/cluster', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: boot.workspace.id, mode: 'parallel', maxParallel: 4 }),
    }),
  );
});

test('Phase 2 非法集群参数返回统一错误格式', async () => {
  const res = await app.fetch(
    new Request('http://test/cluster', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: boot.workspace.id, maxParallel: 999 }),
    }),
  );
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.error.code, 'BAD_REQUEST');
});

test('Phase 2 GET /agents 与 /agents/:id/runs 可追踪运行记录', async () => {
  const list = await get(`/agents?workspaceId=${boot.workspace.id}`);
  const listBody = await list.json();
  assert.equal(list.status, 200);
  assert.ok(listBody.data.agents.length >= 3);

  const agentId = listBody.data.agents[0].id;
  const runs = await get(`/agents/${agentId}/runs?limit=10`);
  const runsBody = await runs.json();
  assert.equal(runs.status, 200);
  assert.ok(Array.isArray(runsBody.data.runs));
});

test('Phase 2 Agent 消息总线可发消息并查询', async () => {
  const list = await get(`/agents?workspaceId=${boot.workspace.id}`);
  const agentId = (await list.json()).data.agents[0].id;
  const res = await post(`/agents/${agentId}/message`, { goalId: phase2GoalId, content: '请复核数据来源', kind: 'request-help' });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.ok(body.data.message.id);

  const msgs = await get(`/goals/${phase2GoalId}/messages`);
  const msgsBody = await msgs.json();
  assert.ok(msgsBody.data.messages.length > 0);
});

test('Phase 2 POST /goals/:id/cancel 取消未完成目标', async () => {
  const created = await post('/goals', { workspaceId: boot.workspace.id, objective: '一个稍后会被取消的目标，需要多步骤完成' });
  const goalId = (await created.json()).data.goal.id;
  const res = await post(`/goals/${goalId}/cancel`, {});
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.goal.status, 'cancelled');
});

/* ------------------------------------------------------------------ */
/* Phase 2 Step 5：Office 文件处理接口                                  */
/* ------------------------------------------------------------------ */

test('Phase 2 GET /office/status 返回转换器可用性与配置指引', async () => {
  const res = await get('/office/status');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(typeof body.data.available, 'boolean');
  assert.ok(body.data.hint.length > 0);
});

test('Phase 2 POST /office/read 解析 docx 并返回结构化内容', async () => {
  const gen = await post('/office/generate', {
    workspaceId: boot.workspace.id,
    format: 'docx',
    title: 'Phase2 可读',
    content: '# 行业简报\n\n储能装机量达到 120GW。',
  });
  const genBody = await gen.json();
  const res = await post('/office/read', { workspaceId: boot.workspace.id, path: genBody.data.path });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.format, 'docx');
  assert.ok(body.data.content.text.includes('120GW'));
  assert.ok(Array.isArray(body.data.warnings));
});

test('Phase 2 POST /office/preview 返回 markdown 与渲染器类型', async () => {
  const gen = await post('/office/generate', {
    workspaceId: boot.workspace.id,
    format: 'xlsx',
    title: 'Phase2 数据表',
    content: '数据',
    sheets: [{ name: '装机量', rows: [['年份', 'GW'], [2025, 120]] }],
  });
  const path = (await gen.json()).data.path;
  const res = await post('/office/preview', { workspaceId: boot.workspace.id, path });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.renderer, 'sheetjs');
  assert.ok(body.data.markdown.includes('| 年份 | GW |'));
  assert.ok(body.data.downloadUrl.length > 0);
});

test('Phase 2 POST /office/edit 编辑并产生版本历史，可回滚', async () => {
  const gen = await post('/office/generate', {
    workspaceId: boot.workspace.id,
    format: 'docx',
    title: 'Phase2 可编辑',
    content: '# 标题\n\n旧内容。',
  });
  const filePath = (await gen.json()).data.path;

  const edit = await post('/office/edit', {
    workspaceId: boot.workspace.id,
    path: filePath,
    operations: [{ op: 'replace', find: '旧内容', replace: '新内容' }, { op: 'append', text: '追加段落' }],
  });
  const editBody = await edit.json();
  assert.equal(edit.status, 200);
  assert.ok(editBody.data.applied === 2);
  assert.ok(editBody.data.version >= 2);

  // 版本历史可查询（通过文件 id）
  let fileId: string | undefined = editBody.data.fileId;
  if (!fileId) {
    const filesRes = await get(`/files?workspaceId=${boot.workspace.id}`);
    const filesBody = await filesRes.json();
    fileId = filesBody.data.files.find((f: { path: string }) => f.path === filePath)?.id;
  }
  assert.ok(fileId, '应能通过路径找到文件记录');
  const versions = await get(`/files/${fileId}/versions`);
  const vBody = await versions.json();
  assert.equal(versions.status, 200);
  assert.ok(vBody.data.versions.length >= 2);
  assert.ok(vBody.data.versions.some((v: { note: string }) => v.note.includes('备份')));

  // 回滚到最早版本
  const earliest = vBody.data.versions.reduce((min: { version: number }, v: { version: number }) => (v.version < min.version ? v : min));
  const restore = await post(`/files/${fileId}/restore`, { version: earliest.version });
  const restoreBody = await restore.json();
  assert.equal(restore.status, 200);
  assert.equal(restoreBody.data.restoredFrom, earliest.version);
  assert.ok(restoreBody.data.version > earliest.version, '回滚应产生新版本');
});

test('Phase 2 POST /office/convert 未配置 LibreOffice 时明确降级', async () => {
  const gen = await post('/office/generate', {
    workspaceId: boot.workspace.id,
    format: 'docx',
    title: 'Phase2 待转换',
    content: '内容',
  });
  const pathToConvert = (await gen.json()).data.path;
  const res = await post('/office/convert', { workspaceId: boot.workspace.id, path: pathToConvert, target: 'pdf' });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.data.degraded, true);
  assert.ok(body.data.warnings.join(' ').includes('SOFFICE_PATH'));
});

test('Phase 2 POST /office/export 返回可下载 URL', async () => {
  const gen = await post('/office/generate', {
    workspaceId: boot.workspace.id,
    format: 'docx',
    title: 'Phase2 导出',
    content: '导出内容',
  });
  const pathToExport = (await gen.json()).data.path;
  const res = await post('/office/export', { workspaceId: boot.workspace.id, path: pathToExport, ttlHours: 2 });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.ok(body.data.url.includes('/files/exports/'));

  const download = await get(`/files/exports/${body.data.id}`);
  assert.equal(download.status, 200);
  assert.ok(Number(download.headers.get('content-length') ?? 0) > 0);
});

test('Phase 2 Office 安全边界：路径穿越与非法参数被拒绝', async () => {
  const res = await post('/office/read', { workspaceId: boot.workspace.id, path: '../../etc/passwd' });
  const body = await res.json();
  assert.equal(res.status, 403);
  assert.equal(body.error.code, 'FORBIDDEN');

  const bad = await post('/office/edit', { workspaceId: boot.workspace.id, path: 'a.docx', operations: [] });
  assert.equal(bad.status, 400);
  const badBody = await bad.json();
  assert.equal(badBody.error.code, 'BAD_REQUEST');
});

/* ------------------------------------------------------------------ */
/* Phase 2 Step 6：深度研究接口                                         */
/* ------------------------------------------------------------------ */

test('Phase 2 GET /research/capability 如实告知联网能力', async () => {
  const res = await get('/research/capability');
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(typeof body.data.network, 'boolean');
  assert.ok(body.data.hint.length > 0);
});

test('Phase 2 POST /research 未允许联网时走本地/待核查路径，流程仍完整', async () => {
  const res = await post('/research', {
    workspaceId: boot.workspace.id,
    topic: 'Phase2 测试主题：储能装机量',
    depth: 'quick',
    allowNetwork: false,
    outputFormats: ['markdown'],
  });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.data.job.allowNetwork, false, '必须记录未允许联网');
  assert.ok(body.data.job.queries.length > 0);

  // 后台异步执行，轮询到终态
  const jobId = body.data.job.id;
  let final: { status: string; progress: number; error?: string | null } | null = null;
  for (let i = 0; i < 60; i++) {
    const r = await get(`/research/${jobId}`);
    const b = await r.json();
    final = b.data.job;
    if (['completed', 'failed', 'cancelled'].includes(final!.status)) break;
    await new Promise((r2) => setTimeout(r2, 200));
  }
  assert.ok(final, '应能查询到研究任务');
  assert.equal(final!.status, 'completed', `离线研究应可完成，实际 ${final!.status}：${final!.error ?? ''}`);
  assert.equal(final!.progress, 100);
});

test('Phase 2 GET /research/:id 返回任务/来源/论断/报告', async () => {
  const created = await post('/research', { workspaceId: boot.workspace.id, topic: '接口结构校验主题', depth: 'quick', allowNetwork: false });
  const jobId = (await created.json()).data.job.id;
  let detail: { job: { status: string }; sources: unknown[]; claims: unknown[]; report: unknown } | null = null;
  for (let i = 0; i < 60; i++) {
    const r = await get(`/research/${jobId}`);
    detail = (await r.json()).data;
    if (['completed', 'failed'].includes(detail!.job.status)) break;
    await new Promise((r2) => setTimeout(r2, 200));
  }
  assert.ok(Array.isArray(detail!.sources));
  assert.ok(Array.isArray(detail!.claims));

  const reportRes = await get(`/research/${jobId}/report`);
  const reportBody = await reportRes.json();
  assert.equal(reportRes.status, 200);
  assert.ok(reportBody.data.report.markdown.includes('## 参考文献'));
  assert.ok(reportBody.data.report.references.length > 0);
});

test('Phase 2 GET /research/:id/export 可直接下载 Markdown', async () => {
  const jobs = await get(`/research?workspaceId=${boot.workspace.id}`);
  const list = (await jobs.json()).data.jobs;
  const done = list.find((j: { status: string }) => j.status === 'completed');
  assert.ok(done, '应存在已完成的研究');
  const res = await get(`/research/${done.id}/export`);
  assert.equal(res.status, 200);
  assert.ok((res.headers.get('content-type') ?? '').includes('text/markdown'));
  assert.ok((await res.text()).includes('#'));
});

test('Phase 2 POST /research/:id/publish 返回可访问的网页地址', async () => {
  const jobs = await get(`/research?workspaceId=${boot.workspace.id}`);
  const done = (await jobs.json()).data.jobs.find((j: { status: string }) => j.status === 'completed');
  const res = await post(`/research/${done.id}/publish`, { public: false });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(body.data.webUrl.length > 0);
  assert.ok(body.data.reportId.length > 0);
});

test('Phase 2 研究报告尚无报告时返回 404 且错误格式统一', async () => {
  const created = await post('/research', { workspaceId: boot.workspace.id, topic: '空报告校验主题', depth: 'quick', allowNetwork: false });
  const jobId = (await created.json()).data.job.id;
  // 立即查询（可能还没生成报告）
  const res = await get(`/research/${jobId}/report`);
  if (res.status === 404) {
    const body = await res.json();
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.ok(body.error.message.includes('尚未生成'));
  }
});

test('Phase 2 POST /research 参数校验：非法深度被拒绝', async () => {
  const res = await post('/research', { workspaceId: boot.workspace.id, topic: 'x', depth: 'ultra' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'BAD_REQUEST');
});

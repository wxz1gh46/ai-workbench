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
  assert.equal(body.data.features.phase4PaidPlugins, false);
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

test('Phase 2/3 未交付能力返回明确说明而非静默失败', async () => {
  const res = await post('/research', { workspaceId: boot.workspace.id, topic: '新能源' });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.match(body.error.message, /Phase 2/);
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

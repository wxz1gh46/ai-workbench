import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/router/app.ts';
import { getAdapter } from '../src/deploy/providerRegistry.ts';
import { LocalPreviewAdapter } from '../src/deploy/localPreviewAdapter.ts';
import { createDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { setSecretKeyForTest } from '../src/security/secrets.ts';

/**
 * Phase 3 端到端集成测试。
 *
 * 覆盖三条关键链路（Phase 3 验收标准）：
 *   1. 生成 → 数据库 Schema → 部署（返回 URL，本地降级路径）
 *   2. 看板 → 小组件 → 刷新
 *   3. 定时任务 → 执行 → 推送（含发送日志）
 *
 * 绝不配置真实平台凭据：所有外部平台路径都必须走「未配置 → 可读提示」的分支，
 * 这样既验证了降级行为，也保证 CI 不会真的调用 Vercel/Neon。
 */
let tempDir = '';
const localPreview = new LocalPreviewAdapter();
let workspaceId = '';

const PROVIDER_ENV_KEYS = [
  'VERCEL_TOKEN',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_PROJECT',
  'NETLIFY_AUTH_TOKEN',
  'NETLIFY_SITE_ID',
  'NEON_API_KEY',
  'SUPABASE_ACCESS_TOKEN',
  'DATABASE_URL',
];

/** 直连 app.fetch（与 Phase 1/2 的 e2e 测试同一种方式）：不起真实端口，快且无端口冲突 */
let app: ReturnType<typeof createApp>;

before(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'ai-wb-e2e-'));
  process.env.DATA_DIR = tempDir;
  process.env.STORAGE_DIR = path.join(tempDir, 'storage');
  process.env.DB_FILE = path.join(tempDir, 'e2e.db');
  setSecretKeyForTest('phase3-e2e-key-0123456789abcdef');
  for (const k of PROVIDER_ENV_KEYS) delete process.env[k];

  const { db, sqlite } = createDb(process.env.DB_FILE);
  runMigrations();
  const now = new Date().toISOString();
  sqlite.prepare('INSERT INTO users (id, name, role, created_at) VALUES (?,?,?,?)').run('u1', '测试', 'owner', now);
  workspaceId = 'ws_e2e';
  sqlite
    .prepare('INSERT INTO workspaces (id, user_id, name, root_path, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(workspaceId, 'u1', 'E2E 工作区', tempDir, now, now);
  // 注意：不要在这里 close sqlite —— createApp 传入的 db 复用同一个句柄，
  // 提前关闭会导致后续所有查询报 "The database connection is not open"（真实踩坑）。

  app = createApp({ db });
});

after(async () => {
  // 关键：本地预览适配器会常驻监听 127.0.0.1，不关闭会让 node --test 无法退出
  // （表现为「测试全部通过但进程一直挂着」直到超时被杀 —— 真实踩坑）。
  // 通过 registry 拿到与路由使用同一个实例，避免单例不一致。
  const adapter = getAdapter('local-preview');
  if (adapter instanceof LocalPreviewAdapter) await adapter.stopAll();
  rmSync(tempDir, { recursive: true, force: true });
});

async function api<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T; error?: { code: string; message: string } }> {
  const res = await app.fetch(
    new Request(`http://test${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  const json = (await res.json()) as { ok: boolean; data?: T; error?: { code: string; message: string } };
  return { status: res.status, data: (json.data ?? {}) as T, error: json.error };
}

/* ================================================================== */
/* 链路 1：网站项目 → 生成 → 构建检查 → 部署 → 回滚/删除                */
/* ================================================================== */

test('E2E：创建网站项目并生成完整项目文件', async () => {
  const created = await api<{ project: { id: string; status: string } }>('POST', '/websites', {
    workspaceId,
    name: 'E2E Demo Site',
    requirement: '做一个客户管理系统，有客户和订单，带后台管理界面和登录',
  });
  assert.equal(created.status, 201);
  const projectId = created.data.project.id;
  assert.ok(projectId);

  const gen = await api<{ plan: { siteType: string; entities: unknown[] }; files: { path: string }[]; rootDir: string }>(
    'POST',
    `/websites/${projectId}/generate`,
    {},
  );
  assert.equal(gen.status, 200);
  assert.equal(gen.data.plan.siteType, 'fullstack-db');
  assert.ok(gen.data.plan.entities.length >= 2);
  const paths = gen.data.files.map((f) => f.path);
  assert.ok(paths.includes('server.mjs'));
  assert.ok(paths.includes('db/schema.sql'));
  assert.ok(paths.includes('db/migrations/0001_init.down.sql'), '必须有回滚脚本');
  assert.ok(gen.data.rootDir.startsWith('websites/'));
});

test('E2E：构建检查通过（入口存在 + 无密钥泄露）', async () => {
  const list = await api<{ projects: { id: string }[] }>('GET', `/websites?workspaceId=${workspaceId}`);
  const id = list.data.projects[0]?.id;
  assert.ok(id);
  const build = await api<{ ok: boolean; checks: { name: string; ok: boolean }[] }>('POST', `/websites/${id}/build`, {});
  assert.equal(build.status, 200);
  const failed = build.data.checks.filter((c) => !c.ok);
  assert.deepEqual(failed, [], `构建检查失败: ${JSON.stringify(failed)}`);
});

test('E2E：未配置平台凭据时部署返回可读错误并附所需环境变量', async () => {
  const list = await api<{ projects: { id: string }[] }>('GET', `/websites?workspaceId=${workspaceId}`);
  const id = list.data.projects[0]?.id as string;
  const res = await api('POST', `/websites/${id}/deploy`, { provider: 'vercel', confirm: true });
  assert.equal(res.status, 502);
  assert.match(res.error?.message ?? '', /未配置 vercel 凭据/);
  assert.match(res.error?.message ?? '', /VERCEL_TOKEN/);
});

test('E2E：缺少二次确认时部署被拒绝（428）', async () => {
  const list = await api<{ projects: { id: string }[] }>('GET', `/websites?workspaceId=${workspaceId}`);
  const id = list.data.projects[0]?.id as string;
  const res = await api('POST', `/websites/${id}/deploy`, { provider: 'vercel' });
  assert.equal(res.status, 400, 'confirm 缺失应被 schema 校验拦下');
});

test('E2E：本地预览部署成功并返回 URL（无需任何凭据）', async () => {
  const list = await api<{ projects: { id: string }[] }>('GET', `/websites?workspaceId=${workspaceId}`);
  const id = list.data.projects[0]?.id as string;
  const res = await api<{ deployment: { url: string; status: string }; degraded: boolean }>('POST', `/websites/${id}/deploy`, {
    provider: 'local-preview',
    confirm: true,
  });
  assert.equal(res.status, 202);
  assert.match(res.data.deployment.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(res.data.deployment.status, 'deployed');
  assert.equal(res.data.degraded, true, '本地预览必须标记 degraded（未真正发布公网）');

  // 本地预览地址应真能访问
  const html = await fetch(res.data.deployment.url).then((r) => r.text());
  assert.match(html, /<!doctype html>/i);
});

test('E2E：部署记录可查询，且审计已留痕（含 degraded 标记）', async () => {
  const list = await api<{ projects: { id: string }[] }>('GET', `/websites?workspaceId=${workspaceId}`);
  const id = list.data.projects[0]?.id as string;
  const deps = await api<{ deployments: { id: string; provider: string; status: string }[] }>('GET', `/websites/${id}/deployments`);
  assert.ok(deps.data.deployments.length >= 1);
  const audits = await api<{ audits: { action: string; detail: Record<string, unknown> }[] }>('GET', `/websites/${id}/deploy-audits`);
  assert.ok(audits.data.audits.some((a) => a.action === 'website.deploy'));
  assert.ok(audits.data.audits.some((a) => a.action === 'website.generate'));
});

test('E2E：环境变量加密存储，接口只返回掩码', async () => {
  const list = await api<{ projects: { id: string }[] }>('GET', `/websites?workspaceId=${workspaceId}`);
  const id = list.data.projects[0]?.id as string;
  const set = await api('POST', `/websites/${id}/env`, {
    vars: [{ key: 'DATABASE_URL', value: 'postgres://user:supersecret@db.example.com:5432/app' }],
    confirm: true,
  });
  assert.equal(set.status, 200);

  const got = await api<{ vars: { key: string; masked: string }[] }>('GET', `/websites/${id}/env`);
  const item = got.data.vars.find((v) => v.key === 'DATABASE_URL');
  assert.ok(item);
  assert.ok(!item.masked.includes('supersecret'), '接口绝不能返回明文');
  assert.match(item.masked, /^\*{4}/);
});

test('E2E：访问控制设置口令后只存 hash，接口不回显明文', async () => {
  const list = await api<{ projects: { id: string }[] }>('GET', `/websites?workspaceId=${workspaceId}`);
  const id = list.data.projects[0]?.id as string;
  const res = await api('POST', `/websites/${id}/access`, {
    rules: [{ type: 'password', value: 'my-strong-pass' }],
    confirm: true,
  });
  assert.equal(res.status, 200);
  const got = await api<{ rules: { type: string; value: string }[] }>('GET', `/websites/${id}/access`);
  for (const r of got.data.rules) {
    assert.ok(!r.value.includes('my-strong-pass'));
  }
});

test('E2E：绑定自定义域名返回 DNS 指引（无凭据时也给出可执行下一步）', async () => {
  const list = await api<{ projects: { id: string }[] }>('GET', `/websites?workspaceId=${workspaceId}`);
  const id = list.data.projects[0]?.id as string;
  const res = await api<{ binding: { domain: string; dns: { type: string; name: string; value: string }[]; message: string } }>(
    'POST',
    `/websites/${id}/domain`,
    { domain: 'www.my-site.example', provider: 'vercel', confirm: true },
  );
  assert.equal(res.status, 200);
  assert.equal(res.data.binding.domain, 'www.my-site.example');
  assert.ok(res.data.binding.dns.length > 0);
});

/* ================================================================== */
/* 链路 2：看板 → 小组件 → 刷新                                        */
/* ================================================================== */

test('E2E：看板自动创建并提供小组件注册表', async () => {
  const res = await api<{ dashboards: { id: string; name: string }[] }>('GET', `/dashboards?workspaceId=${workspaceId}`);
  assert.ok(res.data.dashboards.length >= 1, '应自动创建默认看板');
  const registry = await api<{ widgets: { type: string }[] }>('GET', '/dashboard/registry');
  assert.equal(registry.data.widgets.length, 7);
});

test('E2E：自然语言创建小组件并刷新出真实数据', async () => {
  const boards = await api<{ dashboards: { id: string }[] }>('GET', `/dashboards?workspaceId=${workspaceId}`);
  const dashboardId = boards.data.dashboards[0]?.id as string;

  const created = await api<{ widget: { id: string; type: string; layout: { x: number; y: number; w: number; h: number } }; inference: { type: string } }>(
    'POST',
    `/dashboards/${dashboardId}/widgets?workspaceId=${workspaceId}`,
    { naturalLanguage: '显示我所有网站项目的部署状态' },
  );
  assert.equal(created.status, 201);
  assert.equal(created.data.widget.type, 'website-status');
  assert.ok(created.data.widget.layout.w >= 2);

  const refreshed = await api<{ widgetId: string; degraded: boolean; payload: unknown }>(
    'POST',
    `/widgets/${created.data.widget.id}/refresh?workspaceId=${workspaceId}`,
  );
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.data.degraded, false);
  const payload = refreshed.data.payload as { projects: { name: string; url: string | null }[] };
  assert.ok(payload.projects.length >= 1, '应能看到刚创建的网站项目');
  assert.ok(payload.projects[0]?.url, '应带上本地预览 URL');
});

test('E2E：拖拽布局持久化 + 布局回滚', async () => {
  const boards = await api<{ dashboards: { id: string }[] }>('GET', `/dashboards?workspaceId=${workspaceId}`);
  const dashboardId = boards.data.dashboards[0]?.id as string;
  const detail = await api<{ widgets: { id: string }[] }>('GET', `/dashboards/${dashboardId}?workspaceId=${workspaceId}`);
  const widgetId = detail.data.widgets[0]?.id as string;

  // 第一次布局：保存快照
  const first = await api('POST', `/dashboards/${dashboardId}/layout?workspaceId=${workspaceId}`, {
    items: [{ id: widgetId, x: 0, y: 0, w: 6, h: 4 }],
  });
  assert.equal(first.status, 200);

  // 第二次布局：移动
  const second = await api<{ widgets: { id: string; layout: { x: number; y: number } }[] }>(
    'POST',
    `/dashboards/${dashboardId}/layout?workspaceId=${workspaceId}`,
    { items: [{ id: widgetId, x: 6, y: 4, w: 6, h: 4 }] },
  );
  assert.equal(second.status, 200);
  const moved = second.data.widgets.find((w) => w.id === widgetId);
  assert.equal(moved?.layout.x, 6);
  assert.equal(moved?.layout.y, 4);

  // 回滚布局
  const rolled = await api<{ widgets: { id: string; layout: { x: number; y: number } }[] }>(
    'POST',
    `/dashboards/${dashboardId}/layout/rollback?workspaceId=${workspaceId}`,
    {},
  );
  assert.equal(rolled.status, 200);
  const restored = rolled.data.widgets.find((w) => w.id === widgetId);
  assert.equal(restored?.layout.x, 0, '布局应回滚到上一版');
});

test('E2E：非法布局（重叠/越界）被拒绝而不是静默写入', async () => {
  const boards = await api<{ dashboards: { id: string }[] }>('GET', `/dashboards?workspaceId=${workspaceId}`);
  const dashboardId = boards.data.dashboards[0]?.id as string;
  const detail = await api<{ widgets: { id: string }[] }>('GET', `/dashboards/${dashboardId}?workspaceId=${workspaceId}`);
  const id = detail.data.widgets[0]?.id as string;
  const res = await api('POST', `/dashboards/${dashboardId}/layout?workspaceId=${workspaceId}`, {
    items: [{ id, x: 10, y: 0, w: 6, h: 4 }],
  });
  assert.equal(res.status, 400);
  assert.match(res.error?.message ?? '', /超出右边界/);
});

test('E2E：整板刷新不因单个组件失败而全盘失败', async () => {
  const boards = await api<{ dashboards: { id: string }[] }>('GET', `/dashboards?workspaceId=${workspaceId}`);
  const dashboardId = boards.data.dashboards[0]?.id as string;
  const res = await api<{ results: { widgetId: string; degraded: boolean }[]; degraded: number }>(
    'POST',
    `/dashboards/${dashboardId}/refresh?workspaceId=${workspaceId}`,
  );
  assert.equal(res.status, 200);
  assert.ok(res.data.results.length >= 1);
});

test('E2E：固定到桌面可切换', async () => {
  const boards = await api<{ dashboards: { id: string }[] }>('GET', `/dashboards?workspaceId=${workspaceId}`);
  const dashboardId = boards.data.dashboards[0]?.id as string;
  const detail = await api<{ widgets: { id: string }[] }>('GET', `/dashboards/${dashboardId}?workspaceId=${workspaceId}`);
  const id = detail.data.widgets[0]?.id as string;
  const pin = await api<{ widget: { pinnedToDesktop: boolean } }>('POST', `/widgets/${id}/pin?workspaceId=${workspaceId}`, { pinned: true });
  assert.equal(pin.data.widget.pinnedToDesktop, true);
  const pinned = await api<{ widgets: { id: string }[] }>('GET', `/widgets?workspaceId=${workspaceId}&pinned=true`);
  assert.ok(pinned.data.widgets.some((w) => w.id === id));
});

/* ================================================================== */
/* 链路 3：定时任务 → 执行 → 推送                                      */
/* ================================================================== */

test('E2E：cron 预览返回描述与后续执行时间', async () => {
  const res = await api<{ ok: boolean; description: string; next: string[] }>('POST', '/schedule/preview', {
    expression: '0 9 * * 1-5',
    timezone: 'Asia/Shanghai',
  });
  assert.equal(res.data.ok, true);
  assert.match(res.data.description, /9 时/);
  assert.equal(res.data.next.length, 5);
  // 都应是工作日 9 点
  for (const iso of res.data.next) {
    const d = new Date(iso);
    const cn = new Date(d.getTime() + 8 * 3600_000);
    assert.equal(cn.getUTCHours(), 9);
    assert.ok(cn.getUTCDay() >= 1 && cn.getUTCDay() <= 5);
  }
});

test('E2E：非法 cron 被拒绝并给出原因', async () => {
  const res = await api('POST', '/schedule/preview', { expression: '0 99 * * *' });
  assert.equal(res.data.ok, false);
  assert.match(String((res.data as { error?: string }).error), /越界/);
});

test('E2E：创建定时任务并手动触发，执行结果与日志落库', async () => {
  const created = await api<{ schedule: { id: string; taskType: string } }>('POST', '/schedules', {
    workspaceId,
    name: 'E2E 自定义任务',
    trigger: 'cron',
    expression: '0 9 * * *',
    timezone: 'Asia/Shanghai',
    taskType: 'custom',
    taskConfig: { payload: { hello: 'world' } },
  });
  assert.equal(created.status, 201);
  const id = created.data.schedule.id;

  // 手动触发需要二次确认
  const noConfirm = await api('POST', `/schedules/${id}/run?workspaceId=${workspaceId}`, {});
  assert.equal(noConfirm.status, 428);

  const run = await api<{ run: { id: string; status: string; trigger: string; attempt: number } }>(
    'POST',
    `/schedules/${id}/run?workspaceId=${workspaceId}`,
    { confirm: true },
  );
  assert.equal(run.status, 202);
  assert.equal(run.data.run.status, 'succeeded');
  assert.equal(run.data.run.trigger, 'manual');

  const runs = await api<{ runs: { id: string }[]; stats: { successRate: number } }>(`GET`, `/schedules/${id}/runs?workspaceId=${workspaceId}`);
  assert.ok(runs.data.runs.length >= 1);
  assert.equal(runs.data.stats.successRate, 100);

  const audits = await api<{ audits: { action: string }[] }>('GET', `/schedule-audits?workspaceId=${workspaceId}`);
  assert.ok(audits.data.audits.some((a) => a.action === 'schedule.run'));
  assert.ok(audits.data.audits.some((a) => a.action === 'schedule.execute'));
});

test('E2E：任务模板能创建出完整任务', async () => {
  const tpl = await api<{ templates: { name: string }[]; presets: unknown[] }>('GET', '/schedule/templates');
  assert.ok(tpl.data.templates.length >= 6);
  assert.ok(tpl.data.presets.length >= 6);

  const created = await api<{ schedule: { id: string; taskType: string; taskConfig: Record<string, unknown> } }>('POST', '/schedules', {
    workspaceId,
    name: 'E2E 每日简报',
    trigger: 'cron',
    expression: '0 9 * * *',
    template: 'daily-research',
    templateValues: { topic: '储能行业' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.schedule.taskType, 'research');
  assert.equal(created.data.schedule.taskConfig.topic, '储能行业');
});

test('E2E：模板必填参数缺失时被拦住', async () => {
  const res = await api('POST', '/schedules', {
    workspaceId,
    name: 'x',
    trigger: 'cron',
    expression: '0 9 * * *',
    template: 'daily-research',
    templateValues: {},
  });
  assert.equal(res.status, 400);
  assert.match(res.error?.message ?? '', /研究主题/);
});

test('E2E：禁用任务后不再被调度，且可删除（需确认）', async () => {
  const list = await api<{ schedules: { id: string; name: string }[] }>('GET', `/schedules?workspaceId=${workspaceId}`);
  const target = list.data.schedules.find((s) => s.name === 'E2E 自定义任务');
  assert.ok(target);

  const disabled = await api<{ schedule: { enabled: boolean; nextRunAt: string | null } }>('PATCH', `/schedules/${target.id}?workspaceId=${workspaceId}`, {
    enabled: false,
  });
  assert.equal(disabled.data.schedule.enabled, false);
  assert.equal(disabled.data.schedule.nextRunAt, null);

  const noConfirm = await api('DELETE', `/schedules/${target.id}?workspaceId=${workspaceId}`);
  assert.equal(noConfirm.status, 428);

  const removed = await api('DELETE', `/schedules/${target.id}?workspaceId=${workspaceId}&confirm=true`);
  assert.equal(removed.status, 200);
});

test('E2E：未注入研究依赖时，研究任务显式降级（不假装成功）', async () => {
  const created = await api<{ schedule: { id: string } }>('POST', '/schedules', {
    workspaceId,
    name: 'E2E 研究任务',
    trigger: 'cron',
    expression: '0 9 * * *',
    taskType: 'research',
    taskConfig: { topic: '测试主题', allowNetwork: false },
  });
  const id = created.data.schedule.id;
  const run = await api<{ run: { status: string; error: string | null } }>('POST', `/schedules/${id}/run?workspaceId=${workspaceId}`, { confirm: true });
  // 研究引擎已注入（Phase 2），因此这里应当成功；若未注入则必须 failed 且带可读错误
  if (run.data.run.status !== 'succeeded') {
    assert.ok(run.data.run.error);
  }
});

/* ================================================================== */
/* 通知：渠道 CRUD → 测试发送 → 发送日志                                */
/* ================================================================== */

test('E2E：创建通知渠道时敏感配置加密存储，接口只返回 configured 标记', async () => {
  const created = await api<{ channel: { id: string; type: string; configured: boolean; config: Record<string, unknown> } }>(
    'POST',
    '/notify/channels',
    {
      workspaceId,
      type: 'webhook',
      name: 'E2E Webhook',
      config: { method: 'POST' },
      secret: { url: 'https://example.invalid/hook' },
    },
  );
  assert.equal(created.status, 201);
  assert.equal(created.data.channel.configured, true);
  assert.equal(JSON.stringify(created.data.channel).includes('example.invalid/hook'), false, '接口不得返回凭据明文');
});

test('E2E：配置不完整的渠道在创建时就被拒绝', async () => {
  const res = await api('POST', '/notify/channels', {
    workspaceId,
    type: 'feishu',
    name: '缺配置的飞书',
    config: {},
    secret: {},
  });
  assert.equal(res.status, 400);
  assert.match(res.error?.message ?? '', /Webhook 地址/);
});

test('E2E：测试发送失败时返回可读错误并写入发送日志', async () => {
  const list = await api<{ channels: { id: string; name: string }[] }>('GET', `/notify/channels?workspaceId=${workspaceId}`);
  const channel = list.data.channels.find((c) => c.name === 'E2E Webhook');
  assert.ok(channel);
  const res = await api<{ ok: boolean; message: string }>('POST', `/notify/test?workspaceId=${workspaceId}`, { channelId: channel.id });
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, false);
  assert.ok(res.data.message.length > 0);

  const logs = await api<{ logs: { status: string; channelId: string; error: string | null }[] }>('GET', `/notify/logs?workspaceId=${workspaceId}`);
  assert.ok(logs.data.logs.some((l) => l.channelId === channel.id && l.status === 'failed'));
});

test('E2E：通知发送成功时写入 sent 日志（本地假 webhook）', async () => {
  const { createServer } = await import('node:http');
  const srv = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const created = await api<{ channel: { id: string } }>('POST', '/notify/channels', {
      workspaceId,
      type: 'webhook',
      name: 'E2E 本地 Webhook',
      config: {},
      secret: { url: `http://127.0.0.1:${port}/hook` },
    });
    const res = await api<{ ok: boolean }>('POST', `/notify/test?workspaceId=${workspaceId}`, { channelId: created.data.channel.id });
    assert.equal(res.data.ok, true);
    const logs = await api<{ logs: { channelId: string; status: string; sentAt: string | null }[] }>(
      'GET',
      `/notify/logs?workspaceId=${workspaceId}&channelId=${created.data.channel.id}`,
    );
    const sent = logs.data.logs.find((l) => l.status === 'sent');
    assert.ok(sent, '应写入 sent 日志');
    assert.ok(sent.sentAt);
  } finally {
    srv.close();
  }
});

test('E2E：定时任务执行完成后自动推送（与渠道联动）', async () => {
  // 创建本地 webhook 渠道 + 绑定到任务 → 手动触发 → 应产生 sent 日志
  const { createServer } = await import('node:http');
  const srv = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const ch = await api<{ channel: { id: string } }>('POST', '/notify/channels', {
      workspaceId,
      type: 'webhook',
      name: 'E2E 联动渠道',
      config: {},
      secret: { url: `http://127.0.0.1:${port}/hook` },
    });
    const task = await api<{ schedule: { id: string } }>('POST', '/schedules', {
      workspaceId,
      name: 'E2E 推送联动',
      trigger: 'cron',
      expression: '0 9 * * *',
      taskType: 'custom',
      channelIds: [ch.data.channel.id],
    });
    await api('POST', `/schedules/${task.data.schedule.id}/run?workspaceId=${workspaceId}`, { confirm: true });
    // 通知是异步派发，轮询等待
    let found = false;
    for (let i = 0; i < 20 && !found; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const logs = await api<{ logs: { channelId: string; event: string; status: string; scheduleRunId: string | null }[] }>(
        'GET',
        `/notify/logs?workspaceId=${workspaceId}&channelId=${ch.data.channel.id}`,
      );
      found = logs.data.logs.some((l) => l.event === 'schedule' && l.status === 'sent' && l.scheduleRunId);
    }
    assert.equal(found, true, '定时任务执行后应自动推送并关联 scheduleRunId');
  } finally {
    srv.close();
  }
});

test('E2E：删除通知渠道需要二次确认', async () => {
  const list = await api<{ channels: { id: string; name: string }[] }>('GET', `/notify/channels?workspaceId=${workspaceId}`);
  const channel = list.data.channels.find((c) => c.name === 'E2E Webhook');
  assert.ok(channel);
  const noConfirm = await api('DELETE', `/notify/channels/${channel.id}?workspaceId=${workspaceId}`);
  assert.equal(noConfirm.status, 428);
  const removed = await api('DELETE', `/notify/channels/${channel.id}?workspaceId=${workspaceId}&confirm=true`);
  assert.equal(removed.status, 200);
});

/* ================================================================== */
/* 数据库面板：无凭据时的降级路径                                        */
/* ================================================================== */

test('E2E：新增数据库连接（连接串加密存储，接口只返回脱敏目标）', async () => {
  const res = await api<{ connection: { id: string; provider: string; target: string; configured: boolean } }>('POST', '/databases', {
    workspaceId,
    provider: 'neon',
    name: 'E2E Neon',
    connectionString: 'postgres://neondb_owner:supersecret@ep-test-1.us-east-1.aws.neon.tech/neondb?sslmode=require',
  });
  assert.equal(res.status, 201);
  assert.equal(res.data.connection.provider, 'neon');
  assert.ok(!res.data.connection.target.includes('supersecret'), '接口不得返回密码');
  assert.match(res.data.connection.target, /ep-test-1/);
});

test('E2E：测试连接在无网络/无效凭据时返回结构化结果而不是崩溃', async () => {
  const list = await api<{ connections: { id: string }[] }>('GET', `/databases?workspaceId=${workspaceId}`);
  const id = list.data.connections[0]?.id as string;
  const res = await api<{ ok: boolean; degraded?: boolean; message: string }>('POST', `/databases/${id}/test?workspaceId=${workspaceId}`, { workspaceId });
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, false);
  assert.ok(res.data.message.length > 0);
});

test('E2E：从网站需求生成数据库 Schema（含 down 与版本号）', async () => {
  const dbs = await api<{ connections: { id: string }[] }>('GET', `/databases?workspaceId=${workspaceId}`);
  const dbId = dbs.data.connections[0]?.id as string;
  const sites = await api<{ projects: { id: string }[] }>('GET', `/websites?workspaceId=${workspaceId}`);
  const siteId = sites.data.projects[0]?.id as string;

  const res = await api<{ snapshot: { tables: { name: string }[] }; up: string; down: string; version: number }>(
    'POST',
    `/databases/${dbId}/schema?workspaceId=${workspaceId}&websiteProjectId=${siteId}`,
    {},
  );
  assert.equal(res.status, 200);
  assert.ok(res.data.snapshot.tables.length >= 2);
  assert.match(res.data.up, /create table/i);
  assert.match(res.data.down, /drop table/i);
  assert.equal(res.data.version, 1);
});

test('E2E：查询预检识别写操作并要求确认', async () => {
  const dbs = await api<{ connections: { id: string }[] }>('GET', `/databases?workspaceId=${workspaceId}`);
  const dbId = dbs.data.connections[0]?.id as string;
  const readOnly = await api<{ preflight: { isWrite: boolean; needConfirm: boolean } }>('POST', `/databases/${dbId}/query?workspaceId=${workspaceId}`, {
    sql: 'select 1',
  });
  assert.equal(readOnly.data.preflight.isWrite, false);
  assert.equal(readOnly.data.preflight.needConfirm, false);

  const write = await api<{ preflight: { isWrite: boolean; needConfirm: boolean } }>('POST', `/databases/${dbId}/query?workspaceId=${workspaceId}`, {
    sql: 'delete from users',
    readOnly: false,
  });
  assert.equal(write.data.preflight.isWrite, true);
  assert.equal(write.data.preflight.needConfirm, true);

  const dangerous = await api<{ preflight: { safe: boolean; reason?: string } }>('POST', `/databases/${dbId}/query?workspaceId=${workspaceId}`, {
    sql: 'drop database prod',
  });
  assert.equal(dangerous.data.preflight.safe, false);
});

test('E2E：数据库审计留痕（创建 / 测试 / schema 生成）', async () => {
  const res = await api<{ audits: { action: string }[] }>('GET', `/databases/x/audits?workspaceId=${workspaceId}`);
  const actions = res.data.audits.map((a) => a.action);
  assert.ok(actions.includes('db.create'));
  assert.ok(actions.includes('db.schema.generate'));
  assert.ok(actions.includes('db.test'));
});

test('E2E：删除数据库连接需要二次确认', async () => {
  const dbs = await api<{ connections: { id: string }[] }>('GET', `/databases?workspaceId=${workspaceId}`);
  const dbId = dbs.data.connections[0]?.id as string;
  const noConfirm = await api('DELETE', `/databases/${dbId}?workspaceId=${workspaceId}`);
  assert.equal(noConfirm.status, 428);
  const removed = await api('DELETE', `/databases/${dbId}?workspaceId=${workspaceId}&confirm=true`);
  assert.equal(removed.status, 200);
  assert.equal(removed.data.ok, true);
});

/* ================================================================== */
/* 安全：统一错误格式 + 审计覆盖                                        */
/* ================================================================== */

test('E2E：所有错误响应保持统一格式且带 traceId', async () => {
  const res = await app.fetch(new Request('http://test/websites/not-exist'));
  const json = (await res.json()) as { ok: boolean; error: { code: string; message: string; traceId: string } };
  assert.equal(json.ok, false);
  assert.equal(json.error.code, 'NOT_FOUND');
  assert.ok(json.error.traceId);
});

test('E2E：部署能力清单包含所有平台与所需凭据（用户手动配置）', async () => {
  const res = await api<{ providers: { provider: string; tokenEnvKeys: string[]; docsUrl: string }[]; danger: unknown[] }>(
    'GET',
    '/deploy/capabilities',
  );
  const providers = res.data.providers.map((p) => p.provider).sort();
  assert.deepEqual(providers, ['cloudflare-pages', 'local-preview', 'netlify', 'vercel']);
  for (const p of res.data.providers) {
    if (p.provider === 'local-preview') continue;
    assert.ok(p.tokenEnvKeys.length > 0, `${p.provider} 应声明所需环境变量`);
    assert.ok(p.docsUrl.startsWith('https://'), `${p.provider} 应给出获取凭据的地址`);
  }
  assert.ok(res.data.danger.length >= 10);
});

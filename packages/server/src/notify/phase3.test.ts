import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getNotifier, listNotifierMeta, notifiers } from './registry.ts';
import { DesktopNotifier } from './desktopNotifier.ts';
import { WebhookNotifier } from './webhookNotifier.ts';
import { FeishuNotifier } from './feishuNotifier.ts';
import { DingtalkNotifier } from './dingtalkNotifier.ts';
import { WecomNotifier } from './wecomNotifier.ts';
import type { NotifierContext } from './notifier.ts';
import type { NotifyMessage } from '@ai/shared';

const msg = { event: 'schedule' as const, title: '测试标题', content: '测试内容', level: 'info' as const };

function ctx(config: Record<string, unknown> = {}, secret: Record<string, unknown> = {}): NotifierContext {
  return { config, secret, channelId: 'test' };
}

/* ================================================================== */
/* 注册表：6 个渠道全齐                                                */
/* ================================================================== */

test('通知注册表：覆盖提示词要求的 6 个渠道', () => {
  const types = Object.keys(notifiers).sort();
  assert.deepEqual(types, ['desktop', 'dingtalk', 'email', 'feishu', 'webhook', 'wecom']);
});

test('通知元信息：每个渠道都声明了必填字段（供 UI 生成表单）', () => {
  const meta = listNotifierMeta();
  assert.equal(meta.length, 6);
  for (const m of meta) {
    assert.ok(m.label);
    assert.ok(Array.isArray(m.secretFields) && Array.isArray(m.configFields));
    // 除桌面通知外都必须有敏感凭据字段
    if (m.type !== 'desktop') {
      assert.ok(m.secretFields.length > 0, `${m.type} 应声明敏感字段`);
      assert.ok(m.secretFields.some((f) => f.required), `${m.type} 应有必填敏感字段`);
    }
  }
});

test('getNotifier：未知类型返回 undefined 而不是抛错', () => {
  assert.equal(getNotifier('nope' as never), undefined);
});

/* ================================================================== */
/* 配置校验：缺凭据要在保存时就报错，而不是发送时才失败                  */
/* ================================================================== */

test('配置校验：webhook 缺 url 被拒绝', () => {
  const n = new WebhookNotifier();
  assert.throws(() => n.validate(ctx()), /缺少/);
  assert.throws(() => n.validate(ctx({}, { url: '' })), /Webhook 地址/);
  assert.doesNotThrow(() => n.validate(ctx({}, { url: 'https://example.com/hook' })));
});

test('配置校验：飞书/钉钉/企微 缺 webhook 被拒绝', () => {
  for (const n of [new FeishuNotifier(), new DingtalkNotifier(), new WecomNotifier()]) {
    assert.throws(() => n.validate(ctx()), /缺少/, `${n.label} 应拒绝空配置`);
    assert.doesNotThrow(() => n.validate(ctx({}, { webhookUrl: 'https://example.com/hook' })), `${n.label} 应通过`);
  }
});

test('配置校验：邮件缺 SMTP 必填项被拒绝，且指出具体字段', () => {
  const n = getNotifier('email');
  assert.throws(
    () => n.validate(ctx({ host: 'smtp.qq.com', port: 465, user: 'a@qq.com' }, {})),
    /SMTP 口令|password/,
  );
  assert.throws(() => n.validate(ctx({}, { password: 'x' })), /SMTP 主机/);
  assert.doesNotThrow(() =>
    n.validate(ctx({ host: 'smtp.qq.com', port: 465, user: 'a@qq.com', to: 'b@qq.com' }, { password: 'x' })),
  );
});

test('配置校验：桌面通知无需任何凭据', () => {
  assert.doesNotThrow(() => new DesktopNotifier().validate(ctx()));
});

/* ================================================================== */
/* 桌面通知：写入 outbox 并显式标记 degraded（不假装已弹窗）             */
/* ================================================================== */

test('桌面通知：写入 outbox 且标记 degraded', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-wb-notify-'));
  const saved = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  try {
    const res = await new DesktopNotifier().send(msg, ctx());
    assert.equal(res.ok, true);
    assert.equal(res.degraded, true, '无 Tauri 环境必须标记 degraded，不能假装弹窗');
    assert.match(String(res.detail?.note), /outbox/);
  } finally {
    process.env.DATA_DIR = saved;
    await rmrf(dir);
  }
});

/* ================================================================== */
/* Webhook：真实 HTTP 请求（本地起服务，不外呼）                        */
/* ================================================================== */

test('Webhook：发送真实 POST 且 payload 含事件/标题/正文', async () => {
  const received: { body: unknown; headers: Record<string, string> }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ body: JSON.parse(body) as unknown, headers: req.headers as Record<string, string> });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  const port = await listen(server);
  try {
    const n = new WebhookNotifier();
    const res = await n.send({ ...msg, url: 'https://site.example.com' }, ctx({}, { url: `http://127.0.0.1:${port}/hook` }));
    assert.equal(res.ok, true);
    const first = received[0];
    assert.ok(first);
    const body = first.body as { event: string; title: string; content: string; url: string; text: string };
    assert.equal(body.event, 'schedule');
    assert.equal(body.title, '测试标题');
    assert.match(body.text, /测试内容/);
    assert.equal(body.url, 'https://site.example.com');
  } finally {
    server.close();
  }
});

test('Webhook：自定义鉴权 Header 被正确附加', async () => {
  let auth: string | undefined;
  const server = createServer((req, res) => {
    auth = req.headers.authorization;
    res.writeHead(200).end('{}');
  });
  const port = await listen(server);
  try {
    await new WebhookNotifier().send(msg, ctx({}, { url: `http://127.0.0.1:${port}/h`, authHeader: 'Bearer abc123' }));
    assert.equal(auth, 'Bearer abc123');
  } finally {
    server.close();
  }
});

test('Webhook：非 2xx 返回抛出可读错误（触发重试）', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(500).end('boom');
  });
  const port = await listen(server);
  try {
    await assert.rejects(new WebhookNotifier().send(msg, ctx({}, { url: `http://127.0.0.1:${port}/h` })), /HTTP 500/);
  } finally {
    server.close();
  }
});

test('Webhook：附加 Header 非法 JSON 时给出可读错误', async () => {
  await assert.rejects(
    new WebhookNotifier().send(msg, ctx({ headers: 'not-json' }, { url: 'http://127.0.0.1:1/h' })),
    /不是合法 JSON/,
  );
});

/* ================================================================== */
/* 飞书 / 钉钉 / 企微：请求体格式与失败处理（本地假服务）                */
/* ================================================================== */

test('飞书：请求体为 msg_type=text，成功返回 message_id', async () => {
  let body: Record<string, unknown> = {};
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      body = JSON.parse(raw) as Record<string, unknown>;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, msg: 'success', data: { message_id: 'om_x1' } }));
    });
  });
  const port = await listen(server);
  try {
    const res = await new FeishuNotifier().send(msg, ctx({}, { webhookUrl: `http://127.0.0.1:${port}/hook` }));
    assert.equal(res.ok, true);
    assert.equal(res.messageId, 'om_x1');
    assert.equal(body.msg_type, 'text');
    assert.match(JSON.stringify((body.content as { text: string }).text), /测试内容/);
  } finally {
    server.close();
  }
});

test('飞书：code != 0 时抛错（业务错误不能当成功）', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 19021, msg: 'sign match fail' }));
  });
  const port = await listen(server);
  try {
    await assert.rejects(
      new FeishuNotifier().send(msg, ctx({}, { webhookUrl: `http://127.0.0.1:${port}/h` })),
      /sign match fail/,
    );
  } finally {
    server.close();
  }
});

test('飞书：配置了签名密钥时会带上 timestamp 与 sign', async () => {
  let body: Record<string, unknown> = {};
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      body = JSON.parse(raw) as Record<string, unknown>;
      res.writeHead(200).end('{"code":0}');
    });
  });
  const port = await listen(server);
  try {
    await new FeishuNotifier().send(msg, ctx({}, { webhookUrl: `http://127.0.0.1:${port}/h`, signSecret: 'my-secret' }));
    assert.ok(body.timestamp);
    assert.ok(body.sign);
  } finally {
    server.close();
  }
});

test('钉钉：请求体为 msgtype=text，加签时 url 追加 timestamp/sign', async () => {
  let url = '';
  let body: Record<string, unknown> = {};
  const server = createServer((req, res) => {
    url = req.url ?? '';
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      body = JSON.parse(raw) as Record<string, unknown>;
      res.writeHead(200).end('{"errcode":0,"errmsg":"ok"}');
    });
  });
  const port = await listen(server);
  try {
    await new DingtalkNotifier().send(msg, ctx({}, { webhookUrl: `http://127.0.0.1:${port}/robot/send?access_token=x`, signSecret: 'SECxxx' }));
    assert.match(url, /timestamp=\d+/);
    assert.match(url, /sign=/);
    assert.equal(body.msgtype, 'text');
  } finally {
    server.close();
  }
});

test('钉钉：errcode != 0 时抛错', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200).end('{"errcode":310000,"errmsg":"keywords not in content"}');
  });
  const port = await listen(server);
  try {
    await assert.rejects(
      new DingtalkNotifier().send(msg, ctx({}, { webhookUrl: `http://127.0.0.1:${port}/h` })),
      /keywords not in content/,
    );
  } finally {
    server.close();
  }
});

test('企业微信：支持 @ 成员列表', async () => {
  let body: Record<string, unknown> = {};
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      body = JSON.parse(raw) as Record<string, unknown>;
      res.writeHead(200).end('{"errcode":0}');
    });
  });
  const port = await listen(server);
  try {
    await new WecomNotifier().send(msg, ctx({ mentionedList: ['zhangsan', '@all'] }, { webhookUrl: `http://127.0.0.1:${port}/h` }));
    assert.equal(body.msgtype, 'text');
    assert.deepEqual((body.text as { mentioned_list: string[] }).mentioned_list, ['zhangsan', '@all']);
  } finally {
    server.close();
  }
});

test('企业微信：未配置 @ 列表时不带 mentioned_list 字段', async () => {
  let body: Record<string, unknown> = {};
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      body = JSON.parse(raw) as Record<string, unknown>;
      res.writeHead(200).end('{"errcode":0}');
    });
  });
  const port = await listen(server);
  try {
    await new WecomNotifier().send(msg, ctx({}, { webhookUrl: `http://127.0.0.1:${port}/h` }));
    assert.equal((body.text as Record<string, unknown>).mentioned_list, undefined);
  } finally {
    server.close();
  }
});

test('通知超时：连不上的地址不会永久挂死（有超时保护）', async () => {
  await assert.rejects(
    new WebhookNotifier().send(msg, ctx({}, { url: 'http://127.0.0.1:9/none' })),
    (e: unknown) => e instanceof Error,
  );
});

/* ================================================================== */
/* 消息渲染                                                            */
/* ================================================================== */

test('消息渲染：level 决定图标，url 追加链接', async () => {
  const n = new WebhookNotifier();
  const rendered = (n as unknown as { render: (m: NotifyMessage) => string }).render({
    event: 'error',
    title: '失败',
    content: '详情',
    url: 'https://x.y',
    level: 'error',
  });
  assert.match(rendered, /❌/);
  assert.match(rendered, /https:\/\/x\.y/);
});

/* ---------- 测试辅助 ---------- */
function listen(server: Server): Promise<number> {
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      ok(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

async function rmrf(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

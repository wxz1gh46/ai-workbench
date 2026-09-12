import type { WebsitePlan } from '@ai/shared';
import { envExample, escapeHtml, gitignore, readme, styles, type GeneratedFile } from './templates.ts';
import { staticSiteBuilderFor } from './staticSiteBuilder.ts';

/**
 * 全栈站生成器。
 *
 * 生成物：
 *   - server.mjs   零依赖 Node HTTP 服务，提供 /api/* 与静态资源
 *   - api/*.mjs    每个实体一组 REST 处理函数（参数化 SQL，禁止字符串拼接）
 *   - db/schema.sql        建表 DDL（Neon / Supabase 可直接执行）
 *   - db/migrations/*.sql  版本化迁移（含 down 脚本）
 *   - public/*     前端页面（复用静态站产物）
 *
 * 数据库接入原则：
 *   - 连接串只从 process.env.DATABASE_URL 读，代码里没有默认值；
 *   - 未配置 DATABASE_URL 时接口返回 503 + 可读提示，并标记 degraded，
 *     绝不静默返回假数据（Phase 2 的一贯要求）。
 */

export function buildFullstackSite(plan: WebsitePlan, projectName: string, requirement: string): GeneratedFile[] {
  const frontFiles = staticSiteBuilderFor(plan, projectName, requirement);
  const files: GeneratedFile[] = [];

  // 前端产物放到 public/
  for (const f of frontFiles) {
    if (f.path === 'package.json' || f.path === 'server.mjs' || f.path === 'README.md' || f.path === '.gitignore' || f.path === '.env.example') continue;
    files.push({ path: `public/${f.path}`, content: f.content, key: f.key });
  }

  // 数据访问层
  if (plan.entities.length > 0) files.push({ path: 'api/_db.mjs', key: true, content: dbModule() });
  for (const entity of plan.entities) {
    files.push({ path: `api/${entity.name}.mjs`, key: true, content: entityRouter(entity, plan) });
  }
  files.push({ path: 'api/contact.mjs', content: contactRouter(plan) });

  // 服务入口
  files.push({ path: 'server.mjs', key: true, content: serverEntry(plan) });

  // 数据库
  if (plan.needsDatabase) {
    files.push({ path: 'db/schema.sql', key: true, content: schemaSql(plan) });
    files.push({ path: 'db/migrations/0001_init.sql', key: true, content: schemaSql(plan) });
    files.push({ path: 'db/migrations/0001_init.down.sql', content: downSql(plan) });
    files.push({ path: 'db/README.md', content: dbReadme(plan) });
  }

  files.push({ path: 'package.json', content: fullstackPackageJson(projectName, plan) });
  files.push({ path: 'README.md', content: readme(projectName, plan, requirement) });
  files.push({ path: '.env.example', content: envExample(plan) });
  files.push({ path: '.gitignore', content: gitignore() });
  files.push({ path: 'assets/styles.css', content: styles(plan) });

  return files;
}

function fullstackPackageJson(name: string, plan: WebsitePlan): string {
  const deps: Record<string, string> = {};
  if (plan.needsDatabase) deps.pg = '^8.13.1';
  return (
    JSON.stringify(
      {
        name,
        version: '1.0.0',
        private: true,
        type: 'module',
        scripts: {
          dev: 'node server.mjs',
          start: 'node server.mjs',
          'db:schema': 'node -e "console.log(require(\'node:fs\').readFileSync(\'db/schema.sql\',\'utf8\'))"',
        },
        ...(Object.keys(deps).length ? { dependencies: deps } : {}),
      },
      null,
      2,
    ) + '\n'
  );
}

function dbModule(): string {
  return `/**
 * 数据访问层（由 AI 工作台生成）。
 *
 * 安全约定：
 *   - 连接串只读 process.env.DATABASE_URL，代码中不存在任何默认凭据；
 *   - 全部查询使用参数化占位符（$1,$2…），禁止字符串拼接用户输入；
 *   - 未配置连接串 / 未安装 pg 时显式降级（503），不返回伪造数据。
 */
let Pool = null;
let loadError = null;

// 动态加载 pg：未 npm install 时不应让整个服务崩掉，
// 而是让 /api/health 明确报告「数据库不可用」。
try {
  const pg = await import('pg');
  Pool = pg.default?.Pool ?? pg.Pool;
} catch (e) {
  loadError = e instanceof Error ? e.message : String(e);
}

let pool = null;

export function hasDatabase() {
  return Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim()) && Boolean(Pool);
}

export function databaseStatus() {
  if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.trim()) return 'unconfigured';
  if (!Pool) return 'driver-missing';
  return 'configured';
}

export function databaseHint() {
  if (databaseStatus() === 'driver-missing') return '未安装 pg 驱动：请执行 npm install';
  if (databaseStatus() === 'unconfigured') return '未配置 DATABASE_URL：请在部署平台的环境变量中填入 Neon / Supabase 连接串';
  return null;
}

export function getPool() {
  if (!hasDatabase()) {
    const err = new Error(databaseHint() ?? '数据库不可用');
    err.statusCode = 503;
    throw err;
  }
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // 云端 Postgres（Neon / Supabase）必须启用 SSL；本地开发可用 PGSSLMODE=disable 覆盖
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true },
      max: Number(process.env.PG_POOL_MAX ?? 5),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}

export async function query(sql, params = []) {
  const started = Date.now();
  const res = await getPool().query(sql, params);
  return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length, ms: Date.now() - started };
}

/** 只允许白名单列参与 ORDER BY，避免注入 */
export function safeOrderBy(input, allowed, fallback) {
  const v = String(input ?? '').trim();
  if (!v) return fallback;
  const [col, dirRaw] = v.split(':');
  if (!allowed.includes(col)) return fallback;
  const dir = String(dirRaw ?? 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  return col + ' ' + dir;
}
`;
}

function entityRouter(entity: WebsitePlan['entities'][number], _plan: WebsitePlan): string {
  const cols = entity.columns.map((c) => c.name);
  const insertable = cols.filter((c) => c !== 'id' && c !== 'created_at');
  return `// 由 AI 工作台生成：${entity.name} 的资源路由（参数化查询）
import { query, hasDatabase, safeOrderBy } from './_db.mjs';

const TABLE = '${entity.name}';
const ORDERABLE = ${JSON.stringify(['id', 'created_at', ...cols])};

export const routes = [
  { method: 'GET', path: '/api/${entity.name}', handler: list },
  { method: 'POST', path: '/api/${entity.name}', handler: create },
];

export async function list(req, res, ctx) {
  if (!hasDatabase()) return ctx.degraded(res);
  const limit = Math.min(Number(ctx.query.get('limit') ?? 50) || 50, 200);
  const offset = Math.max(Number(ctx.query.get('offset') ?? 0) || 0, 0);
  const orderBy = safeOrderBy(ctx.query.get('order'), ORDERABLE, 'created_at DESC');
  const { rows, rowCount, ms } = await query(
    'SELECT * FROM ' + TABLE + ' ORDER BY ' + orderBy + ' LIMIT $1 OFFSET $2',
    [limit, offset],
  );
  ctx.json(res, 200, { data: rows, count: rowCount, ms });
}

export async function create(req, res, ctx) {
  if (!hasDatabase()) return ctx.degraded(res);
  const body = await ctx.readJson(req);
  const fields = ${JSON.stringify(insertable)};
  const used = fields.filter((f) => body[f] !== undefined);
  if (used.length === 0) return ctx.json(res, 400, { error: '至少需要一个字段：' + fields.join(', ') });
  const placeholders = used.map((_, i) => '$' + (i + 1)).join(', ');
  const { rows } = await query(
    'INSERT INTO ' + TABLE + ' (' + used.join(', ') + ') VALUES (' + placeholders + ') RETURNING *',
    used.map((f) => body[f]),
  );
  ctx.json(res, 201, { data: rows[0] });
}
`;
}

function contactRouter(plan: WebsitePlan): string {
  const hasDb = plan.entities.some((e) => e.name === 'messages');
  return `// 由 AI 工作台生成：留言表单接口
${hasDb ? "import { query, hasDatabase } from './_db.mjs';" : ''}

export const routes = [{ method: 'POST', path: '/api/contact', handler: submit }];

export async function submit(req, res, ctx) {
  const body = await ctx.readJson(req);
  const name = String(body.name ?? '').slice(0, 200);
  const email = String(body.email ?? '').slice(0, 200);
  const content = String(body.content ?? '').slice(0, 5000);
  if (!name || !content) return ctx.json(res, 400, { error: 'name 与 content 必填' });
${hasDb ? `  if (hasDatabase()) {
    const { rows } = await query(
      'INSERT INTO messages (author, email, content, created_at) VALUES ($1, $2, $3, NOW()) RETURNING id',
      [name, email, content],
    );
    return ctx.json(res, 201, { data: { id: rows[0]?.id ?? null } });
  }` : ''}
  // 无数据库时只回执，不落盘（显式声明降级）
  ctx.json(res, 202, { data: { received: true, persisted: false, note: '未配置数据库，留言未持久化' } });
}
`;
}

function serverEntry(plan: WebsitePlan): string {
  const routeImports = plan.entities
    .map((e) => `import { routes as ${e.name}Routes } from './api/${e.name}.mjs';`)
    .join('\n');
  const spread = plan.entities.map((e) => `  ...${e.name}Routes,`).join('\n');
  return `/**
 * 全栈站服务入口（由 AI 工作台生成）。
 * 零框架依赖：Node 内置 http + 手写路由，便于在任意 Serverless / 容器平台部署。
 * 环境变量见 .env.example；未配置数据库时 /api/* 返回 503 并标注降级，不伪造数据。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { routes as contactRoutes } from './api/contact.mjs';
${routeImports}

const ROOT = join(process.cwd(), 'public');
const PORT = Number(process.env.PORT ?? 3000);
const ACCESS = '${plan.accessControl.type}';

const routes = [
${spread}
  ...contactRoutes,
  { method: 'GET', path: '/api/health', handler: async (req, res, ctx) => {
      const { databaseStatus, databaseHint } = await import('./api/_db.mjs');
      ctx.json(res, 200, { ok: true, database: databaseStatus(), hint: databaseHint() });
    } },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  if (ACCESS !== 'password') return true;
  const required = process.env.SITE_PASSWORD;
  if (!required) return false;
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  return decoded.slice(decoded.indexOf(':') + 1) === required;
}

const server = createServer(async (req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="site"' });
    res.end('需要口令访问');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const ctx = {
    query: url.searchParams,
    json,
    async readJson(r) {
      const chunks = [];
      for await (const c of r) {
        chunks.push(c);
        if (Buffer.concat(chunks).length > 1_000_000) throw Object.assign(new Error('请求体过大'), { statusCode: 413 });
      }
      if (chunks.length === 0) return {};
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 }); }
    },
    degraded(res2) {
      return json(res2, 503, {
        error: 'DEPENDENCY_UNAVAILABLE',
        message: '数据库不可用，数据接口暂不可用（未配置 DATABASE_URL 或未安装 pg 驱动）。',
        degraded: true,
      });
    },
  };

  if (url.pathname.startsWith('/api/')) {
    const route = routes.find((r) => r.path === url.pathname && r.method === req.method);
    if (!route) return json(res, 404, { error: 'NOT_FOUND', message: '接口不存在: ' + req.method + ' ' + url.pathname });
    try {
      await route.handler(req, res, ctx);
    } catch (e) {
      const status = e?.statusCode ?? 500;
      const message = e instanceof Error ? e.message : String(e);
      if (status >= 500) console.error('[api error]', url.pathname, message);
      json(res, status, { error: status === 503 ? 'DEPENDENCY_UNAVAILABLE' : 'INTERNAL', message });
    }
    return;
  }

  let filePath = normalize(join(ROOT, decodeURIComponent(url.pathname)));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const info = await stat(filePath).catch(() => null);
    if (!info || info.isDirectory()) filePath = join(ROOT, 'index.html');
    const body = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('服务已启动： http://127.0.0.1:' + PORT);
  if (!process.env.DATABASE_URL) console.warn('警告：未配置 DATABASE_URL，/api/* 将返回 503（显式降级）。');
});
`;
}

/** 生成 Postgres DDL（Neon / Supabase 通用） */
export function schemaSql(plan: WebsitePlan): string {
  const header = `-- 由 AI 工作台根据需求生成的 Postgres Schema（Neon / Supabase 通用）
-- 生成来源：需求解析（${new Date().toISOString().slice(0, 10)}）
-- 说明：全部使用 IF NOT EXISTS，可重复执行；配套 db/migrations/0001_init.down.sql 支持回滚。

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
`;
  const tables = plan.entities.map((e) => {
    const cols = e.columns
      .map((c) => {
        const type = c.type.toLowerCase();
        const parts = [`  ${c.name} ${type.toUpperCase()}`];
        if (c.primary) parts.push('PRIMARY KEY DEFAULT gen_random_uuid()');
        if (!c.nullable && !c.primary) parts.push('NOT NULL');
        if (c.name === 'created_at' && !c.primary) parts.push('DEFAULT NOW()');
        return parts.join(' ');
      })
      .join(',\n');
    const fks = (e.relations ?? [])
      .filter((r) => r.type === 'many-to-one')
      .map((r) => {
        const refEntity = plan.entities.find((x) => x.name === r.to);
        const refPk = refEntity?.columns.find((c) => c.primary)?.name ?? 'id';
        const localCol = `${r.to.replace(/s$/, '')}_id`;
        return `  CONSTRAINT ${e.name}_${localCol}_fkey FOREIGN KEY (${localCol}) REFERENCES ${r.to}(${refPk}) ON DELETE CASCADE`;
      })
      .join(',\n');
    return `CREATE TABLE IF NOT EXISTS "${e.name}" (\n${cols}${fks ? ',\n' + fks : ''}\n);\nCREATE INDEX IF NOT EXISTS "${e.name}_created_idx" ON "${e.name}"("created_at");`;
  });
  return header + '\n' + tables.join('\n\n') + '\n';
}

function downSql(plan: WebsitePlan): string {
  return (
    `-- 回滚 0001_init：按依赖倒序删除\n` +
    [...plan.entities].reverse().map((e) => `DROP TABLE IF EXISTS ${e.name};`).join('\n') +
    '\n'
  );
}

function dbReadme(plan: WebsitePlan): string {
  const list = plan.entities.map((e) => `- \`${e.name}\`：${e.columns.map((c) => c.name).join(', ')}`).join('\n');
  return `# 数据库说明

## 表结构

${list}

## 如何接入 Neon / Supabase

本工作台不内置任何账号凭据，需要你手动完成：

1. 在 **数据库面板** 新建连接（Neon 或 Supabase），填入连接串；
2. 点「测试连接」确认可用；
3. 用「生成 Schema」把本目录的 \`schema.sql\` 同步到远端；
4. 在 **部署中心** 的「环境变量」中把 \`DATABASE_URL\` 注入到 Vercel / Cloudflare / Netlify（值加密存储，不落明文）。

## 本地执行

\`\`\`bash
psql "$DATABASE_URL" -f db/schema.sql          # 应用
psql "$DATABASE_URL" -f db/migrations/0001_init.down.sql   # 回滚
\`\`\`
`;
}

export { escapeHtml };

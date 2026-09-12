import type { WebsitePlan } from '@ai/shared';
import { envExample, escapeHtml, gitignore, readme, styles, type GeneratedFile } from './templates.ts';

/**
 * 静态站生成器。
 * 纯 HTML + 内联 CSS + 零依赖 JS → 生成即可用、可离线预览、可直接部署到任意静态托管。
 */

const SECTION_TITLE: Record<string, string> = {
  hero: '让想法直接上线',
  features: '核心能力',
  cta: '现在就开始',
  intro: '我们是谁',
  team: '团队',
  form: '提交信息',
  map: '位置',
  table: '数据',
  pagination: '分页',
  summary: '概要',
  timeline: '时间线',
  stats: '关键指标',
  list: '列表',
  sidebar: '侧边',
  plans: '套餐',
  faq: '常见问题',
  toc: '目录',
  content: '正文',
};

const SECTION_KIND: Record<string, string> = {
  hero: 'hero',
  features: 'grid',
  cta: 'cta',
  intro: 'text',
  team: 'grid',
  form: 'form',
  map: 'text',
  table: 'table',
  pagination: 'text',
  summary: 'text',
  timeline: 'list',
  stats: 'grid',
  list: 'list',
  sidebar: 'text',
  plans: 'grid',
  faq: 'list',
  toc: 'text',
  content: 'text',
};

function renderSection(name: string, plan: WebsitePlan, index: number): string {
  const title = SECTION_TITLE[name] ?? name;
  const kind = SECTION_KIND[name] ?? 'text';
  const id = `section-${index + 1}-${name}`;

  if (kind === 'hero') {
    return `<section id="${id}">
        <h1>${escapeHtml(title)}</h1>
        <p class="lead">${escapeHtml(plan.summary)}</p>
        <p><a class="btn" href="#section-${index + 2}">了解更多</a></p>
      </section>`;
  }
  if (kind === 'grid') {
    const cards = (plan.entities.length ? plan.entities.map((e) => e.name) : ['快速开始', '安全可靠', '易于扩展'])
      .slice(0, 6)
      .map((n) => `        <div class="card"><h3>${escapeHtml(n)}</h3><p>这个区块由 AI 根据需求生成，可在源码中直接修改。</p></div>`)
      .join('\n');
    return `<section id="${id}">
        <h2>${escapeHtml(title)}</h2>
        <div class="grid">
${cards}
        </div>
      </section>`;
  }
  if (kind === 'cta') {
    return `<section id="${id}">
        <h2>${escapeHtml(title)}</h2>
        <p><a class="btn" href="#section-1-hero">返回顶部</a></p>
      </section>`;
  }
  if (kind === 'form') {
    return `<section id="${id}">
        <h2>${escapeHtml(title)}</h2>
        <form id="lead-form" class="card">
          <p><input name="name" placeholder="姓名" required /></p>
          <p><input name="email" type="email" placeholder="邮箱" required /></p>
          <p><textarea name="content" rows="4" placeholder="想说的话"></textarea></p>
          <p><button type="submit">提交</button> <span id="form-status"></span></p>
        </form>
      </section>`;
  }
  if (kind === 'table') {
    const entity = plan.entities[0];
    const cols = entity ? entity.columns.map((c) => c.name) : ['name', 'value'];
    return `<section id="${id}">
        <h2>${escapeHtml(title)}</h2>
        <div class="card">
          <table>
            <thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
            <tbody id="table-body"><tr><td colspan="${cols.length}">加载中…</td></tr></tbody>
          </table>
        </div>
      </section>`;
  }
  if (kind === 'list' || kind === 'text') {
    return `<section id="${id}">
        <h2>${escapeHtml(title)}</h2>
        <div class="card"><p>${escapeHtml(plan.summary)}。此区块为生成内容，请按实际业务替换。</p></div>
      </section>`;
  }
  return `<section id="${id}"><h2>${escapeHtml(title)}</h2></section>`;
}

export function buildStaticSite(plan: WebsitePlan, projectName: string, requirement: string): GeneratedFile[] {
  return staticSiteBuilderFor(plan, projectName, requirement);
}

export function staticSiteBuilderFor(plan: WebsitePlan, projectName: string, requirement: string): GeneratedFile[] {
  const nav = plan.pages.map((p) => `<a href="${p.path === '/' ? '#top' : `#${p.path.replace(/\W+/g, '-')}`}">${escapeHtml(p.title)}</a>`).join('');
  const body = plan.pages
    .map((page, pi) => {
      const sections = page.sections.map((s, si) => renderSection(s, plan, pi * 10 + si)).join('\n      ');
      return `    <div class="page" id="${page.path.replace(/\W+/g, '-')}" data-path="${escapeHtml(page.path)}">
      <h2 class="page-title" hidden>${escapeHtml(page.title)}</h2>
      ${sections}
    </div>`;
    })
    .join('\n');

  const files: GeneratedFile[] = [];

  files.push({
    path: 'index.html',
    key: true,
    content: `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(projectName)}</title>
  <meta name="description" content="${escapeHtml(plan.summary)}" />
  <link rel="stylesheet" href="./assets/styles.css" />
</head>
<body id="top">
  <header class="site">
    <strong>${escapeHtml(projectName)}</strong>
    <nav>${nav}</nav>
  </header>
  <main>
${body}
  </main>
  <footer>
    <p>由 AI 工作台生成 · ${escapeHtml(plan.summary)}</p>
  </footer>
  <script type="module" src="assets/app.js"></script>
</body>
</html>
`,
  });

  files.push({ path: 'assets/styles.css', content: styles(plan) });

  const contactPath = plan.apis.find((a) => a.path.includes('contact'))?.path ?? '/api/contact';
  files.push({
    path: 'assets/app.js',
    key: true,
    content: `/**
 * 由 AI 工作台生成。可在浏览器直接运行；提交表单会调用可选的 API 接口。
 * 注意：这里不包含任何密钥，所有外部地址都来自 <form> 的 data 属性或运行时环境。
 */
const API_BASE = window.__API_BASE__ ?? '';
const CONTACT_PATH = ${JSON.stringify(contactPath)};

document.addEventListener('DOMContentLoaded', () => {
  // 1) 锚点导航（页内滚动）
  document.querySelectorAll('header.site nav a').forEach((a) => {
    a.addEventListener('click', (e) => {
      const href = a.getAttribute('href') ?? '';
      if (href.startsWith('#')) {
        e.preventDefault();
        document.querySelector(href)?.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });

  // 2) 留言表单：本地收集，POST 到 CONTACT_PATH（见下方常量）
  const form = document.getElementById('lead-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const statusEl = document.getElementById('form-status');
      const data = Object.fromEntries(new FormData(form).entries());
      if (statusEl) statusEl.textContent = '提交中…';
      try {
        const res = await fetch(API_BASE + CONTACT_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        if (statusEl) statusEl.textContent = '已提交 ✅';
        form.reset();
      } catch (err) {
        if (statusEl) statusEl.textContent = '提交失败：' + (err && err.message ? err.message : '未知错误');
      }
    });
  }

  // 3) 表格数据（静态站无数据库时展示占位，部署后可替换为 API 地址）
  const tbody = document.getElementById('table-body');
  if (tbody && tbody.children.length === 1) {
    tbody.innerHTML = '<tr><td colspan="9">静态站点暂无数据源。生成时若包含数据实体，请改用 fullstack 模板。</td></tr>';
  }
});
`,
  });

  files.push({ path: 'package.json', content: staticPackageJson(projectName) });
  files.push({ path: 'server.mjs', key: true, content: staticServer(plan) });
  files.push({ path: 'README.md', content: readme(projectName, plan, requirement) });
  files.push({ path: '.env.example', content: envExample(plan) });
  files.push({ path: '.gitignore', content: gitignore() });

  return files;
}

function staticPackageJson(name: string): string {
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
          preview: 'node server.mjs',
        },
      },
      null,
      2,
    ) + '\n'
  );
}

/** 零依赖静态服务器：`npm run dev` 即可预览 */
export function staticServer(plan: WebsitePlan): string {
  const access = plan.accessControl.type;
  return `/**
 * 零依赖静态预览服务器（由 AI 工作台生成）。
 * 用法：node server.mjs [port]     默认 4173
 * 访问控制：${access}
 *   - public           直接访问
 *   - password         需 SITE_PASSWORD 环境变量（本机预览用，线上部署时由平台网关校验）
 *   - email-allowlist  需部署平台侧配置
 * 不包含任何硬编码口令。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.cwd();
const PORT = Number(process.argv[2] ?? process.env.PORT ?? 4173);
const ACCESS = '${access}';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function authorized(req) {
  if (ACCESS !== 'password') return true;
  const required = process.env.SITE_PASSWORD;
  if (!required) return false;
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  return pass === required;
}

const server = createServer(async (req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="site"' });
    res.end('需要口令访问');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  let filePath = normalize(join(ROOT, decodeURIComponent(url.pathname)));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }
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

server.listen(PORT, '127.0.0.1', () => {
  console.log('预览地址： http://127.0.0.1:' + PORT);
  if (ACCESS === 'password' && !process.env.SITE_PASSWORD) {
    console.warn('访问控制为 password，但未设置 SITE_PASSWORD 环境变量 → 当前一律拒绝访问（安全默认）。');
  }
});
`;
}

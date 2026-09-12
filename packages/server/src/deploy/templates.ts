import type { WebsitePlan } from '@ai/shared';

/** 生成文件的统一结构：相对路径 + 内容 + 是否关键文件（用于 UI 高亮） */
export interface GeneratedFile {
  path: string;
  content: string;
  key?: boolean;
}

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const jsString = (s: string): string => JSON.stringify(s);

/** 生成 package.json（不含任何密钥字段） */
export function packageJson(name: string, opts: { type: 'module'; scripts: Record<string, string>; deps?: Record<string, string> }): string {
  return (
    JSON.stringify(
      {
        name,
        version: '1.0.0',
        private: true,
        type: opts.type,
        scripts: opts.scripts,
        ...(opts.deps ? { dependencies: opts.deps } : {}),
      },
      null,
      2,
    ) + '\n'
  );
}

export function readme(name: string, plan: WebsitePlan, requirement: string): string {
  const pages = plan.pages.map((p) => `- \`${p.path}\` — ${p.title}（区块：${p.sections.join(', ')}）`).join('\n');
  const apis = plan.apis.length
    ? plan.apis.map((a) => `- \`${a.method} ${a.path}\` — ${a.description}`).join('\n')
    : '- （静态站，无后端接口）';
  const entities = plan.entities.length
    ? plan.entities.map((e) => `- \`${e.name}\`（${e.columns.map((c) => c.name).join(', ')}）`).join('\n')
    : '- （无数据库实体）';
  return `# ${name}

> 由 AI 工作台自动生成 · 站点类型 \`${plan.siteType}\` · 框架 \`${plan.framework}\`

## 原始需求

${requirement}

## 页面

${pages}

## 后端接口

${apis}

## 数据库

${entities}

## 运行

\`\`\`bash
npm install   # 仅在有依赖时需要
npm run dev
\`\`\`

## 环境变量

见 \`.env.example\`。**所有凭据由你手动填写，本仓库不含任何密钥。**

## 访问控制

${plan.accessControl.note}（类型：${plan.accessControl.type}）
`;
}

export function envExample(plan: WebsitePlan): string {
  const lines = [
    '# 复制为 .env 后填写。不要把 .env 提交到版本库。',
    '# 由 AI 工作台生成的模板，值为空，需你手动配置。',
    '',
  ];
  if (plan.needsDatabase) {
    lines.push(
      '# Neon / Supabase Postgres 连接串（在数据库面板中创建连接后自动注入）',
      'DATABASE_URL=',
      '',
    );
  }
  lines.push('# 站点访问控制口令（可选，仅当使用密码保护时）', 'SITE_PASSWORD=', '');
  return lines.join('\n');
}

export function gitignore(): string {
  return ['node_modules/', '.env', '.env.local', 'dist/', 'data/*.db', '*.log', ''].join('\n');
}

/** 落地页样式（内联 CSS，无外部 CDN 依赖 → 离线可预览） */
export function styles(plan: WebsitePlan): string {
  const [ink, primary, accent, bg] = plan.styling.palette.length >= 4 ? plan.styling.palette : ['#0f172a', '#38bdf8', '#22d3ee', '#f8fafc'];
  return `:root {
  --ink: ${ink};
  --primary: ${primary};
  --accent: ${accent};
  --bg: ${bg};
  --radius: 12px;
  --maxw: 1080px;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--ink);
  background: ${plan.styling.darkMode ? 'var(--ink)' : 'var(--bg)'};
  ${plan.styling.darkMode ? 'color: var(--bg);' : ''}
  line-height: 1.6;
}
header.site {
  display: flex; align-items: center; justify-content: space-between;
  max-width: var(--maxw); margin: 0 auto; padding: 20px 24px;
}
header.site nav a { margin-left: 18px; color: inherit; text-decoration: none; opacity: .8; }
header.site nav a:hover { opacity: 1; }
main { max-width: var(--maxw); margin: 0 auto; padding: 0 24px 80px; }
section { margin: 48px 0; }
h1 { font-size: clamp(28px, 5vw, 44px); line-height: 1.2; margin: 0 0 12px; }
h2 { font-size: 22px; margin: 0 0 12px; }
p.lead { opacity: .78; font-size: 18px; }
.grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
.card {
  border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
  border-radius: var(--radius); padding: 20px; background: color-mix(in srgb, currentColor 3%, transparent);
}
.card h3 { margin: 0 0 8px; font-size: 17px; }
button, .btn {
  display: inline-block; border: 0; cursor: pointer; font: inherit;
  background: var(--primary); color: #04121f; padding: 10px 18px;
  border-radius: 999px; font-weight: 600; text-decoration: none;
}
input, textarea, select {
  font: inherit; padding: 9px 12px; border-radius: 8px;
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  background: transparent; color: inherit; width: 100%;
}
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
.badge { display: inline-block; font-size: 12px; padding: 2px 10px; border-radius: 999px; background: var(--accent); color: #04121f; }
footer { max-width: var(--maxw); margin: 0 auto; padding: 24px; opacity: .6; font-size: 13px; }
`;
}

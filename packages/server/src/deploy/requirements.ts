import type { WebsiteFramework, WebsitePlan, WebsitePlanApi, WebsitePlanEntity, WebsitePlanPage, WebsiteType } from '@ai/shared';
import { createHash } from 'node:crypto';
import { AppError } from '../utils/errors.ts';
import { modelRouter } from '../agent/model-router.ts';

/**
 * 需求解析（Step 1）。
 *
 * 设计：
 *   1. 规则解析（确定性、离线可用、可测）—— 先跑通，产出结构化需求；
 *   2. LLM 增强（可选）—— 有模型时用 LLM 补齐页面区块/字段细节，失败自动回落规则结果。
 *
 * 为什么规则优先：
 *   - 用户不配任何密钥也应能生成可运行网站（Phase 2 同理，降级必须显式）；
 *   - 规则结果作为 LLM 输出的「结构校验基线」，避免模型幻觉出不合法的 schema。
 */

const ENTITY_KEYWORDS: { kw: RegExp; entity: WebsitePlanEntity }[] = [
  {
    kw: /(客户|crm|customer|contact)/i,
    entity: {
      name: 'customers',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, primary: true },
        { name: 'name', type: 'text', nullable: false },
        { name: 'email', type: 'text', nullable: true },
        { name: 'phone', type: 'text', nullable: true },
        { name: 'created_at', type: 'timestamptz', nullable: false },
      ],
    },
  },
  {
    kw: /(订单|order)/i,
    entity: {
      name: 'orders',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, primary: true },
        { name: 'customer_id', type: 'uuid', nullable: false },
        { name: 'amount', type: 'numeric', nullable: false },
        { name: 'status', type: 'text', nullable: false },
        { name: 'created_at', type: 'timestamptz', nullable: false },
      ],
      relations: [{ to: 'customers', type: 'many-to-one' }],
    },
  },
  {
    kw: /(留言|评论|反馈|contact|message|feedback)/i,
    entity: {
      name: 'messages',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, primary: true },
        { name: 'author', type: 'text', nullable: false },
        { name: 'email', type: 'text', nullable: true },
        { name: 'content', type: 'text', nullable: false },
        { name: 'created_at', type: 'timestamptz', nullable: false },
      ],
    },
  },
  {
    kw: /(文章|博客|新闻|post|article|blog\b)/i,
    entity: {
      name: 'posts',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, primary: true },
        { name: 'title', type: 'text', nullable: false },
        { name: 'slug', type: 'text', nullable: false },
        { name: 'body', type: 'text', nullable: false },
        { name: 'published_at', type: 'timestamptz', nullable: true },
      ],
    },
  },
  {
    kw: /(商品|产品|product|sku)/i,
    entity: {
      name: 'products',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, primary: true },
        { name: 'name', type: 'text', nullable: false },
        { name: 'price', type: 'numeric', nullable: false },
        { name: 'stock', type: 'integer', nullable: false },
      ],
    },
  },
  {
    kw: /(任务|待办|todo|task)/i,
    entity: {
      name: 'todos',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, primary: true },
        { name: 'title', type: 'text', nullable: false },
        { name: 'done', type: 'boolean', nullable: false },
        { name: 'created_at', type: 'timestamptz', nullable: false },
      ],
    },
  },
  {
    kw: /(用户|user|账号|account|会员)/i,
    entity: {
      name: 'users',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, primary: true },
        { name: 'email', type: 'text', nullable: false },
        { name: 'password_hash', type: 'text', nullable: false },
        { name: 'created_at', type: 'timestamptz', nullable: false },
      ],
    },
  },
  {
    kw: /(数据|统计|报表|指标|dashboard|metric|analytics)/i,
    entity: {
      name: 'metrics',
      columns: [
        { name: 'id', type: 'uuid', nullable: false, primary: true },
        { name: 'name', type: 'text', nullable: false },
        { name: 'value', type: 'numeric', nullable: false },
        { name: 'recorded_at', type: 'timestamptz', nullable: false },
      ],
    },
  },
];

const PAGE_KEYWORDS: { kw: RegExp; page: Omit<WebsitePlanPage, 'requiresAuth'> }[] = [
  { kw: /(首页|home|landing)/i, page: { path: '/', title: '首页', sections: ['hero', 'features', 'cta'] } },
  { kw: /(关于|about)/i, page: { path: '/about', title: '关于我们', sections: ['intro', 'team'] } },
  { kw: /(联系|contact)/i, page: { path: '/contact', title: '联系我们', sections: ['form', 'map'] } },
  { kw: /(列表|清单|list|index)/i, page: { path: '/list', title: '列表', sections: ['table', 'pagination'] } },
  { kw: /(详情|detail)/i, page: { path: '/detail', title: '详情', sections: ['summary', 'timeline'] } },
  { kw: /(后台|管理|admin|dashboard|控制台)/i, page: { path: '/admin', title: '管理后台', sections: ['stats', 'table', 'form'] } },
  { kw: /(登录|login|signin)/i, page: { path: '/login', title: '登录', sections: ['form'] } },
  { kw: /(注册|signup|register)/i, page: { path: '/signup', title: '注册', sections: ['form'] } },
  { kw: /(定价|价格|price|pricing)/i, page: { path: '/pricing', title: '定价', sections: ['plans', 'faq'] } },
  { kw: /(博客|文章|blog|news)/i, page: { path: '/blog', title: '博客', sections: ['list', 'sidebar'] } },
  { kw: /(文档|doc|guide)/i, page: { path: '/docs', title: '文档', sections: ['toc', 'content'] } },
];

const PALETTES: Record<string, string[]> = {
  tech: ['#0f172a', '#38bdf8', '#22d3ee', '#f8fafc'],
  warm: ['#1c1917', '#f97316', '#fbbf24', '#fffbeb'],
  fresh: ['#052e16', '#22c55e', '#86efac', '#f0fdf4'],
  elegant: ['#1e1b4b', '#8b5cf6', '#c4b5fd', '#faf5ff'],
  business: ['#0c4a6e', '#0284c7', '#7dd3fc', '#f0f9ff'],
};

function pickPalette(text: string): { tone: string; palette: string[] } {
  if (/(科技|tech|saas|ai|开发者|dev)/i.test(text)) return { tone: 'tech', palette: PALETTES.tech as string[] };
  if (/(温暖|warm|餐饮|food|咖啡)/i.test(text)) return { tone: 'warm', palette: PALETTES.warm as string[] };
  if (/(清新|fresh|环保|健康|green)/i.test(text)) return { tone: 'fresh', palette: PALETTES.fresh as string[] };
  if (/(优雅|elegant|艺术|设计|design)/i.test(text)) return { tone: 'elegant', palette: PALETTES.elegant as string[] };
  return { tone: 'business', palette: PALETTES.business as string[] };
}

/** 站点类型选型：有实体 → 带库全栈；有表单/接口 → 全栈；否则静态 */
export function inferSiteType(requirement: string, entities: WebsitePlanEntity[]): { siteType: WebsiteType; framework: WebsiteFramework } {
  const wantsBackend = /(api|接口|后端|后端接口|server|表单提交|提交|保存|上传|登录|注册|admin|后台|管理)/i.test(requirement);
  if (entities.length > 0) return { siteType: 'fullstack-db', framework: 'node-http' };
  if (wantsBackend) return { siteType: 'fullstack', framework: 'node-http' };
  return { siteType: 'static', framework: 'vanilla-html' };
}

/** 规则解析：确定性，离线可用 */
export function parseRequirementByRules(requirement: string): WebsitePlan {
  const text = requirement.trim();
  if (!text) throw AppError.badRequest('需求描述不能为空');

  const entities: WebsitePlanEntity[] = [];
  for (const e of ENTITY_KEYWORDS) {
    if (e.kw.test(text) && !entities.some((x) => x.name === e.entity.name)) {
      entities.push(structuredClone(e.entity));
    }
  }

  const pages: WebsitePlanPage[] = [];
  for (const p of PAGE_KEYWORDS) {
    if (p.kw.test(text) && !pages.some((x) => x.path === p.page.path)) {
      pages.push({ ...p.page, sections: [...p.page.sections], requiresAuth: /admin|后台|管理/.test(p.page.title) });
    }
  }
  if (!pages.some((p) => p.path === '/')) {
    pages.unshift({ path: '/', title: '首页', sections: ['hero', 'features', 'cta'], requiresAuth: false });
  }
  // 有实体但用户没提列表页时，自动补一个数据列表页（否则生成的库用不上）
  if (entities.length > 0 && !pages.some((p) => /\/(list|admin)/.test(p.path))) {
    pages.push({ path: '/list', title: '数据列表', sections: ['table', 'pagination'], requiresAuth: false });
  }

  const { siteType, framework } = inferSiteType(text, entities);
  const styling = pickPalette(text);
  const accessType: 'public' | 'password' | 'email-allowlist' = /(白名单|allowlist|仅内部|内部访问)/i.test(text)
    ? 'email-allowlist'
    : /(密码|password|口令)/i.test(text)
      ? 'password'
      : 'public';

  const apis: WebsitePlanApi[] = [];
  if (siteType !== 'static') {
    apis.push({ method: 'GET', path: '/api/health', description: '健康检查', requiresDb: false });
  }
  for (const entity of entities) {
    const base = `/${entity.name}`;
    apis.push({ method: 'GET', path: `${base}`, description: `列出 ${entity.name}`, entity: entity.name, requiresDb: true });
    apis.push({ method: 'POST', path: `${base}`, description: `创建 ${entity.name}`, entity: entity.name, requiresDb: true });
  }
  // 有表单就需要提交接口：否则生成的页面表单必然 404（这是真实缺陷，不是可选项）
  const hasForm = /(表单|留言|反馈|联系|contact|message|form|提交)/i.test(text) || pages.some((p) => p.sections.includes('form'));
  if (hasForm) {
    apis.push({ method: 'POST', path: '/api/contact', description: '提交表单/留言', requiresDb: entities.length > 0 });
  }
  // 非 DB 全栈站也需要 health（用于部署后探活）
  if (!apis.some((a) => a.path === '/api/health') && siteType !== 'static') {
    apis.unshift({ method: 'GET', path: '/api/health', description: '健康检查', requiresDb: false });
  }

  const title = text.length > 40 ? text.slice(0, 40) + '…' : text;

  return {
    summary: `站点类型 ${siteType}，页面 ${pages.length} 个，数据实体 ${entities.length} 个`,
    pages,
    entities,
    apis,
    styling: { ...styling, darkMode: /(暗色|dark|深色)/i.test(text) },
    accessControl: { type: accessType, note: accessType === 'public' ? '公开访问' : '部署后需在访问控制中配置具体凭据' },
    siteType,
    framework,
    needsDatabase: entities.length > 0,
    degraded: !modelRouter.hasCredentials,
  };
}

/** LLM 增强：把需求的描述性信息补进页面区块；失败/无密钥时静默回落规则结果 */
export async function parseRequirement(requirement: string): Promise<WebsitePlan> {
  const base = parseRequirementByRules(requirement);
  if (!modelRouter.hasCredentials) return base;
  try {
    const completion = await modelRouter.chat({
      messages: [
        {
          role: 'system',
          content:
            '你是网站需求分析器。只输出 JSON，不要解释。结构：{"extraSections":{"页面路径":["区块名"]}}',
        },
        { role: 'user', content: requirement },
      ],
      maxTokens: 800,
      jsonMode: true,
    });
    const parsed = safeJson(completion.content);
    if (!parsed) return base;
    const extra = (parsed.extraSections ?? {}) as Record<string, string[]>;
    const pages = base.pages.map((p) => {
      const add = extra[p.path] ?? [];
      const sections = [...p.sections];
      for (const s of add) if (typeof s === 'string' && !sections.includes(s)) sections.push(s);
      return { ...p, sections };
    });
    return { ...base, pages, summary: `${base.summary}（LLM 增强）`, degraded: completion.degraded };
  } catch {
    return base;
  }
}

function safeJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 从计划里推断项目名（英文短名，用于目录名） */
export function deriveProjectName(requirement: string, fallback = 'site'): string {
  // 优先用 ASCII 词（更适合做目录名与部署平台的项目名）
  const ascii = requirement
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 3)
    .join('-');
  if (ascii) return ascii.slice(0, 40).replace(/-+$/g, '') || fallback;
  // 中文/其他语言需求：退化为「拼音化不可行时的稳定短名」——用需求哈希保证同名需求得到同名目录
  const hash = createHash('sha256').update(requirement.trim()).digest('hex').slice(0, 8);
  return `${fallback}-${hash}`;
}

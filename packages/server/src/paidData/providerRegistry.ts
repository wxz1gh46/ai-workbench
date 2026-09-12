import type { PaidDataProviderSpec } from '@ai/shared';

/**
 * 付费数据库 Provider 注册表（Phase 4 Step 2）。
 *
 * 合规基线（每个 Provider 都必须满足）：
 *   1) accessMethods 明确写出「官方 API / 用户本机终端 / 开放接口」，不存在爬虫路径
 *   2) requiresUserAuth 为 true 的，凭据必须由用户手动配置（工作台只读环境变量 + 加密入库）
 *   3) rateLimit 明确写出频率上限，QueryRunner 强制限流（不靠「用户自觉」）
 *   4) 结果必须带 citations（来源 + 访问时间），否则无法溯源
 *
 * 注意：这里只声明「接入能力与契约」，不包含任何真实密钥、也不代理登录。
 */

function action(name: string, label: string, description: string, params: { key: string; label: string; required: boolean }[]) {
  return { name, label, description, params };
}

const sym = { key: 'symbol', label: '证券代码', required: true };
const keyword = { key: 'keyword', label: '关键词/企业名', required: true };

export const PAID_PROVIDERS: PaidDataProviderSpec[] = [
  {
    id: 'tonghuashun',
    name: '同花顺 iFinD 开放平台',
    type: 'market',
    region: 'CN',
    status: 'unconfigured',
    docsUrl: 'https://open.10jqka.com.cn/',
    requiresUserAuth: true,
    credentialFields: [
      { key: 'appKey', label: 'App Key', required: true, hint: '同花顺开放平台控制台获取' },
      { key: 'appSecret', label: 'App Secret', required: true, hint: '仅用于服务端签名，本地加密存储' },
    ],
    actions: [
      action('market.quote', '实时行情', '查询指定标的的实时行情快照', [sym]),
      action('finance.report', '财务指标', '查询财务报表与关键指标', [sym, { key: 'period', label: '报告期', required: false }]),
      action('company.announcement', '公司公告', '查询指定公司公告列表', [sym]),
    ],
    accessMethods: ['同花顺官方开放平台 API（HTTP + 签名鉴权）'],
    rateLimit: { perMinute: 60, note: '按官方配额保守设置，超出会被本地限流器拒绝' },
  },
  {
    id: 'tianyancha',
    name: '天眼查开放平台',
    type: 'enterprise',
    region: 'CN',
    status: 'unconfigured',
    docsUrl: 'https://open.tianyancha.com/',
    requiresUserAuth: true,
    credentialFields: [{ key: 'token', label: 'API Token', required: true, hint: '天眼查开放平台个人/企业 Token' }],
    actions: [
      action('company.basic', '工商信息', '查询企业工商基本信息', [keyword]),
      action('company.justice', '司法风险', '查询企业司法风险信息', [keyword]),
      action('company.equity', '股权结构', '查询企业股权穿透结构', [keyword]),
    ],
    accessMethods: ['天眼查官方开放平台 API'],
    rateLimit: { perMinute: 30, note: '官方按套餐限流，本地再限一层' },
  },
  {
    id: 'wind',
    name: 'Wind 万得金融终端',
    type: 'financial',
    region: 'CN',
    status: 'unconfigured',
    docsUrl: 'https://www.wind.com.cn/',
    requiresUserAuth: true,
    credentialFields: [{ key: 'windPath', label: '终端安装路径', required: true, hint: '本机已授权并登录的 Wind 终端路径' }],
    actions: [
      action('wds.query', 'Wind 数据集查询', '通过本机 Wind 终端查询数据集', [{ key: 'dataset', label: '数据集', required: true }, { key: 'options', label: '参数', required: false }]),
      action('wset.data', '行情序列', '查询行情时间序列', [{ key: 'codes', label: '代码列表', required: true }]),
    ],
    accessMethods: ['本机 Wind 终端授权桥接（官方途径，需已购买并登录 Wind）', '不代理登录、不共享账号'],
    rateLimit: { perMinute: 20, note: '终端并发有限，本地严格限流' },
  },
  {
    id: 'hs-juyuan',
    name: '恒生聚源',
    type: 'financial',
    region: 'CN',
    status: 'unconfigured',
    docsUrl: 'https://www.hscloud.cn/',
    requiresUserAuth: true,
    credentialFields: [{ key: 'apiKey', label: 'API Key', required: true }],
    actions: [action('finance.query', '金融数据查询', '查询恒生聚源金融数据表', [{ key: 'table', label: '数据表', required: true }, { key: 'filter', label: '过滤条件', required: false }])],
    accessMethods: ['恒生聚源官方 API'],
    rateLimit: { perMinute: 60, note: '本地限流 + 服务端配额双重保护' },
  },
  {
    id: 'sp-global',
    name: 'S&P Global Market Intelligence',
    type: 'market',
    region: 'GLOBAL',
    status: 'unconfigured',
    docsUrl: 'https://www.spglobal.com/marketintelligence/en/',
    requiresUserAuth: true,
    credentialFields: [{ key: 'apiKey', label: 'API Key', required: true }, { key: 'accountId', label: 'Account ID', required: false }],
    actions: [action('market.intelligence', '市场情报', '查询全球市场情报数据', [{ key: 'query', label: '查询表达式', required: true }, { key: 'universe', label: '标的范围', required: false }])],
    accessMethods: ['S&P Global 官方 API（Market Intelligence Platform）'],
    rateLimit: { perMinute: 30, note: '按官方企业配额保守限流' },
  },
  {
    id: 'imf',
    name: 'IMF 国际货币基金组织数据',
    type: 'macro',
    region: 'GLOBAL',
    status: 'available',
    docsUrl: 'https://data.imf.org/',
    requiresUserAuth: false,
    credentialFields: [],
    actions: [
      action('macro.series', '宏观序列', '查询宏观经济指标时间序列', [{ key: 'indicator', label: '指标代码', required: true }, { key: 'country', label: '国家代码', required: false }]),
      action('macro.dataset', '数据集列表', '列出可用数据集', []),
    ],
    accessMethods: ['IMF 官方开放数据接口（无需凭据）'],
    rateLimit: { perMinute: 30, note: '公共接口，本地限流避免打扰对方' },
  },
  {
    id: 'hyyd-legal',
    name: '华宇元典法律数据库',
    type: 'legal',
    region: 'CN',
    status: 'unconfigured',
    docsUrl: 'https://www.thunisoft.com/',
    requiresUserAuth: true,
    credentialFields: [{ key: 'token', label: '访问 Token', required: true }],
    actions: [
      action('legal.search', '法规检索', '检索法律法规与司法解释', [keyword]),
      action('legal.case', '案例检索', '检索裁判文书案例', [keyword]),
    ],
    accessMethods: ['华宇元典官方 API'],
    rateLimit: { perMinute: 30, note: '按官方订阅限流' },
  },
  {
    id: 'academic',
    name: '学术数据库（Crossref / OpenAlex）',
    type: 'academic',
    region: 'GLOBAL',
    status: 'available',
    docsUrl: 'https://api.crossref.org/',
    requiresUserAuth: false,
    credentialFields: [{ key: 'mailto', label: '联系邮箱（可选）', required: false, hint: '开放接口建议带上邮箱以获得更好的配额' }],
    actions: [
      action('paper.search', '论文检索', '按关键词检索论文', [{ key: 'query', label: '关键词', required: true }, { key: 'limit', label: '数量', required: false }]),
      action('paper.citations', '引用关系', '查询论文引用关系', [{ key: 'doi', label: 'DOI', required: true }]),
    ],
    accessMethods: ['Crossref REST API', 'OpenAlex API（均为官方开放接口）'],
    rateLimit: { perMinute: 60, note: '开放接口 polite pool，建议带 mailto' },
  },
];

export function findProvider(id: string): PaidDataProviderSpec | undefined {
  return PAID_PROVIDERS.find((p) => p.id === id);
}

export function listProviders() {
  return PAID_PROVIDERS;
}

/** 必填凭据字段（用于保存前校验，避免用户以为配置成功了其实缺字段） */
export function requiredCredentialKeys(id: string): string[] {
  const provider = findProvider(id);
  if (!provider) return [];
  return provider.credentialFields.filter((f) => f.required).map((f) => f.key);
}

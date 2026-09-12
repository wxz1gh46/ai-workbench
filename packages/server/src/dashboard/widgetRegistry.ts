import type { WidgetKind, WidgetSpec } from '@ai/shared';

/**
 * 小组件注册表（Step 4）。
 *
 * 7 类组件覆盖提示词要求：
 *   task-progress   任务进度
 *   agent-status    Agent 状态
 *   file-list       文件列表
 *   website-status  网站状态
 *   schedule-status 定时任务
 *   data-query      数据查询
 *   prompt-template 提示词模板
 *
 * 每类组件声明：
 *   - 自然语言示例（用于 NLP 匹配 + UI 提示）
 *   - 默认尺寸（React Grid Layout 的 w/h，12 列栅格）
 *   - 数据源类型（决定刷新策略与刷新频率上限）
 *   - 配置项 schema（UI 自动生成表单，避免前端硬编码）
 */
export const WIDGET_REGISTRY: WidgetSpec[] = [
  {
    type: 'task-progress',
    label: '任务进度',
    description: '展示目标下的任务完成情况、进行中数量与阻塞项',
    naturalLanguageExamples: ['显示当前目标的任务进度', '我想看到目标完成度', '任务进度看板'],
    defaultSize: { w: 6, h: 4 },
    dataSource: 'agent-runtime',
    configSchema: [
      { key: 'goalId', type: 'string', label: '指定目标（留空显示最近一个）' },
      { key: 'showBlockers', type: 'boolean', label: '显示阻塞项' },
    ],
  },
  {
    type: 'agent-status',
    label: 'Agent 状态',
    description: '展示各 Agent 的空闲/忙碌状态与当前任务',
    naturalLanguageExamples: ['显示 Agent 运行状态', '智能体集群状态', 'agent 都在干什么'],
    defaultSize: { w: 6, h: 4 },
    dataSource: 'agent-runtime',
    configSchema: [{ key: 'showIdle', type: 'boolean', label: '显示空闲 Agent' }],
  },
  {
    type: 'file-list',
    label: '文件列表',
    description: '展示工作区最近的文件与版本数',
    naturalLanguageExamples: ['显示最近文件', '文件列表', '我上传了什么文件'],
    defaultSize: { w: 6, h: 5 },
    dataSource: 'local-db',
    configSchema: [
      { key: 'limit', type: 'number', label: '显示数量', required: false },
      { key: 'mime', type: 'string', label: '过滤类型（如 application/pdf）' },
    ],
  },
  {
    type: 'website-status',
    label: '网站状态',
    description: '展示网站项目的部署状态、线上地址与最近部署时间',
    naturalLanguageExamples: ['网站部署状态', '我的站点上线了吗', '显示网站地址'],
    defaultSize: { w: 6, h: 4 },
    dataSource: 'deployment-status',
    configSchema: [
      { key: 'websiteProjectId', type: 'string', label: '指定网站项目（留空显示全部）' },
      { key: 'showUrl', type: 'boolean', label: '显示访问地址' },
    ],
  },
  {
    type: 'schedule-status',
    label: '定时任务',
    description: '展示定时任务的启用状态、下次执行时间与最近结果',
    naturalLanguageExamples: ['定时任务状态', '我的计划任务下次什么时候跑', '显示任务日历'],
    defaultSize: { w: 6, h: 4 },
    dataSource: 'schedule-status',
    configSchema: [
      { key: 'onlyEnabled', type: 'boolean', label: '只看已启用' },
      { key: 'limit', type: 'number', label: '显示数量', required: false },
    ],
  },
  {
    type: 'data-query',
    label: '数据查询',
    description: '执行只读 SQL 并展示结果（可绑定数据库连接）',
    naturalLanguageExamples: ['显示数据库里最新的订单', '查询客户数量', 'sql 查询组件'],
    defaultSize: { w: 8, h: 5 },
    dataSource: 'local-db',
    configSchema: [
      { key: 'connectionId', type: 'select', label: '数据库连接', required: true },
      { key: 'sql', type: 'string', label: 'SQL（只读）', required: true },
      { key: 'limit', type: 'number', label: '行数上限', required: false },
    ],
  },
  {
    type: 'prompt-template',
    label: '提示词模板',
    description: '一键触发常用提示词模板',
    naturalLanguageExamples: ['提示词快捷入口', '我的 prompt 模板', '常用提示词'],
    defaultSize: { w: 5, h: 4 },
    dataSource: 'local-db',
    configSchema: [
      { key: 'templateId', type: 'string', label: '指定模板（留空显示全部）' },
      { key: 'limit', type: 'number', label: '显示数量', required: false },
    ],
  },
];

export function getWidgetSpec(type: WidgetKind): WidgetSpec | null {
  return WIDGET_REGISTRY.find((w) => w.type === type) ?? null;
}

/** 自然语言 → 组件类型（确定性规则，无密钥可用；LLM 可作为增强） */
const RULES: { type: WidgetKind; kw: RegExp; weight: number }[] = [
  { type: 'task-progress', kw: /((?<!定时)(?<!计划)(?<!周期)(?<!安排)任务|进度|完成度|todo|task|progress)/i, weight: 10 },
  { type: 'agent-status', kw: /(agent|智能体|集群|模型状态)/i, weight: 10 },
  { type: 'file-list', kw: /(文件|文档|上传|file|doc)/i, weight: 8 },
  { type: 'website-status', kw: /(网站|部署|上线|域名|website|deploy|url)/i, weight: 10 },
  { type: 'schedule-status', kw: /(定时|计划|日程|周期|cron|schedule)/i, weight: 10 },
  { type: 'data-query', kw: /(数据库|查询|sql|统计|报表|data|metric)/i, weight: 9 },
  { type: 'prompt-template', kw: /(提示词|prompt|模板|快捷)/i, weight: 9 },
];

export interface InferredWidget {
  type: WidgetKind;
  title: string;
  config: Record<string, unknown>;
  confidence: number;
  matched: string | null;
  degraded: boolean;
}

export function inferWidget(text: string): InferredWidget {
  const input = text.trim();
  // 统计每类命中的关键词：多命中累加，避免「任务」这种泛词抢占更具体的类型
  const scores = new Map<WidgetKind, { weight: number; matched: string }>();
  for (const r of RULES) {
    const g = new RegExp(r.kw.source, 'gi');
    let hit: RegExpExecArray | null;
    let count = 0;
    let first = '';
    while ((hit = g.exec(input)) !== null) {
      if (count === 0) first = hit[0];
      count += 1;
      if (hit.index === g.lastIndex) g.lastIndex += 1;
    }
    if (count === 0) continue;
    const prev = scores.get(r.type);
    const weight = (prev?.weight ?? 0) + r.weight + (count - 1) * 3;
    scores.set(r.type, { weight, matched: prev?.matched ?? first });
  }
  let best: { type: WidgetKind; weight: number; matched: string } | null = null;
  for (const [type, v] of scores) {
    if (!best || v.weight > best.weight) best = { type, weight: v.weight, matched: v.matched };
  }
  const spec = best ? getWidgetSpec(best.type) : getWidgetSpec('task-progress');
  const type = spec?.type ?? 'task-progress';
  const config: Record<string, unknown> = {};
  // 从自然语言里抽取数字作为 limit（如「显示最近 10 个文件」）
  const numMatch = /(\d{1,3})\s*(个|条|行|项)/.exec(input);
  if (numMatch) {
    const n = Number(numMatch[1]);
    if (Number.isFinite(n) && n > 0 && n <= 200) config.limit = n;
  }
  if (type === 'data-query') {
    // 尝试抽取表名，作为 SQL 的初始建议（用户可改）
    const tableMatch = /(?:查询|查|显示|看)\s*([a-z_][a-z0-9_]{1,40})/i.exec(input);
    if (tableMatch) config.sql = `select * from ${tableMatch[1]}`;
  }
  return {
    type,
    title: spec?.label ?? '任务进度',
    config,
    confidence: best ? Math.min(0.95, best.weight / 10) : 0.3,
    matched: best?.matched ?? null,
    // 规则命中即非降级；未命中走默认类型 → 标记低置信度
    degraded: !best,
  };
}

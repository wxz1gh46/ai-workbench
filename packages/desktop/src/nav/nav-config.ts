import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  BellRing,
  Boxes,
  Brain,
  CalendarClock,
  Cloud,
  Database,
  FileSpreadsheet,
  FileText,
  LayoutDashboard,
  MessageSquare,
  Microscope,
  Puzzle,
  Settings,
  Shield,
  Sparkles,
  SquareTerminal,
  Target,
} from 'lucide-react';

/**
 * 桌面版壳层导航的唯一数据源。
 *
 * 这个文件是「功能集合」的落地位置：Phase 1~4 的所有页面都在这里登记一次，
 * 侧边栏、标签页、命令面板（Ctrl/Cmd+K）全部从同一份数据派生。
 * 新增页面时只需在这里加一条，不需要动 App.tsx 或任何导航组件 —— 避免出现
 * 「页面写了但用户找不到入口」这种半成品状态。
 */
export type TabKey =
  | 'pluginMarket'
  | 'paidData'
  | 'promptWorkbench'
  | 'clusterView'
  | 'securityCenter'
  | 'deploy'
  | 'database'
  | 'boardEditor'
  | 'schedules'
  | 'notify'
  | 'goal'
  | 'cluster'
  | 'office'
  | 'research'
  | 'memory'
  | 'chat'
  | 'files'
  | 'settings';

export interface NavItem {
  key: TabKey;
  label: string;
  icon: LucideIcon;
  group: string;
  /** 命令面板/全局搜索用的别名 */
  keywords: string[];
  /** 一句话说明，显示在标签页首行与命令面板副标题 */
  summary: string;
}

export const NAV_GROUPS = ['工作台', '智能体', '交付与自动化', '生态与集群', '系统'] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];

export const NAV_ITEMS: NavItem[] = [
  {
    key: 'chat',
    label: '对话',
    icon: MessageSquare,
    group: '工作台',
    keywords: ['chat', 'conversation', '消息', '对话', 'duihua'],
    summary: '百万 Tokens 分层上下文的日常对话入口',
  },
  {
    key: 'goal',
    label: '目标模式',
    icon: Target,
    group: '工作台',
    keywords: ['goal', 'objective', '目标', '任务', 'mubiao'],
    summary: '给定目标即自主拆解、并行执行、自我审计',
  },
  {
    key: 'boardEditor',
    label: '看板编辑器',
    icon: LayoutDashboard,
    group: '工作台',
    keywords: ['dashboard', 'board', 'widget', '看板', '小组件', 'kanban'],
    summary: '自然语言建组件、拖拽布局、固定到桌面',
  },
  {
    key: 'files',
    label: '文件工作区',
    icon: FileText,
    group: '工作台',
    keywords: ['file', 'workspace', '文件', '版本历史', 'wenjian'],
    summary: '文件浏览、版本历史与导出',
  },
  {
    key: 'office',
    label: 'Office 工作区',
    icon: FileSpreadsheet,
    group: '工作台',
    keywords: ['office', 'docx', 'xlsx', 'pptx', 'pdf', '文档', '表格', '演示'],
    summary: 'docx / xlsx / pptx / pdf 读取、编辑、转换与预览',
  },
  {
    key: 'research',
    label: '深度研究',
    icon: Microscope,
    group: '工作台',
    keywords: ['research', 'report', '研究', '报告', '引用', 'yanjiu'],
    summary: '合规抓取、交叉验证、带引用的结构化报告',
  },
  {
    key: 'memory',
    label: '记忆面板',
    icon: Brain,
    group: '智能体',
    keywords: ['memory', 'fact', 'summary', '记忆', '摘要', '事实', 'jiyi'],
    summary: '摘要、事实抽取与向量召回的可视化面板',
  },
  {
    key: 'cluster',
    label: 'Agent 集群',
    icon: Boxes,
    group: '智能体',
    keywords: ['agent', 'cluster', 'swarm', '智能体', '集群', '并行'],
    summary: '单机多 Agent 并行：任务板 + 通信 + 进度树',
  },
  {
    key: 'clusterView',
    label: '多节点集群',
    icon: Activity,
    group: '智能体',
    keywords: ['cluster', 'node', 'heartbeat', 'election', '节点', '心跳', '选举'],
    summary: '实验性多节点集群：注册、心跳、选举、容错、降级',
  },
  {
    key: 'promptWorkbench',
    label: '提示词工作台',
    icon: Sparkles,
    group: '智能体',
    keywords: ['prompt', 'template', 'abtest', '提示词', '模板', '评估'],
    summary: '模板库、生成器、优化器、版本管理、A/B 测试',
  },
  {
    key: 'deploy',
    label: '部署中心',
    icon: Cloud,
    group: '交付与自动化',
    keywords: ['deploy', 'vercel', 'netlify', 'cloudflare', '部署', '上线', '发布'],
    summary: '自然语言生成网站并一键部署，返回线上 URL',
  },
  {
    key: 'database',
    label: '数据库面板',
    icon: Database,
    group: '交付与自动化',
    keywords: ['database', 'neon', 'supabase', 'postgres', '数据库', '迁移'],
    summary: 'Neon / Supabase 接入、Schema 生成、可回滚迁移',
  },
  {
    key: 'paidData',
    label: '付费数据库',
    icon: SquareTerminal,
    group: '交付与自动化',
    keywords: ['paid', 'data', 'wind', 'tianyancha', 'imf', '付费', '数据源', '合规'],
    summary: '官方 API 或用户登录态接入，凭据本地加密、全量审计',
  },
  {
    key: 'schedules',
    label: '定时任务',
    icon: CalendarClock,
    group: '交付与自动化',
    keywords: ['schedule', 'cron', 'task', '定时', '计划', 'dinghshi'],
    summary: 'Cron / 周期 / 一次性任务，执行日志与指数退避重试',
  },
  {
    key: 'notify',
    label: '通知设置',
    icon: BellRing,
    group: '交付与自动化',
    keywords: ['notify', 'webhook', 'feishu', 'dingtalk', '通知', '推送', '飞书'],
    summary: '桌面 / 邮件 / Webhook / 飞书 / 钉钉 / 企微 六通道',
  },
  {
    key: 'pluginMarket',
    label: '插件市场',
    icon: Puzzle,
    group: '生态与集群',
    keywords: ['plugin', 'mcp', 'market', '插件', '市场', '沙箱'],
    summary: 'MCP 优先的插件市场：安装、授权、沙箱、调用日志',
  },
  {
    key: 'securityCenter',
    label: '安全中心',
    icon: Shield,
    group: '生态与集群',
    keywords: ['security', 'rbac', 'sso', 'audit', '安全', '审计', '权限', '脱敏'],
    summary: 'RBAC、SSO、审计日志、数据脱敏、保留策略',
  },
  {
    key: 'settings',
    label: '设置',
    icon: Settings,
    group: '系统',
    keywords: ['setting', 'config', 'key', '设置', '配置', '密钥'],
    summary: '模型接入、工作区目录、功能开关',
  },
];

export const NAV_BY_KEY: Record<TabKey, NavItem> = NAV_ITEMS.reduce(
  (acc, item) => ({ ...acc, [item.key]: item }),
  {} as Record<TabKey, NavItem>,
);

export function navItemsByGroup(): { group: string; items: NavItem[] }[] {
  return NAV_GROUPS.map((group) => ({ group, items: NAV_ITEMS.filter((i) => i.group === group) })).filter(
    (g) => g.items.length > 0,
  );
}

/** 命令面板搜索：标签 / 分组 / 关键词 / 说明 全字段匹配，标签命中优先 */
export function searchNav(query: string, limit = 8): NavItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return NAV_ITEMS.slice(0, limit);
  const scored = NAV_ITEMS.map((item) => {
    const label = item.label.toLowerCase();
    let score = 0;
    if (label.startsWith(q)) score = 100;
    else if (label.includes(q)) score = 80;
    else if (item.keywords.some((k) => k.toLowerCase().includes(q))) score = 60;
    else if (item.group.toLowerCase().includes(q)) score = 40;
    else if (item.summary.toLowerCase().includes(q)) score = 20;
    return { item, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.item);
}

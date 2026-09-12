import type { ScheduleTaskType } from '@ai/shared';

/**
 * 任务模板（Step 5）。
 *
 * 预置常用任务的「类型 + 参数 + 建议 cron + 需要用户补充的占位符」，
 * 用户选模板后只需填空即可创建，避免从零写 taskConfig。
 */
export interface TaskTemplate {
  name: string;
  label: string;
  description: string;
  taskType: ScheduleTaskType;
  /** 建议的 cron（用户可改） */
  suggestedCron: string;
  /** taskConfig 模板，${xxx} 为占位符 */
  taskConfig: Record<string, unknown>;
  /** 需要用户填写的占位符 */
  placeholders: { key: string; label: string; example: string; required: boolean }[];
  /** 建议的通知渠道类型 */
  suggestedChannels: string[];
  dangerous: boolean;
}

export const TASK_TEMPLATES: TaskTemplate[] = [
  {
    name: 'daily-research',
    label: '每日行业简报',
    description: '每天定时做一次主题研究并生成结构化报告',
    taskType: 'research',
    suggestedCron: '0 9 * * *',
    taskConfig: { topic: '${topic}', depth: 'standard', allowNetwork: false, outputFormats: ['markdown', 'pdf', 'pptx'] },
    placeholders: [{ key: 'topic', label: '研究主题', example: '2026 年储能行业趋势', required: true }],
    suggestedChannels: ['desktop', 'email'],
    dangerous: false,
  },
  {
    name: 'weekly-report',
    label: '每周工作周报',
    description: '汇总本周产出并生成 docx 周报',
    taskType: 'office',
    suggestedCron: '0 18 * * 5',
    taskConfig: { format: 'docx', title: '周报 ${date}', content: '${content}' },
    placeholders: [{ key: 'content', label: '周报内容或提示词', example: '本周完成：…', required: true }],
    suggestedChannels: ['desktop', 'feishu'],
    dangerous: false,
  },
  {
    name: 'goal-daily',
    label: '每日目标推进',
    description: '定时创建并自动推进一个目标（用于长期任务）',
    taskType: 'goal',
    suggestedCron: '0 10 * * *',
    taskConfig: { objective: '${objective}', acceptanceCriteria: [], maxIterations: 8 },
    placeholders: [{ key: 'objective', label: '目标描述', example: '整理本周客户反馈并输出改进清单', required: true }],
    suggestedChannels: ['desktop'],
    dangerous: false,
  },
  {
    name: 'deploy-check',
    label: '网站部署巡检',
    description: '定时触发网站重新部署（内容变更后自动上线）',
    taskType: 'deploy',
    suggestedCron: '0 3 * * *',
    taskConfig: { websiteProjectId: '${websiteProjectId}', provider: 'vercel' },
    placeholders: [{ key: 'websiteProjectId', label: '网站项目 ID', example: 'wsp_xxx', required: true }],
    suggestedChannels: ['desktop', 'webhook'],
    dangerous: true,
  },
  {
    name: 'db-query-report',
    label: '数据查询与推送',
    description: '定时执行只读 SQL 并把结果推送到通知渠道',
    taskType: 'db-query',
    suggestedCron: '0 9 * * 1',
    taskConfig: { connectionId: '${connectionId}', sql: '${sql}', limit: 50 },
    placeholders: [
      { key: 'connectionId', label: '数据库连接 ID', example: 'db_xxx', required: true },
      { key: 'sql', label: '只读 SQL', example: 'select count(*) as n from users', required: true },
    ],
    suggestedChannels: ['email', 'dingtalk'],
    dangerous: false,
  },
  {
    name: 'custom-webhook',
    label: '自定义动作',
    description: '仅触发通知或外部 Webhook（用于集成第三方系统）',
    taskType: 'custom',
    suggestedCron: '*/30 * * * *',
    taskConfig: { payload: {} },
    placeholders: [],
    suggestedChannels: ['webhook'],
    dangerous: false,
  },
];

export function getTemplate(name: string): TaskTemplate | null {
  return TASK_TEMPLATES.find((t) => t.name === name) ?? null;
}

/** 用占位符值填充模板 */
export function fillTemplate(template: TaskTemplate, values: Record<string, string>): Record<string, unknown> {
  const json = JSON.stringify(template.taskConfig);
  const filled = json.replace(/\$\{(\w+)\}/g, (_, key: string) => values[key] ?? '');
  return JSON.parse(filled) as Record<string, unknown>;
}

/** 校验占位符：必填项缺失时给出可读错误（在创建任务前拦住） */
export function validateTemplateValues(template: TaskTemplate, values: Record<string, string>): string[] {
  const missing: string[] = [];
  for (const p of template.placeholders) {
    if (p.required && !values[p.key]?.trim()) missing.push(`${p.label}(${p.key})`);
  }
  return missing;
}

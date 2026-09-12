import { eq } from 'drizzle-orm';
import type { Widget, WidgetType } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { widgets } from '../db/schema/index.ts';
import { newId, nowIso } from '../utils/ids.ts';

/**
 * 自然语言 → 小组件。
 * Phase 1 用关键词规则映射（确定性、可测、无外部依赖）；
 * Phase 2 换成 LLM 生成 config，规则作为兜底。
 */
const RULES: { type: WidgetType; title: string; kw: RegExp; config: Record<string, unknown> }[] = [
  { type: 'task-progress', title: '任务进度', kw: /任务|进度|task|progress/i, config: { goalId: null } },
  { type: 'agent-status', title: 'Agent 状态', kw: /agent|智能体|集群/i, config: { showIdle: true } },
  { type: 'file-generator', title: '文件生成器', kw: /文件|文档|生成|file|doc|office/i, config: { defaultFormat: 'docx' } },
  { type: 'website-monitor', title: '网站监控', kw: /网站|部署|上线|website|deploy/i, config: { websiteId: null } },
  { type: 'schedule-calendar', title: '定时任务日历', kw: /定时|计划|日程|cron|schedule/i, config: { scope: 'workspace' } },
  { type: 'db-query', title: '数据库查询', kw: /数据库|查询|sql|query|分析/i, config: { connectionId: null, limit: 20 } },
  { type: 'prompt-shortcut', title: '提示词快捷入口', kw: /提示词|prompt|模板/i, config: { templateId: null } },
];

export function inferWidget(text: string): { type: WidgetType; title: string; config: Record<string, unknown> } {
  for (const r of RULES) {
    if (r.kw.test(text)) return { type: r.type, title: r.title, config: { ...r.config } };
  }
  return { type: 'task-progress', title: '任务进度', config: { goalId: null } };
}

export class WidgetService {
  constructor(private readonly db: Db) {}

  async createFromNaturalLanguage(input: {
    workspaceId: string;
    naturalLanguage: string;
    dashboardId?: string;
  }): Promise<Widget> {
    const inferred = inferWidget(input.naturalLanguage);
    const count = (await this.db.select().from(widgets).where(eq(widgets.workspaceId, input.workspaceId))).length;
    const now = nowIso();
    const row = {
      id: newId('wdg'),
      workspaceId: input.workspaceId,
      dashboardId: input.dashboardId ?? 'default',
      type: inferred.type,
      title: inferred.title,
      naturalLanguage: input.naturalLanguage,
      // 简易自动布局：每行 2 个，避免重叠
      layout: { x: (count % 2) * 6, y: Math.floor(count / 2) * 4, w: 6, h: 4 },
      config: inferred.config,
      pinnedToDesktop: false,
      refreshIntervalMs: 5000,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(widgets).values(row);
    return row as Widget;
  }

  async list(workspaceId: string, dashboardId = 'default'): Promise<Widget[]> {
    return (await this.db.select().from(widgets).where(eq(widgets.workspaceId, workspaceId))).filter(
      (w) => w.dashboardId === dashboardId,
    ) as Widget[];
  }

  async updateLayout(id: string, layout: Widget['layout']): Promise<void> {
    if (layout.w < 1 || layout.h < 1) return;
    await this.db.update(widgets).set({ layout, updatedAt: nowIso() }).where(eq(widgets.id, id));
  }

  async remove(id: string): Promise<void> {
    await this.db.delete(widgets).where(eq(widgets.id, id));
  }
}

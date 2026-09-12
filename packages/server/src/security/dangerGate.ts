import { AppError } from '../utils/errors.ts';
import { logger } from '../utils/logger.ts';

/**
 * 危险操作二次确认闸门（Phase 3）。
 *
 * 规则（硬约束，不提供关闭开关）：
 *   - 删除部署 / 删除网站项目 / 删除数据库连接 / 执行写 SQL /
 *     回滚迁移 / 删除看板 / 删除定时任务 / 删除通知渠道
 *     必须 body.confirm === true
 *   - 未确认时返回 428 语义的可读错误，并在日志留痕
 *   - 所有通过闸门的调用都必须由调用方写审计
 */

export const DANGEROUS_ACTIONS = {
  'website.delete': { summary: '删除网站项目及其全部部署记录', level: 'high' as const },
  'website.deploy': { summary: '向外部平台发布网站（可能产生费用）', level: 'high' as const },
  'website.rollback': { summary: '回滚线上网站到历史版本', level: 'medium' as const },
  'deployment.delete': { summary: '删除线上部署', level: 'high' as const },
  'domain.bind': { summary: '绑定自定义域名并申请 HTTPS 证书', level: 'medium' as const },
  'access.update': { summary: '修改网站访问控制策略', level: 'medium' as const },
  'db.create': { summary: '在云端创建数据库（可能产生费用）', level: 'high' as const },
  'db.migrate': { summary: '在云端数据库执行结构变更', level: 'high' as const },
  'db.rollback': { summary: '回滚云端数据库迁移', level: 'high' as const },
  'db.write': { summary: '在云端数据库执行写操作', level: 'high' as const },
  'db.delete': { summary: '删除数据库连接', level: 'medium' as const },
  'dashboard.delete': { summary: '删除看板及全部小组件', level: 'medium' as const },
  'schedule.delete': { summary: '删除定时任务及执行历史', level: 'medium' as const },
  'schedule.run': { summary: '立即手动触发定时任务', level: 'medium' as const },
  'notify.delete': { summary: '删除通知渠道', level: 'medium' as const },
} as const;

export type DangerousAction = keyof typeof DANGEROUS_ACTIONS;

export function isDangerous(action: string): action is DangerousAction {
  return Object.prototype.hasOwnProperty.call(DANGEROUS_ACTIONS, action);
}

export interface GateResult {
  confirmed: boolean;
  action: string;
  level: 'high' | 'medium';
}

/** 校验危险操作确认。confirm 必须严格为 true 才放行。 */
export function gate(action: string, confirm: unknown, extras: Record<string, unknown> = {}): GateResult {
  if (!isDangerous(action)) return { confirmed: true, action, level: 'medium' };
  if (confirm !== true) {
    logger.warn('dangerous action blocked by confirm gate', { action, extras });
    throw AppError.confirmRequired(`危险操作需二次确认：${DANGEROUS_ACTIONS[action].summary}`, {
      action,
      summary: DANGEROUS_ACTIONS[action].summary,
      level: DANGEROUS_ACTIONS[action].level,
    });
  }
  return { confirmed: true, action, level: DANGEROUS_ACTIONS[action].level };
}

/** 给 UI 用的风险清单 */
export function dangerCatalog() {
  return Object.entries(DANGEROUS_ACTIONS).map(([action, meta]) => ({ action, ...meta }));
}

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

export const DANGEROUS_ACTIONS: Record<string, { summary: string; level: 'high' | 'medium' | 'low' }> = {
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
  level: 'high' | 'medium' | 'low';
}

/** 校验危险操作确认。confirm 必须严格为 true 才放行。 */
export function gate(action: string, confirm: unknown, extras: Record<string, unknown> = {}): GateResult {
  if (!isDangerous(action)) return { confirmed: true, action, level: 'medium' };
  if (confirm !== true) {
    logger.warn('dangerous action blocked by confirm gate', { action, extras });
    throw AppError.confirmRequired(`危险操作需二次确认：${DANGEROUS_ACTIONS[action]!.summary}`, {
      action,
      summary: DANGEROUS_ACTIONS[action]!.summary,
      level: DANGEROUS_ACTIONS[action]!.level,
    });
  }
  return { confirmed: true, action, level: DANGEROUS_ACTIONS[action]!.level };
}

/** 给 UI 用的风险清单 */
export function dangerCatalog() {
  return Object.entries(DANGEROUS_ACTIONS).map(([action, meta]) => ({ action, ...meta }));
}

/* ------------------------------------------------------------------ */
/* Phase 4 新增危险动作                                                 */
/* ------------------------------------------------------------------ */

export const PHASE4_DANGEROUS_ACTIONS = {
  'plugin.install': { summary: '安装插件（插件可访问工作区文件与网络，需你逐项授权）', level: 'high' as const },
  'plugin.uninstall': { summary: '卸载插件并删除其授权与调用日志', level: 'medium' as const },
  'plugin.revoke': { summary: '撤销插件权限（插件相关功能将立即失效）', level: 'medium' as const },
  'mcp.server.register': { summary: '注册 MCP 服务器（会与该地址建立连接）', level: 'medium' as const },
  'mcp.server.remove': { summary: '移除 MCP 服务器及其工具缓存', level: 'medium' as const },
  'paid_data.credential.save': { summary: '保存付费数据源凭据（本地加密存储）', level: 'medium' as const },
  'paid_data.credential.delete': { summary: '删除付费数据源凭据', level: 'medium' as const },
  'paid_data.query': { summary: '调用付费数据接口（会产生费用并留下调用记录）', level: 'high' as const },
  'prompt.version.rollback': { summary: '回滚提示词到历史版本（当前内容会被新版本覆盖）', level: 'medium' as const },
  'cluster.node.remove': { summary: '从集群移除节点（该节点上未完成的分片会被改派）', level: 'high' as const },
  'cluster.policy.update': { summary: '修改集群策略（影响资源分配与降级行为）', level: 'medium' as const },
  'cluster.election.force': { summary: '强制触发 leader 选举（可能短暂中断调度）', level: 'medium' as const },
  'agent.pool.scale': { summary: '调整 Agent 池实例数（影响并行能力）', level: 'low' as const },
  'aggregated.resolve': { summary: '人工裁决多 Agent 结果冲突（会覆盖自动聚合结果）', level: 'medium' as const },
  'rbac.role.delete': { summary: '删除角色（不可恢复）', level: 'medium' as const },
  'rbac.assign': { summary: '为用户分配角色（会立即提升其权限）', level: 'high' as const },
  'sso.enable': { summary: '启用 SSO 登录（配置错误会导致无法登录）', level: 'high' as const },
  'sso.remove': { summary: '删除 SSO 配置', level: 'medium' as const },
  'retention.apply': { summary: '执行数据保留策略（可能真实删除历史数据）', level: 'high' as const },
  'audit.export': { summary: '导出审计日志（含脱敏后的操作记录）', level: 'medium' as const },
} as const;

Object.assign(DANGEROUS_ACTIONS, PHASE4_DANGEROUS_ACTIONS);
export type Phase4DangerousAction = keyof typeof PHASE4_DANGEROUS_ACTIONS;

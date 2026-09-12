import { PostgresAdapter } from '../src/database/postgresAdapter.ts';

/**
 * 测试辅助：把「安全策略」抽成可断言的纯函数。
 * 放在 src 外的 test 目录，避免污染生产代码；但被安全测试直接引用。
 */

/** 定时任务的 cron 表达式的安全/合理约束 */
export function scheduleCronAllowed(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6) return false;
  // 拒绝「每秒执行」：高频任务会把本地 agent 拖垮，且不是用户真实诉求
  if (fields.length === 6) {
    const sec = fields[0] as string;
    if (sec === '*' || /^\*\/[1-9]$/.test(sec) || /^[0-9,]+$/.test(sec)) return false;
  }
  if (fields.length === 5 && (fields[0] as string) === '*') return true; // 每分钟允许（用户在 UI 上会看到提示）
  return /^[\d*/,\-#LW]+$/i.test(fields.join(' ')) || /[*/]/.test(fields.join(' '));
}

/** 任务参数里不允许出现写 SQL */
export function jobConfigSafe(config: Record<string, unknown>): boolean {
  const sql = config.sql;
  if (typeof sql !== 'string' || sql.trim() === '') return true;
  return PostgresAdapter.inspect(sql).safe && !PostgresAdapter.inspect(sql).isWrite;
}

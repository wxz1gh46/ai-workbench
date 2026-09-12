import { Badge, Empty } from '@/components/ui';
import type { AuditLog } from '@ai/shared';

/**
 * 审计日志视图。
 * 三条硬要求：
 *   1) 危险操作必须显著标出；
 *   2) 「危险但未确认」的记录要单独标红 —— 这是最需要人工复核的一类；
 *   3) detail 已在服务端脱敏，这里只负责展示，不再做二次处理。
 */
export function AuditLogView({ logs }: { logs: AuditLog[] }) {
  if (logs.length === 0) return <Empty>没有匹配的审计记录。</Empty>;
  return (
    <div className="overflow-auto">
      <table className="w-full text-left text-[11px]">
        <thead className="text-muted">
          <tr>
            <th className="py-1 pr-2">时间</th>
            <th className="py-1 pr-2">执行者</th>
            <th className="py-1 pr-2">动作</th>
            <th className="py-1 pr-2">对象</th>
            <th className="py-1 pr-2">风险</th>
            <th className="py-1">明细（已脱敏）</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((l) => (
            <tr key={l.id} className="border-t border-border align-top">
              <td className="py-1 pr-2 text-muted">{new Date(l.createdAt).toLocaleString()}</td>
              <td className="py-1 pr-2 text-fg">{l.actor}</td>
              <td className="py-1 pr-2 text-fg">{l.action}</td>
              <td className="py-1 pr-2 text-muted">{l.targetType}{l.targetId ? `:${l.targetId.slice(0, 10)}` : ''}</td>
              <td className="py-1 pr-2">
                {l.dangerous ? (
                  l.confirmedByUser ? (
                    <Badge tone="warn">危险·已确认</Badge>
                  ) : (
                    <Badge tone="error">危险·未确认</Badge>
                  )
                ) : (
                  <Badge tone="default">常规</Badge>
                )}
              </td>
              <td className="py-1 font-mono text-muted">{JSON.stringify(l.detail).slice(0, 160)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

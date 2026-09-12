import { useEffect, useState } from 'react';
import type { Schedule } from '@ai/shared';
import { api } from '@/lib/api';
import { describeError, useAppStore } from '@/stores/app-store';
import { Badge, Button, Empty, Panel } from '@/components/ui';

export function SchedulePage() {
  const workspace = useAppStore((s) => s.workspace);
  const pushToast = useAppStore((s) => s.pushToast);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [name, setName] = useState('');
  const [expression, setExpression] = useState('0 9 * * *');
  const [objective, setObjective] = useState('');
  const [trigger, setTrigger] = useState<Schedule['trigger']>('cron');

  const load = async () => {
    if (!workspace) return;
    const res = await api.listSchedules(workspace.id);
    setSchedules(res.schedules);
  };
  useEffect(() => {
    void load().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  async function create() {
    if (!workspace || !name.trim()) return;
    try {
      await api.createSchedule({
        workspaceId: workspace.id,
        name: name.trim(),
        trigger,
        expression: expression.trim(),
        action: { type: 'goal', objective: objective.trim() || name.trim() },
      });
      setName('');
      setObjective('');
      await load();
      pushToast({ level: 'success', message: '定时任务已创建' });
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    }
  }

  return (
    <div className="grid h-full grid-cols-[1fr_1fr] gap-3">
      <Panel title="新建定时任务">
        <div className="space-y-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="任务名称，例如：每日行业简报"
            className="w-full rounded border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-brand"
          />
          <div className="flex gap-2">
            {(['cron', 'interval', 'once'] as const).map((t) => (
              <Button key={t} variant={trigger === t ? 'primary' : 'default'} onClick={() => setTrigger(t)}>
                {t}
              </Button>
            ))}
          </div>
          <input
            value={expression}
            onChange={(e) => setExpression(e.target.value)}
            placeholder={trigger === 'cron' ? '0 9 * * *' : trigger === 'interval' ? '86400000' : '2026-01-01T09:00:00'}
            className="w-full rounded border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-brand"
          />
          <textarea
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            rows={3}
            placeholder="触发时执行的目标（默认为任务名称）"
            className="w-full resize-none rounded border border-border bg-bg px-2 py-1.5 text-sm outline-none focus:border-brand"
          />
          <Button variant="primary" onClick={() => void create()} disabled={!name.trim()}>
            创建
          </Button>
        </div>
      </Panel>

      <Panel title={`已配置（${schedules.length}）`}>
        {schedules.length === 0 ? (
          <Empty>暂无定时任务</Empty>
        ) : (
          <ul className="space-y-2">
            {schedules.map((s) => (
              <li key={s.id} className="rounded border border-border px-2 py-1.5">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span>{s.name}</span>
                  <span className="flex items-center gap-1">
                    <Badge tone={s.enabled ? 'ok' : 'default'}>{s.enabled ? '启用' : '停用'}</Badge>
                    <Badge>{s.trigger}</Badge>
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-muted">
                  <code>{s.expression}</code>
                </div>
                {s.lastRunAt && <div className="text-[10px] text-muted">上次执行：{new Date(s.lastRunAt).toLocaleString()}</div>}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-[11px] text-muted">
          推送渠道（桌面通知 / 邮件 / 飞书 / 钉钉 / 企业微信）在 Phase 3 接入；当前可在执行日志中查看结果。
        </p>
      </Panel>
    </div>
  );
}

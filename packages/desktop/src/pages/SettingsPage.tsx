import { useEffect, useState } from 'react';
import type { AuditLog } from '@ai/shared';
import { api } from '@/lib/api';
import { useAppStore } from '@/stores/app-store';
import { Badge, Empty, Panel } from '@/components/ui';

export function SettingsPage() {
  const workspace = useAppStore((s) => s.workspace);
  const degraded = useAppStore((s) => s.degraded);
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [features, setFeatures] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void api.health().then((h) => setFeatures(h.features));
    if (!workspace) return;
    void api
      .listAudit(workspace.id)
      .then((r) => setLogs(r.logs))
      .catch(() => undefined);
  }, [workspace]);

  return (
    <div className="grid h-full grid-cols-2 gap-3">
      <Panel title="模型接入">
        <div className="space-y-2 text-xs text-muted">
          <p className="text-amber-400">
            {degraded ? '当前未配置模型密钥，处于离线兜底模式。' : '模型已配置。'}
          </p>
          <p>密钥只从环境变量 / 系统钥匙串读取，代码与数据库中不保存明文。请在项目根目录的 .env 中配置：</p>
          <pre className="rounded border border-border bg-bg p-2 text-[11px]">
{`AI_DEFAULT_PROVIDER=openai-compatible
AI_BASE_URL=https://api.openai.com/v1
AI_API_KEY=sk-***
AI_MODEL=gpt-4o-mini
AI_LONG_CONTEXT_MODEL=gpt-4.1
AI_LONG_CONTEXT_THRESHOLD=120000`}
          </pre>
          <p>超过长上下文阈值时，模型路由会自动切到 AI_LONG_CONTEXT_MODEL。</p>
        </div>
      </Panel>

      <Panel title="阶段开关">
        <ul className="space-y-1.5">
          {Object.entries(features).map(([k, v]) => (
            <li key={k} className="flex items-center justify-between text-xs">
              <span className="text-muted">{k}</span>
              <Badge tone={v ? 'ok' : 'default'}>{v ? '已启用' : '未交付'}</Badge>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title={`审计日志（${logs.length}）`} className="col-span-2">
        {logs.length === 0 ? (
          <Empty>暂无记录</Empty>
        ) : (
          <ul className="space-y-1">
            {logs.slice(0, 60).map((l) => (
              <li key={l.id} className="flex items-center gap-2 text-[11px]">
                <span className="text-muted">{new Date(l.createdAt).toLocaleString()}</span>
                <Badge tone={l.dangerous ? 'warn' : 'default'}>{l.action}</Badge>
                <span className="text-muted">{l.actor}</span>
                {l.dangerous && <span className="text-amber-400">用户确认：{String(l.confirmedByUser)}</span>}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

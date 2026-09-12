import { useCallback, useEffect, useState } from 'react';
import type { NotifyChannel, NotifyLogRecord } from '@ai/shared';
import { api } from '@/lib/api';
import { describeError, useAppStore } from '@/stores/app-store';
import { Badge, Button, Empty, Panel } from '@/components/ui';
import { NotifyChannelForm, type NotifierMeta } from '@/components/phase3/NotifyChannelForm';

/**
 * 通知设置（Step 7）。
 *
 * 三段：渠道管理 → 渠道目录（说明每个渠道需要什么凭据）→ 发送日志。
 * 凭据处理：只在创建时输入，之后只显示「已配置」，不提供「查看原文」入口（设计如此）。
 */
export function NotificationSettingsPage() {
  const workspace = useAppStore((s) => s.workspace);
  const pushToast = useAppStore((s) => s.pushToast);

  const [catalog, setCatalog] = useState<NotifierMeta[]>([]);
  const [channels, setChannels] = useState<NotifyChannel[]>([]);
  const [logs, setLogs] = useState<NotifyLogRecord[]>([]);
  const [busy, setBusy] = useState(false);

  const loadChannels = useCallback(async () => {
    if (!workspace) return;
    const res = await api.listNotifyChannels(workspace.id);
    setChannels(res.channels);
  }, [workspace]);

  const loadLogs = useCallback(async () => {
    if (!workspace) return;
    const res = await api.listNotifyLogs(workspace.id, 100);
    setLogs(res.logs);
  }, [workspace]);

  useEffect(() => {
    void api.notifyCatalog().then((r) => setCatalog(r.channels as NotifierMeta[])).catch(() => undefined);
  }, []);

  useEffect(() => {
    void loadChannels().catch(() => undefined);
    void loadLogs().catch(() => undefined);
    const timer = setInterval(() => void loadLogs().catch(() => undefined), 20_000);
    return () => clearInterval(timer);
  }, [loadChannels, loadLogs]);

  async function guard(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!workspace) return <Empty>正在加载工作区…</Empty>;

  return (
    <div className="grid h-full grid-cols-[1fr_1fr_1fr] gap-3">
      <Panel title="渠道管理">
        <NotifyChannelForm
          catalog={catalog}
          channels={channels}
          busy={busy}
          onCreate={(input) =>
            guard(async () => {
              await api.createNotifyChannel({ workspaceId: workspace.id, ...input });
              await loadChannels();
              pushToast({ level: 'success', message: '渠道已创建，建议先点「测试」验证配置' });
            })
          }
          onTest={(id) =>
            guard(async () => {
              const r = await api.testNotifyChannel(id, workspace.id);
              await loadChannels();
              await loadLogs();
              pushToast({ level: r.ok ? (r.degraded ? 'warn' : 'success') : 'error', message: r.message });
            })
          }
          onToggle={(id, enabled) =>
            guard(async () => {
              await api.updateNotifyChannel(id, workspace.id, { enabled });
              await loadChannels();
            })
          }
          onDelete={(id) =>
            guard(async () => {
              await api.deleteNotifyChannel(id, workspace.id);
              await loadChannels();
              await loadLogs();
              pushToast({ level: 'success', message: '渠道已删除' });
            })
          }
        />
      </Panel>

      <Panel title="各渠道需要的配置（由你手动申请）">
        <ul className="space-y-2 text-[11px]">
          {catalog.map((c) => (
            <li key={c.type} className="rounded border border-border bg-bg p-2">
              <div className="flex items-center gap-1">
                <span className="font-medium">{c.label}</span>
                <Badge>{c.type}</Badge>
              </div>
              {c.secretFields.length > 0 && (
                <div className="mt-1">
                  <div className="text-[10px] text-muted">敏感凭据（加密存储）</div>
                  <ul className="text-[10px]">
                    {c.secretFields.map((f) => (
                      <li key={f.key}>
                        • {f.label} {f.required ? '(必填)' : '(可选)'} {f.hint && <span className="text-muted">— {f.hint}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {c.configFields.length > 0 && (
                <div className="mt-1">
                  <div className="text-[10px] text-muted">普通配置</div>
                  <ul className="text-[10px]">
                    {c.configFields.map((f) => (
                      <li key={f.key}>
                        • {f.label} {f.hint && <span className="text-muted">— {f.hint}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[10px] text-muted">
          工作台不会代你注册任何平台账号。飞书/钉钉/企业微信机器人的 Webhook 需要在各自群里手动创建。
        </p>
      </Panel>

      <Panel title={`发送日志（${logs.length}）`} actions={<Button onClick={() => void loadLogs()}>刷新</Button>}>
        {logs.length === 0 ? (
          <Empty>还没有发送记录。定时任务执行或部署完成时会自动推送。</Empty>
        ) : (
          <ul className="space-y-1">
            {logs.map((l) => (
              <li key={l.id} className="rounded border border-border bg-bg p-1.5 text-[10px]">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1">
                    <Badge tone={l.status === 'sent' ? 'ok' : l.status === 'failed' ? 'error' : 'warn'}>{l.status}</Badge>
                    <Badge>{l.event}</Badge>
                    {l.attempt > 1 && <span className="text-muted">尝试 {l.attempt} 次</span>}
                  </div>
                  <span className="text-muted">{new Date(l.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
                </div>
                <div className="mt-0.5 truncate font-medium">{l.title}</div>
                <div className="truncate text-muted">{l.content.split('\n')[0]}</div>
                {l.error && <div className="mt-0.5 break-all text-rose-400">{l.error}</div>}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

import { useState } from 'react';
import type { NotifyChannel } from '@ai/shared';
import { Badge, Button } from '@/components/ui';
import { triggerConfirm } from '@/lib/confirm';

/**
 * 通知渠道表单。
 *
 * 表单字段由后端的 catalog 驱动（secretFields / configFields）——
 * 前端不硬编码任何渠道的字段名，新增渠道时后端改一处即可。
 * 凭据字段使用 type=password，且保存后只显示「已配置」标记，不回显。
 */
export interface NotifierMeta {
  type: string;
  label: string;
  secretFields: { key: string; label: string; required: boolean; hint?: string }[];
  configFields: { key: string; label: string; required: boolean; type: string; hint?: string }[];
}

export function NotifyChannelForm({
  catalog,
  channels,
  onCreate,
  onTest,
  onToggle,
  onDelete,
  busy,
}: {
  catalog: NotifierMeta[];
  channels: NotifyChannel[];
  onCreate: (input: { type: string; name: string; config: Record<string, unknown>; secret: Record<string, unknown> }) => void | Promise<void>;
  onTest: (channelId: string) => void | Promise<void>;
  onToggle: (channelId: string, enabled: boolean) => void | Promise<void>;
  onDelete: (channelId: string) => void | Promise<void>;
  busy?: boolean;
}) {
  const [type, setType] = useState(catalog[0]?.type ?? 'desktop');
  const [name, setName] = useState('');
  const [config, setConfig] = useState<Record<string, string>>({});
  const [secret, setSecret] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  const meta = catalog.find((c) => c.type === type);

  async function submit() {
    if (!name.trim()) {
      setError('请填写渠道名称');
      return;
    }
    const missing = [
      ...(meta?.secretFields ?? []).filter((f) => f.required && !secret[f.key]?.trim()).map((f) => f.label),
      ...(meta?.configFields ?? []).filter((f) => f.required && !config[f.key]?.trim()).map((f) => f.label),
    ];
    if (missing.length > 0) {
      setError(`缺少必填项：${missing.join('、')}`);
      return;
    }
    setError('');
    await onCreate({ type, name: name.trim(), config: camelCaseKeys(config), secret: camelCaseKeys(secret) });
    setName('');
    setConfig({});
    setSecret({});
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="text-[11px] font-medium">新建通知渠道</div>
        <div className="flex gap-1">
          <select value={type} onChange={(e) => setType(e.target.value)} className="rounded border border-border bg-bg px-2 py-1 text-[11px]">
            {catalog.map((c) => (
              <option key={c.type} value={c.type}>
                {c.label}
              </option>
            ))}
          </select>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="渠道名称，如 我的飞书群"
            className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-[11px] outline-none focus:border-brand"
          />
        </div>

        {(meta?.configFields ?? []).map((f) => (
          <input
            key={f.key}
            value={config[f.key] ?? ''}
            onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}
            placeholder={`${f.label}${f.required ? ' *' : ''}${f.hint ? `（${f.hint}）` : ''}`}
            className="w-full rounded border border-border bg-bg px-2 py-1 text-[11px] outline-none focus:border-brand"
          />
        ))}
        {(meta?.secretFields ?? []).map((f) => (
          <input
            key={f.key}
            type="password"
            value={secret[f.key] ?? ''}
            onChange={(e) => setSecret({ ...secret, [f.key]: e.target.value })}
            placeholder={`${f.label}${f.required ? ' *' : ''}（加密存储）${f.hint ? ` — ${f.hint}` : ''}`}
            className="w-full rounded border border-border bg-bg px-2 py-1 font-mono text-[11px] outline-none focus:border-brand"
          />
        ))}
        {error && <p className="text-[11px] text-rose-400">{error}</p>}
        <Button variant="primary" onClick={() => void submit()} disabled={busy}>
          创建渠道
        </Button>
        <p className="text-[10px] text-muted">
          凭据使用 AES-256-GCM 加密后入库，接口与日志都不会返回明文。平台方的 Webhook 地址需要你自己去申请。
        </p>
      </div>

      <div className="space-y-1">
        <div className="text-[11px] font-medium">已配置渠道（{channels.length}）</div>
        {channels.length === 0 && <p className="text-[10px] text-muted">还没有渠道。创建后定时任务/部署完成事件会自动推送。</p>}
        <ul className="space-y-1">
          {channels.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 rounded border border-border bg-bg p-1.5">
              <div className="min-w-0">
                <div className="flex items-center gap-1">
                  <span className="truncate text-[11px]">{c.name}</span>
                  <Badge>{c.type}</Badge>
                  {c.configured && <Badge tone="ok">已配置凭据</Badge>}
                  {!c.enabled && <Badge tone="warn">已停用</Badge>}
                </div>
                {c.lastTestedAt && <div className="text-[9px] text-muted">上次测试 {new Date(c.lastTestedAt).toLocaleString('zh-CN', { hour12: false })}</div>}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button onClick={() => void onTest(c.id)} disabled={busy}>
                  测试
                </Button>
                <Button onClick={() => void onToggle(c.id, !c.enabled)} disabled={busy}>
                  {c.enabled ? '停用' : '启用'}
                </Button>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    if (triggerConfirm(`确认删除通知渠道「${c.name}」？相关发送日志也会一并删除。`)) void onDelete(c.id);
                  }}
                >
                  删除
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** 表单字段是 camelCase（后端字段名），这里保持原样但要过滤空值 */
function camelCaseKeys(input: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === '') continue;
    // 数字型配置转成 number，避免后端把 '465' 当字符串
    out[k] = /^\d+$/.test(v) ? Number(v) : v;
  }
  return out;
}

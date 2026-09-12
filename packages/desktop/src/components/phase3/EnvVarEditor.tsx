import { useState } from 'react';
import { Button, Empty } from '@/components/ui';
import { triggerConfirm } from '@/lib/confirm';

/**
 * 环境变量编辑器。
 *
 * 安全设计（与后端一致）：
 *   - 已保存的变量只显示掩码（****xxxx），永远不回显明文；
 *   - 修改 = 用新值覆盖，UI 上不预填旧值（避免明文在 DOM 里停留）；
 *   - 删除需要二次确认。
 */
export interface EnvVarRow {
  key: string;
  masked: string;
  updatedAt: string;
}

export function EnvVarEditor({
  vars,
  onSave,
  onRemove,
  busy,
}: {
  vars: EnvVarRow[];
  onSave: (vars: { key: string; value: string }[]) => void | Promise<void>;
  onRemove: (key: string) => void | Promise<void>;
  busy?: boolean;
}) {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  async function submit() {
    const k = key.trim();
    if (!KEY_RE.test(k)) {
      setError('变量名只允许字母、数字、下划线，且不以数字开头（如 DATABASE_URL）');
      return;
    }
    if (!value) {
      setError('值不能为空');
      return;
    }
    setError('');
    await onSave([{ key: k, value }]);
    setKey('');
    setValue('');
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted">
        值使用 AES-256-GCM 加密存储，接口只返回掩码。部署时按变量名注入到平台，日志与审计中不出现明文。
      </p>

      <div className="flex gap-1">
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="变量名，如 DATABASE_URL"
          className="w-40 rounded border border-border bg-bg px-2 py-1 font-mono text-[11px] outline-none focus:border-brand"
        />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          type="password"
          placeholder="值（不会被回显）"
          className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 font-mono text-[11px] outline-none focus:border-brand"
        />
        <Button variant="primary" onClick={() => void submit()} disabled={busy}>
          保存
        </Button>
      </div>
      {error && <p className="text-[11px] text-rose-400">{error}</p>}

      {vars.length === 0 ? (
        <Empty>还没有环境变量</Empty>
      ) : (
        <ul className="space-y-1">
          {vars.map((v) => (
            <li key={v.key} className="flex items-center justify-between gap-2 rounded border border-border bg-bg px-2 py-1">
              <div className="min-w-0">
                <div className="font-mono text-[11px]">{v.key}</div>
                <div className="font-mono text-[10px] text-muted">{v.masked}</div>
              </div>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  if (triggerConfirm(`确认删除环境变量 ${v.key}？删除后部署将不再注入该变量。`)) void onRemove(v.key);
                }}
              >
                删除
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

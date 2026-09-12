import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { describeError, useAppStore } from '@/stores/app-store';
import { Badge, Button } from '@/components/ui';
import { confirmDanger } from '@/lib/utils';

/**
 * 插件权限授权对话框。
 * 设计原则：**逐项授权**，默认不勾选任何敏感权限；
 * 撤销与授权都要二次确认（撤销会让插件立即失效，授权则提升能力）。
 */
export function PluginPermissionDialog({
  installationId,
  pluginName,
  workspaceId,
  onClose,
  onChanged,
}: {
  installationId: string;
  pluginName: string;
  workspaceId: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const pushToast = useAppStore((s) => s.pushToast);
  const [perms, setPerms] = useState<{ id: string; scope: string; description: string; sensitive: boolean; required: boolean; granted: boolean }[]>([]);
  const [secretRefs, setSecretRefs] = useState<string[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await api.pluginPermissions(installationId, workspaceId);
      setPerms(res.permissions.map((p) => ({ ...p, required: p.required !== false })));
      setSecretRefs(res.secretRefs);
      setSelected(Object.fromEntries(res.permissions.map((p) => [p.scope, p.granted])));
      setError(null);
    } catch (e) {
      setError(describeError(e));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installationId, workspaceId]);

  async function save() {
    const scopes = Object.entries(selected).filter(([, v]) => v).map(([k]) => k);
    if (scopes.length === 0) {
      pushToast({ level: 'warn', message: '至少选择一项权限，或点击「全部撤销」' });
      return;
    }
    if (!confirmDanger(`授权插件 ${pluginName}`, `将授予：\n${scopes.join('\n')}\n\n授权后插件可以执行这些操作，可随时撤销。`)) return;
    setBusy(true);
    try {
      await api.grantPlugin(installationId, workspaceId, scopes, expiresAt ? new Date(expiresAt).toISOString() : null);
      pushToast({ level: 'success', message: `已授权 ${scopes.length} 项权限` });
      await load();
      onChanged?.();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function revokeAll() {
    if (!confirmDanger(`撤销 ${pluginName} 的全部权限`, '撤销后该插件的所有工具调用都会立即失败，直到你重新授权。')) return;
    setBusy(true);
    try {
      await api.revokePlugin(installationId, workspaceId);
      pushToast({ level: 'success', message: '已撤销全部权限' });
      await load();
      onChanged?.();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="max-h-[85vh] w-full max-w-xl overflow-auto rounded-lg border border-border bg-bg p-4">
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-fg">{pluginName} · 权限管理</h2>
          <Button variant="ghost" onClick={onClose}>关闭</Button>
        </header>

        {error && <p className="mb-2 rounded border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-300">{error}</p>}

        <p className="mb-3 rounded border border-border bg-panel p-2 text-[11px] text-muted">
          插件运行在沙箱中（网络 / 文件系统 / 资源受限）。权限**逐项授权**，默认不授予任何权限，可随时撤销。
          {secretRefs.length > 0 && <> 该插件需要你手动配置凭据：<code>{secretRefs.join('、')}</code>（值不会被写入代码或明文库）。</>}
        </p>

        <ul className="mb-3 space-y-2">
          {perms.map((p) => (
            <li key={p.id} className="flex items-start gap-2 rounded border border-border bg-panel p-2">
              <input
                id={`perm-${p.scope}`}
                type="checkbox"
                className="mt-0.5"
                checked={selected[p.scope] ?? false}
                onChange={(e) => setSelected((s) => ({ ...s, [p.scope]: e.target.checked }))}
              />
              <label htmlFor={`perm-${p.scope}`} className="min-w-0 flex-1 cursor-pointer">
                <div className="flex items-center gap-2">
                  <code className="text-xs text-fg">{p.scope}</code>
                  {p.sensitive && <Badge tone="warn">敏感</Badge>}
                  {p.required && <Badge tone="info">必需</Badge>}
                  {p.granted && <Badge tone="ok">已授权</Badge>}
                </div>
                <p className="mt-0.5 text-[11px] text-muted">{p.description}</p>
              </label>
            </li>
          ))}
          {perms.length === 0 && !error && <li className="text-xs text-muted">该插件未声明任何权限。</li>}
        </ul>

        <div className="mb-3 flex items-center gap-2 text-[11px] text-muted">
          <label htmlFor="expires">过期时间（留空则长期有效）</label>
          <input
            id="expires"
            type="datetime-local"
            className="rounded border border-border bg-panel px-2 py-1 text-[11px]"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </div>

        <footer className="flex justify-end gap-2">
          <Button variant="danger" onClick={revokeAll} disabled={busy}>全部撤销</Button>
          <Button variant="primary" onClick={save} disabled={busy}>{busy ? '提交中…' : '保存授权'}</Button>
        </footer>
      </div>
    </div>
  );
}

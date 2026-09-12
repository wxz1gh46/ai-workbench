import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { describeError, useAppStore } from '@/stores/app-store';
import { Badge, Button, Empty, Panel } from '@/components/ui';
import { confirmDanger } from '@/lib/utils';

interface CatalogItem {
  name: string;
  version: string;
  kind?: string;
  source?: string;
  requiresUserAuth: boolean;
  permissions: { scope: string; description: string; sensitive: boolean }[];
  secretRefs: string[];
  config?: Record<string, unknown>;
}

/**
 * 插件市场。
 * 合规设计：付费数据源插件一律要求用户手动提供凭据（secretRefs 仅是变量名，值存 Keychain）。
 */
export function PluginsPage() {
  const workspace = useAppStore((s) => s.workspace);
  const pushToast = useAppStore((s) => s.pushToast);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [installed, setInstalled] = useState<{ id: string; name: string; status: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    if (!workspace) return;
    const res = await api.listPlugins(workspace.id);
    setCatalog(res.catalog as CatalogItem[]);
    setInstalled(res.installed as { id: string; name: string; status: string }[]);
  };

  useEffect(() => {
    void load().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  async function install(name: string, item: CatalogItem) {
    if (!workspace) return;
    const detail = [
      item.requiresUserAuth ? '需要你手动配置凭据（不会写入代码或数据库明文）' : '无需凭据',
      `权限：${item.permissions.map((p) => p.scope).join(', ')}`,
      item.secretRefs.length ? `凭据变量：${item.secretRefs.join(', ')}` : '',
      '插件在沙箱内运行，所有调用会记录审计日志',
    ]
      .filter(Boolean)
      .join('\n');
    if (!confirmDanger(`安装插件 ${name}`, detail)) return;
    setBusy(name);
    try {
      await api.installPlugin(name, workspace.id);
      await load();
      pushToast({ level: 'success', message: `${name} 已安装` });
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid h-full grid-cols-2 gap-3">
      <Panel title="插件市场">
        {catalog.length === 0 ? (
          <Empty>加载中…</Empty>
        ) : (
          <ul className="space-y-2">
            {catalog.map((p) => (
              <li key={p.name} className="rounded border border-border p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">{p.name}</span>
                  <span className="flex items-center gap-1">
                    <Badge>{p.version}</Badge>
                    {p.requiresUserAuth ? <Badge tone="warn">需授权</Badge> : <Badge tone="ok">开箱可用</Badge>}
                    <Button
                      variant="primary"
                      disabled={busy === p.name || installed.some((i) => i.name === p.name)}
                      onClick={() => void install(p.name, p)}
                    >
                      {installed.some((i) => i.name === p.name) ? '已安装' : busy === p.name ? '安装中…' : '安装'}
                    </Button>
                  </span>
                </div>
                <ul className="mt-1.5 space-y-0.5">
                  {p.permissions.map((perm) => (
                    <li key={perm.scope} className="text-[11px] text-muted">
                      {perm.sensitive ? '🔒' : '·'} {perm.scope} — {perm.description}
                    </li>
                  ))}
                </ul>
                {p.secretRefs.length > 0 && (
                  <div className="mt-1 text-[10px] text-amber-400">需在设置中配置：{p.secretRefs.join(', ')}</div>
                )}
                {typeof p.config?.note === 'string' && <div className="mt-1 text-[10px] text-muted">{p.config.note}</div>}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="已安装">
        {installed.length === 0 ? (
          <Empty>尚未安装插件</Empty>
        ) : (
          <ul className="space-y-2">
            {installed.map((p) => (
              <li key={p.id} className="flex items-center justify-between rounded border border-border px-2 py-1.5 text-xs">
                <span>{p.name}</span>
                <Badge tone="ok">{p.status}</Badge>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-[11px] leading-relaxed text-muted">
          合规说明：本工作台仅通过各数据源官方开放平台 API 或用户自身登录态访问数据，不提供任何绕过反爬、共享账号或破解授权的能力。付费数据源的使用需遵守对应服务商条款。
        </p>
      </Panel>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import type { PluginInstallationInfo, PluginManifestV4 } from '@ai/shared';
import { api } from '@/lib/api';
import { describeError, useAppStore } from '@/stores/app-store';
import { Badge, Button, Empty, Panel } from '@/components/ui';
import { confirmDanger } from '@/lib/utils';
import { PluginCard } from '@/components/phase4/PluginCard';
import { PluginPermissionDialog } from '@/components/phase4/PluginPermissionDialog';
import { PluginCallLog } from '@/components/phase4/PluginCallLog';

/**
 * 插件市场（Phase 4 Step 7）。
 * 合规设计要求面板上**明确写出**：只接受官方 API、不代持账号、不绕过反爬。
 */
export function PluginMarketPage() {
  const workspace = useAppStore((s) => s.workspace);
  const pushToast = useAppStore((s) => s.pushToast);
  const [catalog, setCatalog] = useState<PluginManifestV4[]>([]);
  const [installed, setInstalled] = useState<PluginInstallationInfo[]>([]);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [permissionTarget, setPermissionTarget] = useState<{ installationId: string; name: string } | null>(null);
  const [callsTarget, setCallsTarget] = useState<{ installationId: string; name: string } | null>(null);
  const [mcpServers, setMcpServers] = useState<{ id: string; name: string; transport: string; endpoint: string; status: string; secretRefs: string[] }[]>([]);
  const [newServer, setNewServer] = useState({ name: '', transport: 'http', endpoint: '', command: '' });

  const load = useCallback(async () => {
    if (!workspace) return;
    try {
      const [market, inst, mcp] = await Promise.all([api.pluginMarket({ ...(q ? { q } : {}), ...(kind ? { kind } : {}) }), api.listInstalledPlugins(workspace.id), api.listMcpServers(workspace.id)]);
      setCatalog(market.catalog);
      setInstalled(inst.plugins);
      setMcpServers(mcp.servers);
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, q, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  async function install(name: string, manifest: PluginManifestV4) {
    if (!workspace) return;
    const detail = [
      manifest.requiresUserAuth ? `需要你手动配置凭据：${manifest.secretRefs.join('、')}` : '无需凭据',
      `权限：${manifest.permissions.map((p) => p.scope).join('、')}`,
      '插件在沙箱中运行（网络 / 文件系统 / 资源受限）',
      '安装后**不会**自动获得权限，必须逐项授权',
    ].join('\n');
    if (!confirmDanger(`安装插件 ${name}`, detail)) return;
    setBusy(name);
    try {
      await api.installPluginV4(name, workspace.id);
      pushToast({ level: 'success', message: `${name} 已安装，请继续授权权限` });
      await load();
      const inst = (await api.listInstalledPlugins(workspace.id)).plugins.find((p) => p.name === name);
      if (inst) setPermissionTarget({ installationId: inst.installationId, name });
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setBusy(null);
    }
  }

  async function uninstall(pluginId: string, name: string) {
    if (!workspace) return;
    if (!confirmDanger(`卸载插件 ${name}`, '将同时删除其授权与调用日志记录。')) return;
    setBusy(name);
    try {
      await api.uninstallPluginV4(pluginId, workspace.id);
      pushToast({ level: 'success', message: `${name} 已卸载` });
      await load();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setBusy(null);
    }
  }

  async function update(pluginId: string, name: string) {
    if (!workspace) return;
    setBusy(name);
    try {
      const res = await api.updatePluginV4(pluginId, workspace.id);
      pushToast({ level: 'success', message: res.grantedScopes.length === 0 ? `${name} 已更新；权限已被重置，请重新授权` : `${name} 已更新` });
      await load();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setBusy(null);
    }
  }

  async function registerServer() {
    if (!workspace || !newServer.name.trim()) return;
    try {
      await api.registerMcpServer({
        workspaceId: workspace.id,
        name: newServer.name.trim(),
        transport: newServer.transport,
        ...(newServer.transport === 'stdio' ? { command: newServer.command } : { endpoint: newServer.endpoint }),
      });
      pushToast({ level: 'success', message: 'MCP 服务器已注册' });
      setNewServer({ name: '', transport: 'http', endpoint: '', command: '' });
      await load();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    }
  }

  async function syncServer(id: string) {
    if (!workspace) return;
    try {
      const res = await api.syncMcpServer(id, workspace.id);
      pushToast({ level: res.degraded ? 'warn' : 'success', message: res.degraded ? res.note ?? '未接入 MCP 宿主，未同步工具' : `已同步 ${res.synced} 个工具` });
      await load();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    }
  }

  const installedByName = new Map(installed.map((i) => [i.name, i]));

  return (
    <div className="grid min-h-0 flex-1 gap-3 p-3 lg:grid-cols-[2fr_1fr]">
      <Panel
        title="插件市场"
        actions={
          <div className="flex items-center gap-1">
            <input
              className="rounded border border-border bg-bg px-2 py-1 text-[11px] text-fg"
              placeholder="搜索插件 / 工具"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <select className="rounded border border-border bg-bg px-2 py-1 text-[11px]" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="类型">
              <option value="">全部类型</option>
              <option value="mcp">MCP</option>
              <option value="http">HTTP</option>
              <option value="local">本地</option>
              <option value="websocket">WebSocket</option>
            </select>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="rounded border border-border bg-bg p-2 text-[11px] text-muted">
            合规口径：插件一律通过<strong className="text-fg">官方 API / 你本机已授权的终端</strong>访问数据；工作台不代持账号、不申请密钥、
            不绕过反爬、不共享登录态。声明上述违规能力的插件会被直接拒绝安装。
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {catalog.map((m) => (
              <PluginCard
                key={m.name}
                manifest={m}
                {...(installedByName.get(m.name) ? { installed: installedByName.get(m.name)! } : {})}
                busy={busy === m.name}
                onInstall={() => install(m.name, m)}
                {...(installedByName.get(m.name)
                  ? {
                      onUninstall: () => uninstall(installedByName.get(m.name)!.pluginId, m.name),
                      onUpdate: () => update(installedByName.get(m.name)!.pluginId, m.name),
                      onAuthorize: () => setPermissionTarget({ installationId: installedByName.get(m.name)!.installationId, name: m.name }),
                      onViewCalls: () => setCallsTarget({ installationId: installedByName.get(m.name)!.installationId, name: m.name }),
                    }
                  : {})}
              />
            ))}
          </div>
          {catalog.length === 0 && <Empty>没有匹配的插件。</Empty>}
        </div>
      </Panel>

      <div className="flex min-h-0 flex-col gap-3">
        <Panel title="已安装">
          {installed.length === 0 ? (
            <Empty>还没有安装任何插件。</Empty>
          ) : (
            <ul className="space-y-1 text-[11px]">
              {installed.map((p) => (
                <li key={p.installationId} className="rounded border border-border bg-bg px-2 py-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-fg">{p.name} v{p.version}</span>
                    <span className="flex gap-1">
                      {p.requiresUserAuth && <Badge tone="warn">需凭据</Badge>}
                      {p.grantedScopes.length === 0 && <Badge tone="error">未授权</Badge>}
                    </span>
                  </div>
                  <div className="mt-0.5 text-muted">
                    已授权：{p.grantedScopes.join('、') || '（无）'}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="MCP 服务器">
          <div className="space-y-2 text-[11px]">
            <p className="text-muted">
              支持 stdio / http / sse / websocket。endpoint 不允许指向内网或云元数据地址（注册时即拒绝）。
            </p>
            <div className="space-y-1">
              <input className="w-full rounded border border-border bg-bg px-2 py-1 text-fg" placeholder="名称" value={newServer.name} onChange={(e) => setNewServer((s) => ({ ...s, name: e.target.value }))} />
              <select className="w-full rounded border border-border bg-bg px-2 py-1" value={newServer.transport} onChange={(e) => setNewServer((s) => ({ ...s, transport: e.target.value }))} aria-label="传输">
                <option value="http">http</option>
                <option value="sse">sse</option>
                <option value="websocket">websocket</option>
                <option value="stdio">stdio</option>
              </select>
              {newServer.transport === 'stdio' ? (
                <input className="w-full rounded border border-border bg-bg px-2 py-1 text-fg" placeholder="启动命令（如 node）" value={newServer.command} onChange={(e) => setNewServer((s) => ({ ...s, command: e.target.value }))} />
              ) : (
                <input className="w-full rounded border border-border bg-bg px-2 py-1 text-fg" placeholder="https://mcp.example.com/rpc" value={newServer.endpoint} onChange={(e) => setNewServer((s) => ({ ...s, endpoint: e.target.value }))} />
              )}
              <Button variant="primary" onClick={registerServer}>注册服务器</Button>
            </div>
            <ul className="space-y-1">
              {mcpServers.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 rounded border border-border bg-bg px-2 py-1">
                  <span className="min-w-0 truncate text-fg">
                    {s.name} <span className="text-muted">({s.transport})</span>
                  </span>
                  <span className="flex shrink-0 gap-1">
                    <Badge tone={s.status === 'connected' ? 'ok' : s.status === 'error' ? 'error' : 'default'}>{s.status}</Badge>
                    <Button variant="ghost" onClick={() => syncServer(s.id)}>同步工具</Button>
                  </span>
                </li>
              ))}
              {mcpServers.length === 0 && <Empty>还没有注册 MCP 服务器。</Empty>}
            </ul>
          </div>
        </Panel>
      </div>

      {permissionTarget && workspace && (
        <PluginPermissionDialog
          installationId={permissionTarget.installationId}
          pluginName={permissionTarget.name}
          workspaceId={workspace.id}
          onClose={() => setPermissionTarget(null)}
          onChanged={load}
        />
      )}

      {callsTarget && workspace && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
          <div className="max-h-[80vh] w-full max-w-3xl overflow-auto rounded-lg border border-border bg-bg p-4">
            <header className="mb-2 flex items-center justify-between">
              <h2 className="text-sm text-fg">{callsTarget.name} · 调用日志</h2>
              <Button variant="ghost" onClick={() => setCallsTarget(null)}>关闭</Button>
            </header>
            <PluginCallLog installationId={callsTarget.installationId} workspaceId={workspace.id} />
          </div>
        </div>
      )}
    </div>
  );
}

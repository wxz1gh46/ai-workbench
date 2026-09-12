import { useCallback, useEffect, useState } from 'react';
import type { AuditLog, DataMaskRuleInfo, RetentionPolicyInfo, RoleInfo, SsoConfigInfo } from '@ai/shared';
import { api } from '@/lib/api';
import { describeError, useAppStore } from '@/stores/app-store';
import { Badge, Button, Empty, Panel } from '@/components/ui';
import { confirmDanger } from '@/lib/utils';
import { RbacRoleEditor } from '@/components/phase4/RbacRoleEditor';
import { AuditLogView } from '@/components/phase4/AuditLogView';

type Tab = 'rbac' | 'sso' | 'audit' | 'mask' | 'retention';

/**
 * 安全中心（Phase 4 Step 7）。
 * 五个分区：RBAC / SSO / 审计 / 脱敏 / 保留策略。
 * 「危险但未确认」的审计记录在顶部单独提示 —— 这是最需要人工复核的一类。
 */
export function SecurityCenterPage() {
  const workspace = useAppStore((s) => s.workspace);
  const pushToast = useAppStore((s) => s.pushToast);
  const [tab, setTab] = useState<Tab>('rbac');
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [stats, setStats] = useState<{ total: number; dangerous: number; unconfirmedDangerous: number; byAction: { action: string; count: number }[]; byActor: { actor: string; count: number }[] } | null>(null);
  const [dangerousOnly, setDangerousOnly] = useState(false);
  const [actionFilter, setActionFilter] = useState('');
  const [maskRules, setMaskRules] = useState<DataMaskRuleInfo[]>([]);
  const [builtinMask, setBuiltinMask] = useState<{ field: string; strategy: string }[]>([]);
  const [newRule, setNewRule] = useState({ field: '', strategy: 'partial', target: '*' });
  const [retention, setRetention] = useState<RetentionPolicyInfo[]>([]);
  const [dataTypes, setDataTypes] = useState<string[]>([]);
  const [newRetention, setNewRetention] = useState({ dataType: 'audit_logs', retentionDays: 90, action: 'delete' });
  const [sso, setSso] = useState<(SsoConfigInfo & { configured: boolean; hasSecret: boolean }) | null>(null);
  const [ssoForm, setSsoForm] = useState({ issuer: '', clientId: '', clientSecretRef: 'SSO_CLIENT_SECRET', redirectUri: 'http://127.0.0.1:8787/callback', groupMapping: '' });
  const [users, setUsers] = useState<{ userId: string; roles: string[]; permissions: string[] }[]>([]);
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [assignForm, setAssignForm] = useState({ userId: '', role: 'viewer' });
  const [exportRange, setExportRange] = useState({ from: '', to: '' });

  const load = useCallback(async () => {
    if (!workspace) return;
    try {
      const [a, m, r, s, u, ro] = await Promise.all([
        api.auditLogs({ workspaceId: workspace.id, limit: 200, ...(dangerousOnly ? { dangerousOnly: true } : {}), ...(actionFilter ? { action: actionFilter } : {}) }),
        api.maskRules(workspace.id),
        api.retentionPolicies(workspace.id),
        api.ssoConfig(workspace.id),
        api.rbacUsers(workspace.id),
        api.listRoles(workspace.id),
      ]);
      setLogs(a.logs);
      setStats(a.stats);
      setMaskRules(m.rules);
      setBuiltinMask(m.builtin);
      setRetention(r.policies);
      setDataTypes(r.dataTypes);
      setSso(s);
      setUsers(u.users);
      setRoles(ro.roles);
      setSsoForm((f) => ({
        ...f,
        issuer: f.issuer || s.issuer,
        clientId: f.clientId || s.clientId,
        clientSecretRef: s.clientSecretRef || f.clientSecretRef,
        redirectUri: f.redirectUri || s.redirectUri,
        groupMapping: f.groupMapping || Object.entries(s.groupMapping ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
      }));
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, dangerousOnly, actionFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function exportAudit() {
    if (!workspace) return;
    if (!exportRange.from || !exportRange.to) {
      pushToast({ level: 'warn', message: '请选择导出时间范围' });
      return;
    }
    if (!confirmDanger('导出审计日志', '导出内容会经过脱敏（敏感字段被替换），并会留下「导出」这条审计记录。')) return;
    try {
      const res = await api.exportAudit({ workspaceId: workspace.id, from: new Date(exportRange.from).toISOString(), to: new Date(exportRange.to).toISOString() });
      pushToast({ level: 'success', message: `已导出 ${res.rowCount} 条（${res.bytes} 字节）` });
      await load();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    }
  }

  async function applyRetention(dryRun: boolean) {
    if (!workspace) return;
    if (!dryRun && !confirmDanger('执行保留策略', '这会真实删除/匿名化符合条件的历史数据，不可恢复。')) return;
    try {
      const res = await api.applyRetention({ workspaceId: workspace.id, dryRun });
      pushToast({
        level: dryRun ? 'info' : 'success',
        message: res.results.map((r) => `${r.dataType}: ${dryRun ? `将影响 ${r.affected}` : `已处理 ${r.affected}`}`).join('；') || '没有启用的策略',
      });
      await load();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    }
  }

  async function saveSso() {
    if (!workspace) return;
    const mapping: Record<string, string> = {};
    for (const line of ssoForm.groupMapping.split('\n')) {
      const [k, v] = line.split('=').map((x) => x.trim());
      if (k && v) mapping[k] = v;
    }
    try {
      const res = await api.saveSsoConfig({
        workspaceId: workspace.id,
        issuer: ssoForm.issuer,
        clientId: ssoForm.clientId,
        clientSecretRef: ssoForm.clientSecretRef,
        redirectUri: ssoForm.redirectUri,
        groupMapping: mapping,
      });
      setSso(res);
      pushToast({ level: 'success', message: 'SSO 配置已保存（密钥值请通过环境变量提供）' });
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    }
  }

  if (!workspace) return <p className="p-4 text-xs text-muted">正在加载工作区…</p>;

  const TABS: { key: Tab; label: string }[] = [
    { key: 'rbac', label: 'RBAC' },
    { key: 'sso', label: 'SSO' },
    { key: 'audit', label: '审计日志' },
    { key: 'mask', label: '数据脱敏' },
    { key: 'retention', label: '保留策略' },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
      <div className="flex flex-wrap items-center gap-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded border px-2 py-1 text-xs ${tab === t.key ? 'border-brand/60 bg-brand/10 text-fg' : 'border-border bg-panel text-muted hover:border-brand/40'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {stats && stats.unconfirmedDangerous > 0 && (
        <p className="rounded border border-rose-500/50 bg-rose-500/10 p-2 text-xs text-rose-300">
          ⚠️ 检测到 {stats.unconfirmedDangerous} 条「危险操作但未经用户确认」的记录，建议优先复核。
        </p>
      )}

      {tab === 'rbac' && (
        <>
          <Panel title="角色与权限">
            <RbacRoleEditor workspaceId={workspace.id} onChanged={load} />
          </Panel>
          <Panel
            title="用户角色分配"
            actions={
              <div className="flex items-center gap-1">
                <input className="w-32 rounded border border-border bg-bg px-2 py-1 text-[11px] text-fg" placeholder="用户 ID" value={assignForm.userId} onChange={(e) => setAssignForm((s) => ({ ...s, userId: e.target.value }))} />
                <select className="rounded border border-border bg-bg px-2 py-1 text-[11px]" value={assignForm.role} onChange={(e) => setAssignForm((s) => ({ ...s, role: e.target.value }))} aria-label="角色">
                  {roles.map((r) => (
                    <option key={r.id} value={r.name}>{r.name}</option>
                  ))}
                </select>
                <Button
                  onClick={() =>
                    void (async () => {
                      if (!confirmDanger(`为用户 ${assignForm.userId} 分配 ${assignForm.role}`, '该用户会立即获得该角色的全部权限。')) return;
                      try {
                        await api.assignRole(workspace.id, assignForm.userId, assignForm.role);
                        pushToast({ level: 'success', message: '角色已分配' });
                        await load();
                      } catch (e) {
                        pushToast({ level: 'error', message: describeError(e) });
                      }
                    })()
                  }
                >
                  分配
                </Button>
              </div>
            }
          >
            {users.length === 0 ? (
              <Empty>还没有用户被分配角色（本地单机模式下未分配角色的用户按 owner 处理）。</Empty>
            ) : (
              <ul className="space-y-1 text-[11px]">
                {users.map((u) => (
                  <li key={u.userId} className="flex flex-wrap items-center gap-2 rounded border border-border bg-bg px-2 py-1">
                    <span className="text-fg">{u.userId}</span>
                    {u.roles.map((r) => (
                      <Badge key={r} tone="info">{r}</Badge>
                    ))}
                    <span className="text-muted">{u.permissions.length} 项权限</span>
                    <span className="ml-auto flex gap-1">
                      {u.roles.map((r) => (
                        <button
                          key={r}
                          type="button"
                          className="text-rose-300 underline"
                          onClick={() =>
                            void api.unassignRole(workspace.id, u.userId, r).then(load).catch((e) => pushToast({ level: 'error', message: describeError(e) }))
                          }
                        >
                          撤销 {r}
                        </button>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}

      {tab === 'sso' && (
        <Panel title="SSO 配置（OIDC / SAML）">
          <div className="space-y-2 text-[11px]">
            <p className="rounded border border-border bg-bg p-2 text-muted">
              工作台<strong className="text-fg">不代注册 IdP、不代理登录</strong>。这里只填配置，client secret 请通过环境变量提供
              （只填变量名，不接受直接粘贴密钥）。授权流程带 state 与 nonce，防 CSRF 与重放。
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-muted">
                Issuer
                <input className="mt-0.5 w-full rounded border border-border bg-bg px-2 py-1 text-fg" value={ssoForm.issuer} onChange={(e) => setSsoForm((s) => ({ ...s, issuer: e.target.value }))} placeholder="https://idp.example.com" />
              </label>
              <label className="text-muted">
                Client ID
                <input className="mt-0.5 w-full rounded border border-border bg-bg px-2 py-1 text-fg" value={ssoForm.clientId} onChange={(e) => setSsoForm((s) => ({ ...s, clientId: e.target.value }))} />
              </label>
              <label className="text-muted">
                Client Secret 环境变量名
                <input className="mt-0.5 w-full rounded border border-border bg-bg px-2 py-1 font-mono text-fg" value={ssoForm.clientSecretRef} onChange={(e) => setSsoForm((s) => ({ ...s, clientSecretRef: e.target.value }))} placeholder="SSO_CLIENT_SECRET" />
              </label>
              <label className="text-muted">
                Redirect URI
                <input className="mt-0.5 w-full rounded border border-border bg-bg px-2 py-1 text-fg" value={ssoForm.redirectUri} onChange={(e) => setSsoForm((s) => ({ ...s, redirectUri: e.target.value }))} />
              </label>
            </div>
            <label className="block text-muted">
              组 → 角色映射（每行 <code>组名=角色名</code>）
              <textarea className="mt-0.5 h-20 w-full rounded border border-border bg-bg px-2 py-1 font-mono text-fg" value={ssoForm.groupMapping} onChange={(e) => setSsoForm((s) => ({ ...s, groupMapping: e.target.value }))} placeholder={'engineering=member\nsecurity=auditor'} />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={saveSso}>保存配置</Button>
              <Button
                onClick={() =>
                  void api
                    .enableSso(workspace.id, !sso?.enabled)
                    .then((r) => {
                      setSso(r);
                      pushToast({ level: 'success', message: r.enabled ? 'SSO 已启用' : 'SSO 已停用' });
                    })
                    .catch((e) => pushToast({ level: 'error', message: describeError(e) }))
                }
              >
                {sso?.enabled ? '停用' : '启用'}
              </Button>
              {sso?.configured && (
                <Button
                  variant="danger"
                  onClick={() =>
                    void (async () => {
                      if (!confirmDanger('删除 SSO 配置', '删除后需要重新配置才能启用 SSO 登录。')) return;
                      await api.removeSso(workspace.id).then(() => {
                        pushToast({ level: 'success', message: 'SSO 配置已删除' });
                        return load();
                      }).catch((e) => pushToast({ level: 'error', message: describeError(e) }));
                    })()
                  }
                >
                  删除配置
                </Button>
              )}
              <span className="text-muted">
                状态：{sso?.configured ? '已配置' : '未配置'} · 密钥变量：{sso?.hasSecret ? '已设置' : '未设置'}
              </span>
            </div>
          </div>
        </Panel>
      )}

      {tab === 'audit' && (
        <>
          <Panel
            title="审计日志"
            actions={
              <div className="flex flex-wrap items-center gap-1">
                <input className="w-40 rounded border border-border bg-bg px-2 py-1 text-[11px] text-fg" placeholder="动作过滤（如 plugin.install）" value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} />
                <label className="flex items-center gap-1 text-[11px] text-muted">
                  <input type="checkbox" checked={dangerousOnly} onChange={(e) => setDangerousOnly(e.target.checked)} />
                  仅危险操作
                </label>
                <input type="datetime-local" className="rounded border border-border bg-bg px-2 py-1 text-[11px]" value={exportRange.from} onChange={(e) => setExportRange((s) => ({ ...s, from: e.target.value }))} />
                <input type="datetime-local" className="rounded border border-border bg-bg px-2 py-1 text-[11px]" value={exportRange.to} onChange={(e) => setExportRange((s) => ({ ...s, to: e.target.value }))} />
                <Button onClick={exportAudit}>导出</Button>
              </div>
            }
          >
            {stats && (
              <p className="mb-2 text-[11px] text-muted">
                共 {stats.total} 条 · 危险 {stats.dangerous} · 未确认 {stats.unconfirmedDangerous}
                {stats.byAction.length > 0 && <> ｜ 高频动作：{stats.byAction.slice(0, 3).map((a) => `${a.action}(${a.count})`).join('、')}</>}
              </p>
            )}
            <AuditLogView logs={logs} />
          </Panel>
        </>
      )}

      {tab === 'mask' && (
        <>
          <Panel
            title="脱敏规则"
            actions={
              <div className="flex items-center gap-1">
                <input className="w-32 rounded border border-border bg-bg px-2 py-1 text-[11px] text-fg" placeholder="字段名" value={newRule.field} onChange={(e) => setNewRule((s) => ({ ...s, field: e.target.value }))} />
                <select className="rounded border border-border bg-bg px-2 py-1 text-[11px]" value={newRule.strategy} onChange={(e) => setNewRule((s) => ({ ...s, strategy: e.target.value }))} aria-label="策略">
                  <option value="partial">partial 部分</option>
                  <option value="full">full 全部</option>
                  <option value="hash">hash 哈希</option>
                  <option value="nullify">nullify 置空</option>
                </select>
                <input className="w-28 rounded border border-border bg-bg px-2 py-1 text-[11px] text-fg" placeholder="生效对象" value={newRule.target} onChange={(e) => setNewRule((s) => ({ ...s, target: e.target.value }))} />
                <Button
                  variant="primary"
                  onClick={() =>
                    void api
                      .upsertMaskRule({ workspaceId: workspace.id, ...newRule })
                      .then(() => {
                        pushToast({ level: 'success', message: '脱敏规则已保存' });
                        return load();
                      })
                      .catch((e) => pushToast({ level: 'error', message: describeError(e) }))
                  }
                >
                  添加
                </Button>
              </div>
            }
          >
            <ul className="space-y-1 text-[11px]">
              {maskRules.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 rounded border border-border bg-bg px-2 py-1">
                  <span className="text-fg">
                    <code>{r.field}</code> · {r.strategy} · 对象 {r.target} {r.enabled ? '' : '（已停用）'}
                  </span>
                  <button
                    type="button"
                    className="text-rose-300 underline"
                    onClick={() => void api.deleteMaskRule(r.id, workspace.id).then(load).catch((e) => pushToast({ level: 'error', message: describeError(e) }))}
                  >
                    删除
                  </button>
                </li>
              ))}
              {maskRules.length === 0 && <Empty>还没有自定义规则。内置兜底规则会对 token/secret/email 等字段自动脱敏。</Empty>}
            </ul>
            <details className="mt-2 text-[11px] text-muted">
              <summary className="cursor-pointer">内置兜底策略（{builtinMask.length} 项）</summary>
              <p className="mt-1">{builtinMask.map((b) => `${b.field}:${b.strategy}`).join(' · ')}</p>
            </details>
          </Panel>
        </>
      )}

      {tab === 'retention' && (
        <Panel
          title="数据保留策略"
          actions={
            <div className="flex items-center gap-1">
              <select className="rounded border border-border bg-bg px-2 py-1 text-[11px]" value={newRetention.dataType} onChange={(e) => setNewRetention((s) => ({ ...s, dataType: e.target.value }))} aria-label="数据类型">
                {dataTypes.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <input type="number" className="w-20 rounded border border-border bg-bg px-2 py-1 text-[11px] text-fg" value={newRetention.retentionDays} onChange={(e) => setNewRetention((s) => ({ ...s, retentionDays: Number(e.target.value) }))} />
              <select className="rounded border border-border bg-bg px-2 py-1 text-[11px]" value={newRetention.action} onChange={(e) => setNewRetention((s) => ({ ...s, action: e.target.value }))} aria-label="动作">
                <option value="delete">delete 删除</option>
                <option value="anonymize">anonymize 匿名化</option>
                <option value="archive">archive 归档</option>
              </select>
              <Button
                variant="primary"
                onClick={() =>
                  void api
                    .upsertRetention({ workspaceId: workspace.id, ...newRetention })
                    .then(() => {
                      pushToast({ level: 'success', message: '保留策略已保存' });
                      return load();
                    })
                    .catch((e) => pushToast({ level: 'error', message: describeError(e) }))
                }
              >
                保存
              </Button>
            </div>
          }
        >
          <div className="space-y-2 text-[11px]">
            <p className="rounded border border-border bg-bg p-2 text-muted">
              默认<strong className="text-fg">先预演</strong>：先告诉你「会影响多少条」，确认后才会真实执行。
              核心表（users / workspaces / goals / tasks / agents）不允许配置保留策略，避免误删造成不可恢复的数据丢失。
            </p>
            <ul className="space-y-1">
              {retention.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 rounded border border-border bg-bg px-2 py-1">
                  <span className="text-fg">
                    {p.dataType} · {p.retentionDays} 天 · {p.action} {p.enabled ? '' : '（已停用）'}
                    {p.lastRunAt && <span className="text-muted"> · 上次 {new Date(p.lastRunAt).toLocaleString()} 影响 {p.lastAffected} 条</span>}
                  </span>
                  <button
                    type="button"
                    className="text-rose-300 underline"
                    onClick={() => void api.deleteRetention(p.dataType, workspace.id).then(load).catch((e) => pushToast({ level: 'error', message: describeError(e) }))}
                  >
                    删除
                  </button>
                </li>
              ))}
              {retention.length === 0 && <Empty>还没有保留策略。未配置时历史数据会一直保留。</Empty>}
            </ul>
            <div className="flex gap-1">
              <Button onClick={() => applyRetention(true)}>预演</Button>
              <Button variant="danger" onClick={() => applyRetention(false)}>确认执行</Button>
            </div>
          </div>
        </Panel>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import type { PaidDataCredentialInfo, PaidDataProviderSpec, PaidDataQueryRecord } from '@ai/shared';
import { api } from '@/lib/api';
import { describeError, useAppStore } from '@/stores/app-store';
import { Badge, Button, Empty, Panel } from '@/components/ui';
import { confirmDanger } from '@/lib/utils';
import { PaidDataQuery } from '@/components/phase4/PaidDataQuery';
import { PaidDataResult } from '@/components/phase4/PaidDataResult';

/**
 * 付费数据库面板（Phase 4 Step 7）。
 * 面板上必须写清「接的是哪条官方通道、限流多少、不绕过任何限制」——
 * 这是合规文档的一部分，不只是提示文案。
 */
export function PaidDataPanelPage() {
  const workspace = useAppStore((s) => s.workspace);
  const pushToast = useAppStore((s) => s.pushToast);
  const [providers, setProviders] = useState<PaidDataProviderSpec[]>([]);
  const [credentials, setCredentials] = useState<PaidDataCredentialInfo[]>([]);
  const [requiredFields, setRequiredFields] = useState<Record<string, string[]>>({});
  const [queries, setQueries] = useState<PaidDataQueryRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [credForm, setCredForm] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!workspace) return;
    try {
      const [p, c, q] = await Promise.all([api.paidProviders(workspace.id), api.listPaidCredentials(workspace.id), api.listPaidQueries(workspace.id, 50)]);
      setProviders(p.providers);
      setCredentials(c.credentials);
      setRequiredFields(c.requiredFields);
      setQueries(q.queries);
      setSelectedId((prev) => prev ?? p.providers[0]?.id ?? null);
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = providers.find((p) => p.id === selectedId) ?? null;
  const selectedCred = credentials.find((c) => c.providerId === selected?.id);

  async function saveCredentials() {
    if (!workspace || !selected) return;
    const filled = Object.fromEntries(Object.entries(credForm).filter(([, v]) => v.trim()));
    if (Object.keys(filled).length === 0) {
      pushToast({ level: 'warn', message: '请至少填写一个凭据字段' });
      return;
    }
    const required = requiredFields[selected.id] ?? [];
    const missing = required.filter((k) => !filled[k] && !selectedCred?.fieldNames.includes(k));
    if (missing.length > 0) {
      pushToast({ level: 'warn', message: `缺少必填字段：${missing.join('、')}` });
      return;
    }
    if (!confirmDanger(`保存 ${selected.name} 凭据`, `凭据会以 AES-256-GCM 加密后存本地库；接口只返回是否已配置，永不返回明文。\n\n字段：${Object.keys(filled).join('、')}`)) return;
    try {
      const res = await api.savePaidCredential(selected.id, workspace.id, filled);
      pushToast({ level: 'success', message: `已保存（脱敏：${Object.values(res.masked).join(' / ')}）` });
      setCredForm({});
      await load();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    }
  }

  async function removeCredentials() {
    if (!workspace || !selected) return;
    if (!confirmDanger(`删除 ${selected.name} 凭据`, '删除后该数据源将无法查询，直到重新配置。')) return;
    try {
      await api.removePaidCredential(selected.id, workspace.id);
      pushToast({ level: 'success', message: '凭据已删除' });
      await load();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    }
  }

  if (loading) return <p className="p-4 text-xs text-muted">正在加载数据源…</p>;

  return (
    <div className="grid min-h-0 flex-1 gap-3 p-3 lg:grid-cols-[240px_1fr_280px]">
      <Panel title="数据源">
        <ul className="space-y-1 text-[11px]">
          {providers.map((p) => {
            const cred = credentials.find((c) => c.providerId === p.id);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(p.id)}
                  className={`w-full rounded border px-2 py-1 text-left ${
                    selectedId === p.id ? 'border-brand/60 bg-brand/10' : 'border-border bg-bg hover:border-brand/40'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate text-fg">{p.name}</span>
                    {p.requiresUserAuth && <Badge tone={cred ? 'ok' : 'warn'}>{cred ? '已配置' : '需凭据'}</Badge>}
                  </div>
                  <div className="text-muted">{p.region} · {p.rateLimit.perMinute}/分钟</div>
                </button>
              </li>
            );
          })}
        </ul>
      </Panel>

      <div className="flex min-h-0 flex-col gap-3">
        {!selected ? (
          <Panel title="查询"><Empty>请选择左侧的数据源。</Empty></Panel>
        ) : (
          <>
            <Panel title={`${selected.name} · 查询`}>
              <div className="space-y-2 text-[11px]">
                <p className="rounded border border-border bg-bg p-2 text-muted">
                  接入方式：{selected.accessMethods.join(' / ')}
                  <br />
                  官方文档：<a className="text-brand underline" href={selected.docsUrl} target="_blank" rel="noreferrer">{selected.docsUrl}</a>
                  <br />
                  限流：{selected.rateLimit.note}
                  {selected.actions.length > 0 && <> ｜ 可用动作：{selected.actions.map((a) => a.label).join('、')}</>}
                </p>
                <PaidDataQuery provider={selected} workspaceId={workspace!.id} credentialConfigured={Boolean(selectedCred)} onRun={load} />
              </div>
            </Panel>

            <Panel title="查询历史">
              <PaidDataResult
                queries={queries}
                onSelect={(id) => {
                  void (async () => {
                    try {
                      const res = await api.getPaidQuery(id, workspace!.id);
                      pushToast({ level: 'info', message: `${res.query.providerId} ${res.query.action}：${res.query.rowCount} 行（${res.query.status}）` });
                    } catch (e) {
                      pushToast({ level: 'error', message: describeError(e) });
                    }
                  })();
                }}
              />
            </Panel>
          </>
        )}
      </div>

      <Panel title="凭据配置">
        {!selected ? (
          <Empty>请选择数据源。</Empty>
        ) : (
          <div className="space-y-2 text-[11px]">
            <p className="rounded border border-border bg-bg p-2 text-muted">
              {selected.requiresUserAuth
                ? '该数据源需要你自行在官方平台申请凭据。工作台只做本地加密存储，不代持账号、不代注册。'
                : '该数据源为官方开放接口，通常无需凭据（可选填联系邮箱以获得更好配额）。'}
            </p>
            {selectedCred && (
              <p className="rounded border border-emerald-500/40 bg-emerald-500/10 p-2 text-emerald-300">
                已配置字段：{selectedCred.fieldNames.join('、')}
                {selectedCred.lastVerifiedAt && <>（最近校验 {new Date(selectedCred.lastVerifiedAt).toLocaleString()}）</>}
              </p>
            )}
            {(requiredFields[selected.id] ?? []).length > 0 && (
              <p className="text-muted">必填：{(requiredFields[selected.id] ?? []).join('、')}</p>
            )}
            {selected.credentialFields.map((f) => (
              <label key={f.key} className="block text-muted">
                {f.label}
                {f.required && <span className="text-rose-400"> *</span>}
                <input
                  type="password"
                  autoComplete="off"
                  className="mt-0.5 w-full rounded border border-border bg-bg px-2 py-1 text-xs text-fg"
                  value={credForm[f.key] ?? ''}
                  onChange={(e) => setCredForm((s) => ({ ...s, [f.key]: e.target.value }))}
                  placeholder={f.hint ?? f.key}
                />
              </label>
            ))}
            <div className="flex gap-1">
              <Button variant="primary" onClick={saveCredentials}>保存凭据</Button>
              {selectedCred && <Button variant="danger" onClick={removeCredentials}>删除凭据</Button>}
            </div>
            <p className="text-muted">
              提示：只填写要改的字段即可，未填字段会保留原值（避免「只想换 Token，结果密钥被清空」）。
            </p>
          </div>
        )}
      </Panel>
    </div>
  );
}

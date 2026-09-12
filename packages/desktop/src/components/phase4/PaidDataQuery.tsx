import { useEffect, useMemo, useState } from 'react';
import type { PaidDataProviderSpec } from '@ai/shared';
import { api } from '@/lib/api';
import { describeError, useAppStore } from '@/stores/app-store';
import { Badge, Button, Panel } from '@/components/ui';
import { confirmDanger } from '@/lib/utils';

/**
 * 付费数据查询表单。
 * 关键：提交前先跑 preflight，把「会被合规守卫拒绝」的原因提前告诉用户，
 * 避免「点了查询 → 报错 → 不知道哪里不对」。
 */
export function PaidDataQuery({
  provider,
  workspaceId,
  credentialConfigured,
  onRun,
}: {
  provider: PaidDataProviderSpec;
  workspaceId: string;
  credentialConfigured: boolean;
  onRun: () => void;
}) {
  const pushToast = useAppStore((s) => s.pushToast);
  const [action, setAction] = useState(provider.actions[0]?.name ?? '');
  const [params, setParams] = useState<Record<string, string>>({});
  const [purpose, setPurpose] = useState('');
  const [preflight, setPreflight] = useState<{ allowed: boolean; reason?: string } | null>(null);
  const [result, setResult] = useState<{ data: unknown; citations: unknown[]; cached: boolean; degraded: boolean; note?: string; blockedReason?: string; rowCount: number; durationMs: number; status: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const spec = useMemo(() => provider.actions.find((a) => a.name === action) ?? provider.actions[0], [provider, action]);

  useEffect(() => {
    setParams({});
    setResult(null);
    setPreflight(null);
  }, [action, provider.id]);

  async function runPreflight() {
    try {
      const res = await api.paidPreflight({ workspaceId, providerId: provider.id, action, params: normalizeParams(spec, params) });
      setPreflight({ allowed: res.allowed, ...(res.reason ? { reason: res.reason } : {}) });
    } catch (e) {
      setPreflight({ allowed: false, reason: describeError(e) });
    }
  }

  async function run() {
    if (!spec) return;
    const requiredMissing = spec.params.filter((p) => p.required && !params[p.key]?.trim());
    if (requiredMissing.length > 0) {
      pushToast({ level: 'warn', message: `缺少必填参数：${requiredMissing.map((p) => p.label).join('、')}` });
      return;
    }
    if (!credentialConfigured && provider.requiresUserAuth) {
      pushToast({ level: 'warn', message: '该数据源需要先配置凭据' });
      return;
    }
    if (!confirmDanger(`查询 ${provider.name}`, `将调用 ${provider.name} 的官方接口（动作 ${action}）。这会产生真实调用与可能的费用，并留下审计记录。\n\n接入方式：${provider.accessMethods.join(' / ')}`)) return;

    setBusy(true);
    try {
      const res = await api.paidQuery({ workspaceId, providerId: provider.id, action, params: normalizeParams(spec, params), ...(purpose ? { purpose } : {}) });
      setResult(res as never);
      pushToast({ level: res.status === 'blocked' ? 'warn' : res.degraded ? 'info' : 'success', message: res.blockedReason ?? res.note ?? '查询完成' });
      onRun();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="rounded border border-border bg-panel px-2 py-1 text-xs"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          aria-label="动作"
        >
          {provider.actions.map((a) => (
            <option key={a.name} value={a.name}>{a.label}</option>
          ))}
        </select>
        <Button onClick={runPreflight}>预检</Button>
        <Button variant="primary" onClick={run} disabled={busy}>{busy ? '查询中…' : '查询'}</Button>
        {provider.rateLimit && <span className="text-[11px] text-muted">限流 {provider.rateLimit.perMinute}/分钟</span>}
      </div>

      {spec && (
        <div className="grid gap-2 sm:grid-cols-2">
          {spec.params.map((p) => (
            <label key={p.key} className="text-[11px] text-muted">
              {p.label}{p.required && <span className="text-rose-400"> *</span>}
              <input
                className="mt-0.5 w-full rounded border border-border bg-panel px-2 py-1 text-xs text-fg"
                value={params[p.key] ?? ''}
                onChange={(e) => setParams((s) => ({ ...s, [p.key]: e.target.value }))}
                placeholder={p.key}
              />
            </label>
          ))}
        </div>
      )}

      <label className="block text-[11px] text-muted">
        用途说明（写入审计，便于合规追溯）
        <input
          className="mt-0.5 w-full rounded border border-border bg-panel px-2 py-1 text-xs text-fg"
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          placeholder="例如：季度投资报告的企业背景核查"
        />
      </label>

      {preflight && (
        <p className={`rounded border p-2 text-[11px] ${preflight.allowed ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/40 bg-amber-500/10 text-amber-300'}`}>
          {preflight.allowed ? '✅ 预检通过，可以查询' : `⚠️ 预检不通过：${preflight.reason}`}
        </p>
      )}

      {result && (
        <Panel title="查询结果">
          <div className="space-y-2 text-[11px]">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={result.status === 'blocked' ? 'error' : result.degraded ? 'warn' : 'ok'}>{result.status}</Badge>
              {result.cached && <Badge tone="info">缓存命中</Badge>}
              {result.degraded && <Badge tone="warn">已降级</Badge>}
              <span className="text-muted">{result.rowCount} 行 · {result.durationMs}ms</span>
            </div>
            {(result.blockedReason || result.note) && <p className="text-amber-300">{result.blockedReason ?? result.note}</p>}
            <pre className="max-h-72 overflow-auto rounded border border-border bg-panel p-2 font-mono text-[11px] text-muted">
              {JSON.stringify(result.data, null, 2)?.slice(0, 8000) ?? '（无数据）'}
            </pre>
            {result.citations.length > 0 && (
              <ul className="space-y-0.5">
                {(result.citations as { title: string; url: string; accessedAt: string }[]).map((c, i) => (
                  <li key={i} className="text-muted">
                    [{i + 1}] {c.title} · <a className="text-brand underline" href={c.url} target="_blank" rel="noreferrer">{c.url}</a> · 访问于 {new Date(c.accessedAt).toLocaleString()}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>
      )}
    </div>
  );
}

function normalizeParams(spec: PaidDataProviderSpec['actions'][number] | undefined, params: Record<string, string>): Record<string, unknown> {
  if (!spec) return {};
  const out: Record<string, unknown> = {};
  for (const p of spec.params) {
    const v = params[p.key]?.trim();
    if (v) out[p.key] = v;
  }
  return out;
}

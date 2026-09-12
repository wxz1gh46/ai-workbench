import { useCallback, useEffect, useState } from 'react';
import type { DatabaseConnectionInfo, DatabaseMigration, DatabaseSchemaSnapshot, QueryResult } from '@ai/shared';
import { api } from '@/lib/api';
import { describeError, useAppStore } from '@/stores/app-store';
import { Badge, Button, Empty, Panel } from '@/components/ui';
import { triggerConfirm } from '@/lib/confirm';

/**
 * 数据库面板（Step 7）。
 *
 * 三段式：连接管理 → Schema/迁移 → 查询控制台。
 * 安全提示贯穿 UI：
 *   - 连接串输入后立即加密，不回显；
 *   - 查询默认只读，写操作要显式关闭只读并二次确认；
 *   - DDL/危险语句在提交前就会由服务端拦截（这里同时给出预检提示）。
 */
export function DatabasePanelPage() {
  const workspace = useAppStore((s) => s.workspace);
  const pushToast = useAppStore((s) => s.pushToast);

  const [providers, setProviders] = useState<{ provider: string; label: string; needs: string[]; docs: string }[]>([]);
  const [connections, setConnections] = useState<DatabaseConnectionInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [migrations, setMigrations] = useState<DatabaseMigration[]>([]);
  const [schema, setSchema] = useState<DatabaseSchemaSnapshot | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [sql, setSql] = useState('select 1');
  const [readOnly, setReadOnly] = useState(true);
  const [rows, setRows] = useState<QueryResult | null>(null);
  const [preflight, setPreflight] = useState<{ safe: boolean; isWrite: boolean; needConfirm: boolean; reason?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [newProvider, setNewProvider] = useState('neon');
  const [newName, setNewName] = useState('');
  const [newConn, setNewConn] = useState('');

  const loadConnections = useCallback(async () => {
    if (!workspace) return;
    const res = await api.listDatabases(workspace.id);
    setConnections(res.connections);
    if (!selected && res.connections[0]) setSelected(res.connections[0].id);
  }, [workspace, selected]);

  useEffect(() => {
    void api.dbProviders().then((r) => setProviders(r.providers)).catch(() => undefined);
  }, []);

  useEffect(() => {
    void loadConnections().catch(() => undefined);
    if (workspace) void api.listWebsites(workspace.id).then((r) => setProjects(r.projects.map((p) => ({ id: p.id, name: p.name })))).catch(() => undefined);
  }, [loadConnections, workspace]);

  const loadDetail = useCallback(async () => {
    if (!workspace || !selected) return;
    const res = await api.getDatabase(selected, workspace.id);
    setMigrations(res.migrations);
    setSchema(null);
  }, [workspace, selected]);

  useEffect(() => {
    void loadDetail().catch(() => undefined);
  }, [loadDetail]);

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

  async function runPreflight() {
    if (!workspace || !selected) return;
    await guard(async () => {
      const res = await api.runDbQuery(selected, workspace.id, sql, { readOnly });
      setPreflight('preflight' in res ? res.preflight : null);
    });
  }

  async function execute() {
    if (!workspace || !selected) return;
    if (preflight?.isWrite && !readOnly) {
      if (!triggerConfirm(`确认执行写操作？\n\nSQL：${sql.slice(0, 200)}\n\n会真实修改云端数据库并写入审计日志。建议先在只读模式确认 SELECT 结果。`)) return;
    }
    await guard(async () => {
      const res = await api.runDbQuery(selected, workspace.id, sql, { readOnly, limit: 200, confirm: true });
      if ('columns' in res) {
        setRows(res);
        setPreflight(null);
      } else {
        setPreflight(res.preflight);
      }
    });
  }

  if (!workspace) return <Empty>正在加载工作区…</Empty>;

  return (
    <div className="grid h-full grid-cols-[240px_1fr_1fr] gap-3">
      <Panel title="数据库连接">
        <div className="space-y-2">
          <select value={newProvider} onChange={(e) => setNewProvider(e.target.value)} className="w-full rounded border border-border bg-bg px-2 py-1 text-[11px]">
            {providers.map((p) => (
              <option key={p.provider} value={p.provider}>
                {p.label}
              </option>
            ))}
          </select>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="连接名称，如 生产库"
            className="w-full rounded border border-border bg-bg px-2 py-1 text-[11px] outline-none focus:border-brand"
          />
          <input
            type="password"
            value={newConn}
            onChange={(e) => setNewConn(e.target.value)}
            placeholder="postgres://user:pass@host:5432/db"
            className="w-full rounded border border-border bg-bg px-2 py-1 font-mono text-[10px] outline-none focus:border-brand"
          />
          <Button
            variant="primary"
            className="w-full"
            disabled={busy}
            onClick={() =>
              guard(async () => {
                if (!newName.trim() || !newConn.trim()) {
                  pushToast({ level: 'error', message: '请填写名称与连接串' });
                  return;
                }
                const res = await api.createDatabase({ workspaceId: workspace.id, provider: newProvider, name: newName.trim(), connectionString: newConn.trim() });
                setNewName('');
                setNewConn('');
                setSelected(res.connection.id);
                await loadConnections();
                pushToast({ level: 'success', message: '连接已创建（连接串已加密存储），请点「测试连接」' });
              })
            }
          >
            新建连接
          </Button>
          <p className="text-[10px] text-muted">
            连接串 AES-256-GCM 加密后入库，接口只返回 host/db。平台账号需你自己申请，工作台不代持。
          </p>

          <ul className="space-y-1">
            {connections.map((c) => (
              <li key={c.id}>
                <button
                  onClick={() => setSelected(c.id)}
                  className={`w-full rounded border px-2 py-1 text-left text-[11px] ${selected === c.id ? 'border-brand bg-brand/10' : 'border-border hover:border-brand/60'}`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate">{c.name}</span>
                    <Badge tone={c.status === 'ok' ? 'ok' : c.status === 'error' ? 'error' : 'warn'}>{c.status}</Badge>
                  </div>
                  <div className="truncate font-mono text-[9px] text-muted">{c.target}</div>
                </button>
              </li>
            ))}
            {connections.length === 0 && <Empty>还没有数据库连接</Empty>}
          </ul>
        </div>
      </Panel>

      <Panel
        title="Schema 与迁移"
        actions={
          selected && (
            <>
              <Button
                disabled={busy}
                onClick={() =>
                  guard(async () => {
                    const r = await api.testDatabase(selected, workspace.id);
                    await loadConnections();
                    pushToast({ level: r.ok ? 'success' : r.degraded ? 'warn' : 'error', message: r.message });
                  })
                }
              >
                测试连接
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  guard(async () => {
                    const r = await api.introspectDb(selected, workspace.id);
                    setSchema(r.schema);
                    pushToast({ level: 'success', message: `已读取 ${r.schema.tables.length} 张表` });
                  })
                }
              >
                读取现有结构
              </Button>
            </>
          )
        }
      >
        {!selected ? (
          <Empty>请选择连接</Empty>
        ) : (
          <div className="space-y-3">
            <div>
              <div className="mb-1 text-[11px] font-medium">从网站需求生成 Schema</div>
              <div className="flex gap-1">
                <select id="site-select" className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-[10px]">
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <Button
                  disabled={busy || projects.length === 0}
                  onClick={() =>
                    guard(async () => {
                      const el = document.getElementById('site-select') as HTMLSelectElement | null;
                      const siteId = el?.value;
                      if (!siteId) return;
                      const r = await api.generateDbSchema(selected, workspace.id, siteId);
                      setSchema(r.snapshot);
                      await loadDetail();
                      pushToast({ level: 'success', message: `已生成 ${r.snapshot.tables.length} 张表的 DDL（v${r.version}），可在迁移历史中应用` });
                    })
                  }
                >
                  生成
                </Button>
              </div>
            </div>

            {schema && (
              <div className="rounded border border-border bg-bg p-2 text-[10px]">
                <div className="mb-1 font-medium">{schema.tables.length} 张表</div>
                <ul className="space-y-1">
                  {schema.tables.map((t) => (
                    <li key={t.name}>
                      <div className="font-mono">{t.name}{t.rls ? ' (RLS)' : ''}</div>
                      <div className="text-muted">{t.columns.map((c) => `${c.name}:${c.type}${c.primary ? '(PK)' : c.nullable ? '' : '*'}`).join(', ')}</div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <div className="mb-1 text-[11px] font-medium">迁移历史（{migrations.length}）</div>
              <ul className="space-y-1">
                {migrations.map((m) => (
                  <li key={m.id} className="rounded border border-border bg-bg p-1.5 text-[10px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono">{m.name}</span>
                      <Badge tone={m.status === 'applied' ? 'ok' : m.status === 'failed' ? 'error' : m.status === 'rolled-back' ? 'warn' : 'default'}>{m.status}</Badge>
                    </div>
                    {m.error && <p className="mt-0.5 text-rose-400">{m.error}</p>}
                    <div className="mt-1 flex gap-1">
                      {m.status === 'pending' && (
                        <Button
                          disabled={busy}
                          onClick={() => {
                            if (!triggerConfirm(`确认把迁移 ${m.name} 应用到云端数据库？\n\n${m.sql.slice(0, 300)}`)) return;
                            void guard(async () => {
                              const r = await api.applyMigration(selected, workspace.id, m.id);
                              await loadDetail();
                              pushToast({ level: r.ok ? 'success' : 'error', message: r.message });
                            });
                          }}
                        >
                          应用
                        </Button>
                      )}
                      {m.status === 'applied' && m.downSql && (
                        <Button
                          variant="danger"
                          disabled={busy}
                          onClick={() => {
                            if (!triggerConfirm(`确认回滚迁移 ${m.name}？\n\n将执行：\n${m.downSql.slice(0, 300)}`)) return;
                            void guard(async () => {
                              const r = await api.rollbackMigration(selected, workspace.id, m.id);
                              await loadDetail();
                              pushToast({ level: r.ok ? 'success' : 'error', message: r.message });
                            });
                          }}
                        >
                          回滚
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
                {migrations.length === 0 && <Empty>还没有迁移。先「生成 Schema」创建一条。</Empty>}
              </ul>
            </div>

            <Button
              variant="danger"
              disabled={busy}
              onClick={() => {
                const c = connections.find((x) => x.id === selected);
                if (!triggerConfirm(`确认删除连接「${c?.name}」？仅删除本工作台的连接配置，不会删除云端数据库。`)) return;
                void guard(async () => {
                  await api.deleteDatabase(selected, workspace.id);
                  setSelected(null);
                  await loadConnections();
                  pushToast({ level: 'success', message: '连接已删除（云端数据未受影响）' });
                });
              }}
            >
              删除连接
            </Button>
          </div>
        )}
      </Panel>

      <Panel
        title="查询控制台"
        actions={
          <label className="flex items-center gap-1 text-[10px] text-muted">
            <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
            只读模式
          </label>
        }
      >
        <div className="space-y-2">
          <textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            rows={5}
            placeholder="select * from users limit 10"
            className="w-full resize-none rounded border border-border bg-bg p-2 font-mono text-[10px] outline-none focus:border-brand"
          />
          <div className="flex gap-1">
            <Button onClick={() => void runPreflight()} disabled={busy}>
              预检
            </Button>
            <Button variant={preflight?.isWrite && !readOnly ? 'danger' : 'primary'} onClick={() => void execute()} disabled={busy}>
              执行
            </Button>
          </div>

          {preflight && (
            <div className={`rounded border p-1.5 text-[10px] ${preflight.safe ? 'border-border bg-bg' : 'border-rose-500/40 bg-rose-500/5 text-rose-300'}`}>
              {!preflight.safe ? (
                <p>被安全策略拒绝：{preflight.reason}</p>
              ) : (
                <p>
                  {preflight.isWrite ? '检测到写操作' : '只读查询'}
                  {preflight.needConfirm && ' — 执行前需要二次确认'}
                </p>
              )}
            </div>
          )}

          {rows && (
            <div className="space-y-1">
              <div className="text-[10px] text-muted">
                {rows.rowCount} 行 · {rows.ms}ms · {rows.readOnly ? '只读' : '写模式'} {rows.truncated ? '· 已截断' : ''}
              </div>
              <div className="max-h-64 overflow-auto rounded border border-border">
                <table className="w-full text-[10px]">
                  <thead className="sticky top-0 bg-panel">
                    <tr>
                      {rows.columns.map((c) => (
                        <th key={c} className="whitespace-nowrap px-1.5 py-1 text-left text-muted">
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {rows.rows.slice(0, 100).map((r, i) => (
                      <tr key={i} className="border-t border-border">
                        {rows.columns.map((c) => (
                          <td key={c} className="max-w-[180px] truncate px-1.5 py-0.5">
                            {String(r[c] ?? '')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="border-t border-border pt-2">
            <Button
              disabled={busy || !selected}
              onClick={() =>
                guard(async () => {
                  const r = await api.backupDatabase(selected as string, workspace.id);
                  pushToast({ level: 'success', message: `备份完成：${r.tables} 张表 / ${(r.bytes / 1024).toFixed(1)}KB / sha256 ${r.sha256.slice(0, 12)}…` });
                })
              }
            >
              逻辑备份
            </Button>
            <p className="mt-1 text-[10px] text-muted">备份导出结构 + 每表前 100 行样本，完整备份请用 pg_dump。</p>
          </div>
        </div>
      </Panel>
    </div>
  );
}

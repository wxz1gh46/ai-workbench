import { useCallback, useEffect, useState } from 'react';
import type { ProviderCapability, WebsiteDeployment, WebsitePlan, WebsiteProject } from '@ai/shared';
import { api } from '@/lib/api';
import { describeError, useAppStore } from '@/stores/app-store';
import { Badge, Button, Empty, Panel } from '@/components/ui';
import { triggerConfirm } from '@/lib/confirm';
import { WebsitePreview } from '@/components/phase3/WebsitePreview';
import { DeployLogView, type DeployLogLine } from '@/components/phase3/DeployLogView';
import { DomainConfig, type DomainBinding } from '@/components/phase3/DomainConfig';
import { EnvVarEditor, type EnvVarRow } from '@/components/phase3/EnvVarEditor';

/**
 * 部署中心（Step 7）。
 *
 * 页面结构（左 → 右三段）：项目管理 → 生成/构建 → 部署与运维（日志/域名/环境变量/访问控制/回滚/删除）。
 * 所有危险动作都走 triggerConfirm，文案明确写出后果，避免「点错了」。
 */
export function DeployCenterPage() {
  const workspace = useAppStore((s) => s.workspace);
  const pushToast = useAppStore((s) => s.pushToast);

  const [providers, setProviders] = useState<ProviderCapability[]>([]);
  const [projects, setProjects] = useState<WebsiteProject[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    project: WebsiteProject;
    deployments: WebsiteDeployment[];
    access: { id: string; type: string; value: string }[];
    envVars: EnvVarRow[];
    files: { path: string; bytes: number }[];
    previewCommand: string;
  } | null>(null);
  const [name, setName] = useState('');
  const [requirement, setRequirement] = useState('');
  const [busy, setBusy] = useState(false);
  const [logLines, setLogLines] = useState<DeployLogLine[]>([]);
  const [logTarget, setLogTarget] = useState<string | null>(null);
  const [checks, setChecks] = useState<{ name: string; ok: boolean; detail: string }[] | null>(null);
  const [binding, setBinding] = useState<DomainBinding | null>(null);
  const [provider, setProvider] = useState('local-preview');
  const [accessType, setAccessType] = useState('password');
  const [accessValue, setAccessValue] = useState('');

  const loadProjects = useCallback(async () => {
    if (!workspace) return;
    const res = await api.listWebsites(workspace.id);
    setProjects(res.projects);
    if (!selected && res.projects[0]) setSelected(res.projects[0].id);
  }, [workspace, selected]);

  const loadDetail = useCallback(
    async (id: string) => {
      const res = await api.getWebsite(id);
      setDetail(res);
    },
    [],
  );

  useEffect(() => {
    void api.deployCapabilities().then((r) => setProviders(r.providers)).catch(() => undefined);
  }, []);

  useEffect(() => {
    void loadProjects().catch(() => undefined);
  }, [loadProjects]);

  useEffect(() => {
    if (selected) void loadDetail(selected).catch(() => undefined);
    setChecks(null);
    setBinding(null);
  }, [selected, loadDetail]);

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

  async function createProject() {
    if (!workspace || !name.trim()) {
      pushToast({ level: 'error', message: '请填写项目名称' });
      return;
    }
    await guard(async () => {
      const res = await api.createWebsite({ workspaceId: workspace.id, name: name.trim(), requirement: requirement.trim() });
      setSelected(res.project.id);
      setName('');
      setRequirement('');
      await loadProjects();
      pushToast({ level: 'success', message: '项目已创建，接下来点「生成」' });
    });
  }

  async function generate() {
    if (!selected) return;
    await guard(async () => {
      const res = await api.generateWebsite(selected, requirement.trim() || undefined);
      await loadDetail(selected);
      await loadProjects();
      pushToast({
        level: res.plan.degraded ? 'warn' : 'success',
        message: `已生成 ${res.files.length} 个文件到 ${res.rootDir}（${res.previewCommand} 可预览）`,
      });
    });
  }

  async function build() {
    if (!selected) return;
    await guard(async () => {
      const res = await api.buildWebsite(selected);
      setChecks(res.checks);
      pushToast({ level: res.ok ? 'success' : 'error', message: res.ok ? `构建检查通过（${res.files} 文件 / ${(res.bytes / 1024).toFixed(1)}KB）` : '构建检查未通过，见下方明细' });
    });
  }

  async function deploy() {
    if (!selected) return;
    const capability = providers.find((p) => p.provider === provider);
    if (
      !triggerConfirm(
        `确认部署到 ${capability?.label ?? provider}？\n\n` +
          (capability?.requiresToken
            ? `需要 ${capability.tokenEnvKeys.join('、')}，未配置会失败（不会替你申请账号）。\n`
            : '本地预览不需要凭据，但不会发布到公网。\n') +
          '部署会产生真实外部调用并写入审计日志。',
      )
    ) {
      return;
    }
    await guard(async () => {
      const res = await api.deployWebsite(selected, provider);
      setLogTarget(res.deployment.id);
      setLogLines([]);
      await loadDetail(selected);
      await loadProjects();
      pushToast({
        level: res.degraded ? 'warn' : 'success',
        message: res.degraded ? `本地预览地址：${res.deployment.url}（未发布公网）` : `部署成功：${res.deployment.url}`,
      });
    });
  }

  async function loadLogs(deploymentId: string) {
    setLogTarget(deploymentId);
    try {
      const res = await api.deployLogs(deploymentId);
      setLogLines(res.lines);
    } catch {
      setLogLines([]);
    }
  }

  if (!workspace) return <Empty>正在加载工作区…</Empty>;

  return (
    <div className="grid h-full grid-cols-[220px_1fr_1fr] gap-3">
      <Panel title="网站项目" actions={<Button onClick={() => void loadProjects()}>刷新</Button>}>
        <div className="space-y-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="项目名，如 my-shop"
            className="w-full rounded border border-border bg-bg px-2 py-1 text-[11px] outline-none focus:border-brand"
          />
          <textarea
            value={requirement}
            onChange={(e) => setRequirement(e.target.value)}
            placeholder="描述你想要的网站，例如：做一个客户管理系统，有客户和订单，带后台管理"
            rows={3}
            className="w-full resize-none rounded border border-border bg-bg px-2 py-1 text-[11px] outline-none focus:border-brand"
          />
          <Button variant="primary" onClick={() => void createProject()} disabled={busy} className="w-full">
            新建项目
          </Button>

          <ul className="space-y-1">
            {projects.map((p) => (
              <li key={p.id}>
                <button
                  onClick={() => setSelected(p.id)}
                  className={`w-full rounded border px-2 py-1 text-left text-[11px] ${
                    selected === p.id ? 'border-brand bg-brand/10' : 'border-border hover:border-brand/60'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate">{p.name}</span>
                    <Badge tone={p.status === 'deployed' ? 'ok' : p.status === 'failed' ? 'error' : 'default'}>{p.status}</Badge>
                  </div>
                  <div className="text-[9px] text-muted">{p.type}</div>
                </button>
              </li>
            ))}
            {projects.length === 0 && <Empty>还没有网站项目</Empty>}
          </ul>
        </div>
      </Panel>

      <Panel
        title={detail ? `生成与构建 · ${detail.project.name}` : '生成与构建'}
        actions={
          detail && (
            <>
              <Button onClick={() => void build()} disabled={busy}>
                构建检查
              </Button>
              <Button variant="primary" onClick={() => void generate()} disabled={busy}>
                生成项目
              </Button>
            </>
          )
        }
      >
        {!detail ? (
          <Empty>请选择或创建一个项目</Empty>
        ) : (
          <div className="space-y-3">
            <WebsitePreview plan={detail.project.plan as WebsitePlan} files={detail.files} />
            {checks && (
              <div className="rounded border border-border bg-bg p-2 text-[10px]">
                <div className="mb-1 font-medium">构建检查明细</div>
                <ul className="space-y-0.5">
                  {checks.map((c) => (
                    <li key={c.name} className="flex gap-2">
                      <span className={c.ok ? 'text-emerald-400' : 'text-rose-400'}>{c.ok ? '✓' : '✗'}</span>
                      <span>{c.name}</span>
                      <span className="text-muted">{c.detail}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {detail.project.rootDir && (
              <p className="text-[10px] text-muted">
                产物目录：<span className="font-mono">{detail.project.rootDir}</span> · 本地运行：<span className="font-mono">{detail.previewCommand}</span>
              </p>
            )}
          </div>
        )}
      </Panel>

      <Panel
        title="部署与运维"
        actions={
          detail && (
            <select value={provider} onChange={(e) => setProvider(e.target.value)} className="rounded border border-border bg-bg px-1.5 py-0.5 text-[10px]">
              {providers.map((p) => (
                <option key={p.provider} value={p.provider}>
                  {p.label}
                  {p.requiresToken ? '' : '（免凭据）'}
                </option>
              ))}
            </select>
          )
        }
      >
        {!detail ? (
          <Empty>请选择项目</Empty>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1">
              <Button variant="primary" onClick={() => void deploy()} disabled={busy}>
                一键部署
              </Button>
            </div>

            <div>
              <div className="mb-1 text-[11px] font-medium">部署记录（{detail.deployments.length}）</div>
              <ul className="space-y-1">
                {detail.deployments.map((d) => (
                  <li key={d.id} className="rounded border border-border bg-bg p-1.5 text-[10px]">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1">
                        <Badge tone={d.status === 'deployed' ? 'ok' : d.status === 'failed' ? 'error' : 'warn'}>{d.status}</Badge>
                        <span className="text-muted">{d.provider}</span>
                        {d.rollbackOf && <Badge tone="info">回滚自 {d.rollbackOf.slice(0, 10)}</Badge>}
                      </div>
                      <span className="text-muted">{new Date(d.createdAt).toLocaleString('zh-CN', { hour12: false })}</span>
                    </div>
                    {d.url && (
                      <a href={d.url} target="_blank" rel="noreferrer" className="block truncate text-brand hover:underline">
                        {d.url}
                      </a>
                    )}
                    <div className="mt-1 flex gap-1">
                      <Button onClick={() => void loadLogs(d.id)}>日志</Button>
                      {d.status === 'deployed' && (
                        <Button
                          onClick={() => {
                            if (!triggerConfirm(`确认把线上网站回滚到这次部署？\n\n地址：${d.url ?? '（无）'}\n回滚会重新指向历史版本，用户将立即看到旧内容。`)) return;
                            void guard(async () => {
                              await api.rollbackWebsite(detail.project.id, d.id);
                              await loadDetail(detail.project.id);
                              pushToast({ level: 'success', message: '回滚完成' });
                            });
                          }}
                        >
                          回滚
                        </Button>
                      )}
                      <Button
                        variant="danger"
                        onClick={() => {
                          if (!triggerConfirm(`确认为 ${d.provider} 删除这次部署？此操作不可撤销。`)) return;
                          void guard(async () => {
                            const r = await api.deleteDeployment(detail.project.id, d.id);
                            await loadDetail(detail.project.id);
                            pushToast({ level: r.ok ? 'success' : 'warn', message: r.message });
                          });
                        }}
                      >
                        删除
                      </Button>
                    </div>
                  </li>
                ))}
                {detail.deployments.length === 0 && <Empty>还没有部署记录</Empty>}
              </ul>
            </div>

            {logTarget && (
              <DeployLogView
                lines={logLines}
                live={logLines.length > 0}
                fallbackText={detail.deployments.find((d) => d.id === logTarget)?.log}
              />
            )}

            <div>
              <div className="mb-1 text-[11px] font-medium">环境变量</div>
              <EnvVarEditor
                vars={detail.envVars}
                busy={busy}
                onSave={(vars) =>
                  guard(async () => {
                    const r = await api.setWebsiteEnv(detail.project.id, vars);
                    await loadDetail(detail.project.id);
                    pushToast({ level: 'success', message: `已保存 ${r.keys.join(', ')}（值已加密）` });
                  })
                }
                onRemove={(key) =>
                  guard(async () => {
                    await api.removeWebsiteEnv(detail.project.id, key);
                    await loadDetail(detail.project.id);
                    pushToast({ level: 'success', message: `已删除 ${key}` });
                  })
                }
              />
            </div>

            <div>
              <div className="mb-1 text-[11px] font-medium">自定义域名</div>
              <DomainConfig
                providers={providers}
                binding={binding}
                busy={busy}
                onBind={(domain, p) =>
                  guard(async () => {
                    const r = await api.bindDomain(detail.project.id, domain, p);
                    setBinding(r.binding);
                    pushToast({ level: r.binding.status === 'failed' ? 'warn' : 'success', message: r.binding.message });
                  })
                }
              />
            </div>

            <div>
              <div className="mb-1 text-[11px] font-medium">访问控制</div>
              <div className="flex gap-1">
                <select value={accessType} onChange={(e) => setAccessType(e.target.value)} className="rounded border border-border bg-bg px-1.5 py-1 text-[10px]">
                  <option value="password">口令保护</option>
                  <option value="email-allowlist">邮箱白名单</option>
                  <option value="ip-allowlist">IP 白名单</option>
                </select>
                <input
                  value={accessValue}
                  onChange={(e) => setAccessValue(e.target.value)}
                  type={accessType === 'password' ? 'password' : 'text'}
                  placeholder={accessType === 'password' ? '至少 8 位口令' : accessType === 'email-allowlist' ? 'a@b.com, c@d.com' : '10.0.0.0/8, 192.168.1.5'}
                  className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-[10px] outline-none focus:border-brand"
                />
                <Button
                  onClick={() =>
                    guard(async () => {
                      const r = await api.setWebsiteAccess(detail.project.id, [{ type: accessType, value: accessValue }]);
                      setAccessValue('');
                      await loadDetail(detail.project.id);
                      pushToast({ level: 'success', message: `已设置 ${r.count} 条规则（口令只存哈希）` });
                    })
                  }
                  disabled={busy}
                >
                  应用
                </Button>
              </div>
              {detail.access.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-[10px] text-muted">
                  {detail.access.map((r) => (
                    <li key={r.id}>
                      {r.type}：{r.value}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="border-t border-border pt-2">
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  if (!triggerConfirm(`确认删除网站项目「${detail.project.name}」？\n\n会同时删除全部部署记录（${detail.deployments.length} 条）并尽力清理平台侧部署。此操作不可撤销。`)) return;
                  void guard(async () => {
                    const r = await api.deleteWebsite(detail.project.id);
                    setSelected(null);
                    setDetail(null);
                    await loadProjects();
                    pushToast({ level: 'success', message: `项目已删除，清理了 ${r.deployments} 个平台侧部署` });
                  });
                }}
              >
                删除项目
              </Button>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}

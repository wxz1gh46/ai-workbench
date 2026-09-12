import { useEffect, useState } from 'react';
import type { ResearchClaim, ResearchJob, ResearchReport, ResearchSource } from '@ai/shared';
import { Badge, Button, Empty, Panel, Progress } from '@/components/ui';
import { api } from '@/lib/api';
import { triggerConfirm } from '@/lib/confirm';
import { useAppStore } from '@/stores/app-store';
import { truncate } from '@/lib/utils';

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'error' | 'info' | 'default'> = {
  completed: 'ok',
  failed: 'error',
  cancelled: 'default',
  pending: 'default',
  searching: 'info',
  fetching: 'info',
  extracting: 'info',
  validating: 'warn',
  analyzing: 'info',
  writing: 'info',
};

/**
 * 深度研究页（Step 6/7 UI）。
 * 主题输入 → 进度 → 报告预览（引用/图表/冲突）→ 导出 / 发布 / 加入看板。
 */
export function ResearchPage() {
  const { workspace, pushToast } = useAppStore();
  const [topic, setTopic] = useState('');
  const [depth, setDepth] = useState<'quick' | 'standard' | 'deep'>('standard');
  const [allowNetwork, setAllowNetwork] = useState(false);
  const [jobs, setJobs] = useState<ResearchJob[]>([]);
  const [active, setActive] = useState<{ job: ResearchJob; sources: ResearchSource[]; claims: ResearchClaim[]; report: ResearchReport | null } | null>(null);
  const [capability, setCapability] = useState<{ network: boolean; hint: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    if (!workspace) return;
    const [{ jobs: list }, cap] = await Promise.all([api.listResearch(workspace.id), api.researchCapability()]);
    setJobs(list);
    setCapability(cap);
    const current = active?.job.id ?? list.find((j) => j.status !== 'completed' && j.status !== 'failed')?.id ?? list[0]?.id;
    if (current) {
      const detail = await api.getResearch(current);
      setActive(detail);
    }
  }

  useEffect(() => {
    void refresh().catch(() => undefined);
    const timer = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id]);

  async function start() {
    if (!workspace || !topic.trim()) return;
    setBusy(true);
    try {
      const { job } = await api.createResearch({
        workspaceId: workspace.id,
        topic: topic.trim(),
        depth,
        allowNetwork,
        outputFormats: ['markdown', 'pdf', 'pptx'],
      });
      pushToast({ level: 'success', message: `研究任务已创建：${job.topic}（${job.queries.length} 条检索式）` });
      setTopic('');
      await refresh();
    } catch (e) {
      pushToast({ level: 'error', message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (!active) return;
    try {
      const r = await api.publishResearch(active.job.id, false);
      pushToast({ level: 'success', message: `已发布网页：${truncate(r.webUrl, 60)}` });
      await refresh();
    } catch (e) {
      pushToast({ level: 'error', message: (e as Error).message });
    }
  }

  async function addToBoard() {
    if (!active || !workspace) return;
    try {
      await api.createWidget(workspace.id, `研究报告：${active.job.topic}（显示结论与置信度）`);
      pushToast({ level: 'success', message: '已加入看板' });
    } catch (e) {
      pushToast({ level: 'error', message: (e as Error).message });
    }
  }

  return (
    <div className="grid h-full grid-cols-[300px_1fr] gap-3">
      <div className="flex min-h-0 flex-col gap-3">
        <Panel title="新建研究">
          <div className="flex flex-col gap-2">
            <textarea
              className="h-16 resize-none rounded border border-border bg-bg px-2 py-1 text-xs"
              placeholder="研究主题，例如：2025 年储能行业装机量与风险"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
            <div className="flex items-center gap-2 text-[10px] text-muted">
              <span>深度</span>
              {(['quick', 'standard', 'deep'] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setDepth(d)}
                  className={`rounded border px-1.5 py-0.5 ${depth === d ? 'border-brand text-brand' : 'border-border'}`}
                >
                  {d === 'quick' ? '快速' : d === 'standard' ? '标准' : '深入'}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-[10px] text-muted">
              <input type="checkbox" checked={allowNetwork} onChange={(e) => setAllowNetwork(e.target.checked)} />
              允许联网检索（遵守 robots.txt，付费来源需自行授权）
            </label>
            <Button variant="primary" onClick={() => void start()} disabled={busy || !topic.trim()}>
              开始研究
            </Button>
            {capability && (
              <p className={`text-[10px] ${capability.network ? 'text-muted' : 'text-amber-400'}`}>{capability.hint}</p>
            )}
          </div>
        </Panel>

        <Panel title={`研究任务（${jobs.length}）`}>
          {jobs.length === 0 ? (
            <Empty>还没有研究任务</Empty>
          ) : (
            <ul className="space-y-1.5">
              {jobs.map((j) => (
                <li key={j.id}>
                  <button
                    onClick={() => void api.getResearch(j.id).then(setActive)}
                    className={`w-full rounded border px-2 py-1.5 text-left text-[11px] ${
                      active?.job.id === j.id ? 'border-brand/60 bg-brand/10' : 'border-border hover:border-brand/40'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate">{truncate(j.topic, 26)}</span>
                      <Badge tone={STATUS_TONE[j.status] ?? 'default'}>{j.status}</Badge>
                    </div>
                    <div className="mt-1">
                      <Progress value={j.progress} />
                    </div>
                    <div className="mt-0.5 text-[10px] text-muted">
                      来源 {j.sourceCount} · 论断 {j.claimCount}
                      {j.disputedCount > 0 ? ` · ⚠️冲突 ${j.disputedCount}` : ''}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="flex min-h-0 flex-col gap-3">
        {!active ? (
          <Panel title="研究报告">
            <Empty>选择或创建一个研究任务</Empty>
          </Panel>
        ) : (
          <>
            <Panel
              title={active.job.topic}
              actions={
                <div className="flex gap-1">
                  <Badge tone={STATUS_TONE[active.job.status] ?? 'default'}>{active.job.status}</Badge>
                  {active.job.status !== 'completed' && active.job.status !== 'failed' && (
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (triggerConfirm('确认取消该研究任务？')) void api.cancelResearch(active.job.id).then(refresh);
                      }}
                    >
                      取消
                    </Button>
                  )}
                  {active.report && (
                    <>
                      <Button onClick={() => window.open(api.researchExportUrl(active.job.id), '_blank')}>下载 Markdown</Button>
                      <Button
                        onClick={() => {
                          if (triggerConfirm('发布为网页会生成可访问的 HTML 文件，确认继续？')) void publish();
                        }}
                      >
                        发布网页
                      </Button>
                      <Button onClick={() => void addToBoard()}>加入看板</Button>
                    </>
                  )}
                </div>
              }
            >
              <div className="flex flex-col gap-2">
                <div className="text-[10px] text-muted">
                  {active.job.stage || '等待中'}（{active.job.progress}%）
                  {active.job.error && <span className="ml-2 text-rose-400">错误：{active.job.error}</span>}
                </div>
                <Progress value={active.job.progress} />
                <div className="flex flex-wrap gap-2 text-[10px] text-muted">
                  <span>检索式 {active.job.queries.length} 条</span>
                  <span>来源 {active.sources.length}</span>
                  <span>论断 {active.claims.length}</span>
                  <span className="text-amber-400">冲突 {active.claims.filter((c) => c.disputed).length}</span>
                  <span>{active.job.allowNetwork ? '已允许联网' : '仅本地素材'}</span>
                </div>
              </div>
            </Panel>

            <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
              <Panel title="来源与引用">
                {active.sources.length === 0 ? (
                  <Empty>暂无来源</Empty>
                ) : (
                  <ul className="space-y-1.5">
                    {active.sources.map((s) => (
                      <li key={s.id} className="rounded border border-border bg-bg/30 px-2 py-1.5">
                        <div className="flex items-start justify-between gap-2">
                          <span className="text-[11px]">{truncate(s.title || s.url, 46)}</span>
                          <div className="flex shrink-0 gap-1">
                            {s.requiresAuth && <Badge tone="warn">需授权</Badge>}
                            {s.content.startsWith('[未抓取]') && <Badge tone="error">未抓取</Badge>}
                            <Badge tone={s.reliability >= 0.7 ? 'ok' : s.reliability >= 0.4 ? 'info' : 'warn'}>
                              可信度 {(s.reliability * 100).toFixed(0)}%
                            </Badge>
                          </div>
                        </div>
                        <div className="mt-0.5 truncate text-[10px] text-brand/80">{s.url}</div>
                        <div className="mt-0.5 text-[10px] text-muted">访问于 {s.accessedAt.slice(0, 19).replace('T', ' ')}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              <Panel title="论断与冲突">
                {active.claims.length === 0 ? (
                  <Empty>暂无论断</Empty>
                ) : (
                  <ul className="space-y-1.5">
                    {active.claims.map((c) => (
                      <li
                        key={c.id}
                        className={`rounded border px-2 py-1.5 ${c.disputed ? 'border-amber-500/50 bg-amber-500/5' : 'border-border bg-bg/30'}`}
                      >
                        <div className="text-[11px]">{truncate(c.claim, 110)}</div>
                        <div className="mt-0.5 flex flex-wrap gap-2 text-[10px] text-muted">
                          <span>置信度 {(c.confidence * 100).toFixed(0)}%</span>
                          <span>支持 {c.supportingSources.length}</span>
                          {c.disputed && <span className="text-amber-400">⚠️ 冲突来源 {c.conflictingSources.length}</span>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>

            <Panel title="报告预览" className="min-h-[240px]">
              {!active.report ? (
                <Empty>报告尚未生成</Empty>
              ) : (
                <>
                  {active.report.charts.length > 0 && (
                    <div className="mb-2 space-y-1">
                      {active.report.charts.map((c, i) => (
                        <pre key={i} className="max-h-32 overflow-auto rounded border border-border bg-bg/40 p-2 text-[10px] text-muted">
                          {String((c.data as { mermaid?: string }).mermaid ?? '')}
                        </pre>
                      ))}
                    </div>
                  )}
                  <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap text-[11px] leading-relaxed">{active.report.markdown}</pre>
                </>
              )}
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import type { ContextBundle, ContextSummaryResponse, MemoryFactRecord } from '@ai/shared';
import { Badge, Button, Empty, Panel } from '@/components/ui';
import { TokenBudgetBar } from '@/components/TokenBudgetBar';
import { api } from '@/lib/api';
import { useAppStore } from '@/stores/app-store';
import { formatTokens, truncate } from '@/lib/utils';

const FACT_TYPE_LABEL: Record<string, string> = {
  preference: '偏好',
  constraint: '约束',
  decision: '决策',
  fact: '事实',
};

/**
 * 记忆面板（Step 1/7 UI）。
 * 展示：滚动摘要、关键事实（带溯源）、Token 预算、以及一次上下文组装的召回来源。
 */
export function MemoryPanelPage() {
  const { pushToast } = useAppStore();
  const [conversationId, setConversationId] = useState('');
  const [summary, setSummary] = useState<ContextSummaryResponse | null>(null);
  const [preview, setPreview] = useState<ContextBundle | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // 默认取最近一个会话（本地单机模式通常只有一个）
    const stored = localStorage.getItem('ai-workbench:conversationId');
    if (stored) setConversationId(stored);
  }, []);

  async function load(id = conversationId) {
    if (!id.trim()) {
      pushToast({ level: 'warn', message: '请先填写会话 ID（或在对话页发一条消息后回来）' });
      return;
    }
    setBusy(true);
    try {
      localStorage.setItem('ai-workbench:conversationId', id);
      const [s, p] = await Promise.all([api.contextSummary(id), api.contextPreview(id, query || '最近在讨论什么')]);
      setSummary(s);
      setPreview(p);
    } catch (e) {
      pushToast({ level: 'error', message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function compact(force: boolean) {
    if (!summary) return;
    setBusy(true);
    try {
      const workspaceId = useAppStore.getState().workspace?.id ?? '';
      const r = await api.compactContext(summary.conversationId, workspaceId, { force, keepRecent: 12 });
      pushToast({
        level: r.summarizedMessages > 0 ? 'success' : 'info',
        message:
          r.summarizedMessages > 0
            ? `已压缩 ${r.summarizedMessages} 条消息，抽取 ${r.factsExtracted} 条事实，token ${r.tokensBefore} → ${r.tokensAfter}`
            : '当前无需压缩（未超过阈值）',
      });
      await load(summary.conversationId);
    } catch (e) {
      pushToast({ level: 'error', message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full grid-cols-[320px_1fr] gap-3">
      <div className="flex min-h-0 flex-col gap-3">
        <Panel title="会话">
          <div className="flex flex-col gap-2">
            <input
              className="rounded border border-border bg-bg px-2 py-1 text-xs"
              placeholder="会话 ID（conversationId）"
              value={conversationId}
              onChange={(e) => setConversationId(e.target.value)}
            />
            <div className="flex gap-2">
              <Button variant="primary" onClick={() => void load()} disabled={busy}>
                加载记忆
              </Button>
              <Button onClick={() => void compact(false)} disabled={busy || !summary}>
                压缩
              </Button>
              <Button onClick={() => void compact(true)} disabled={busy || !summary} title="强制压缩最近窗口内的消息">
                强制压缩
              </Button>
            </div>
            {summary && (
              <div className="space-y-1 text-[10px] text-muted">
                <div>消息数：{summary.messages}</div>
                <div>未摘要 token：{summary.rawTokens.toLocaleString()}</div>
                <div>压缩阈值：{summary.compactThreshold.toLocaleString()}</div>
                <div className="flex items-center gap-1">
                  压缩建议：{summary.shouldCompact ? <Badge tone="warn">建议压缩</Badge> : <Badge tone="ok">无需压缩</Badge>}
                </div>
              </div>
            )}
          </div>
        </Panel>

        <Panel title="Token 预算">
          {summary ? <TokenBudgetBar budget={summary.budget} /> : <Empty>加载后显示</Empty>}
        </Panel>

        <Panel
          title="上下文组装预览"
          actions={
            <Button
              onClick={() => {
                if (conversationId) void api.contextPreview(conversationId, query).then(setPreview).catch(() => undefined);
              }}
            >
              用该查询组装
            </Button>
          }
        >
          <div className="flex flex-col gap-2">
            <input
              className="rounded border border-border bg-bg px-2 py-1 text-xs"
              placeholder="查询（用于向量召回）"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {!preview ? (
              <Empty>尚未组装</Empty>
            ) : (
              <>
                <div className="text-[10px] text-muted">
                  组装 token {preview.totalTokens.toLocaleString()} · 路由模型 {preview.model}
                  {preview.routedByLength && <Badge tone="warn">已切长上下文</Badge>}
                </div>
                {preview.blocks.map((b, i) => (
                  <div key={i} className="rounded border border-border bg-bg/40 p-2">
                    <div className="flex items-center justify-between text-[10px]">
                      <Badge tone="info">{b.kind}</Badge>
                      <span className="text-muted">
                        {b.tokens} token · {b.sourceIds.length} 来源
                      </span>
                    </div>
                    <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-[10px] text-muted">{truncate(b.content, 400)}</pre>
                    {b.sourceIds.length > 0 && (
                      <div className="mt-1 text-[10px] text-brand/80" title="点击可跳回原始消息（Phase 2 溯源）">
                        溯源：{b.sourceIds.slice(0, 3).join(', ')}
                        {b.sourceIds.length > 3 ? ` 等 ${b.sourceIds.length} 条` : ''}
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        </Panel>
      </div>

      <div className="flex min-h-0 flex-col gap-3">
        <Panel title={`关键事实（${summary?.facts.length ?? 0}）`}>
          {!summary || summary.facts.length === 0 ? (
            <Empty>暂无抽取出的事实（压缩会话后会自动抽取）</Empty>
          ) : (
            <ul className="space-y-1.5">
              {summary.facts.map((f: MemoryFactRecord) => (
                <li key={f.id} className="rounded border border-border bg-bg/30 px-2 py-1.5">
                  <div className="flex items-center gap-2 text-[11px]">
                    <Badge tone={f.factType === 'constraint' ? 'warn' : f.factType === 'decision' ? 'info' : 'default'}>
                      {FACT_TYPE_LABEL[f.factType] ?? f.factType}
                    </Badge>
                    <span className="font-medium">{f.key}</span>
                    <span className="text-muted">重要度 {(f.importance * 100).toFixed(0)}%</span>
                  </div>
                  <div className="mt-0.5 text-[11px]">{f.value}</div>
                  {f.sourceMessageId && <div className="mt-0.5 text-[10px] text-brand/80">溯源：{f.sourceMessageId}</div>}
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={`历史摘要（${summary?.summaries.length ?? 0}）`}>
          {!summary || summary.summaries.length === 0 ? (
            <Empty>暂无摘要</Empty>
          ) : (
            <ul className="space-y-2">
              {summary.summaries.map((s) => (
                <li key={s.id} className="rounded border border-border bg-bg/30 p-2">
                  <div className="flex items-center justify-between text-[10px] text-muted">
                    <span>
                      覆盖 {s.coveredCount} 条消息 · {s.kind === 'manual' ? '手动压缩' : '滚动摘要'} · {formatTokens(s.tokenCount)} token
                    </span>
                    <span>{s.createdAt.slice(0, 19).replace('T', ' ')}</span>
                  </div>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap text-[10px] text-muted">{s.content}</pre>
                  <div className="mt-1 text-[10px] text-brand/80">
                    溯源：{s.fromMessageId} → {s.toMessageId}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}

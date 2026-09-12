import { useState } from 'react';
import type { PromptABTestReport } from '@ai/shared';
import { api } from '@/lib/api';
import { describeError, useAppStore } from '@/stores/app-store';
import { Badge, Button, Empty } from '@/components/ui';

/**
 * A/B 测试面板。
 * 关键设计：报告里**必须**显示「为什么是这个结论」——
 * 样本不足时不能给出确定赢家，否则用户会按噪声做决策。
 */
export function PromptABTest({ report, workspaceId, onChanged }: { report: PromptABTestReport; workspaceId: string; onChanged: () => void }) {
  const pushToast = useAppStore((s) => s.pushToast);
  const [busy, setBusy] = useState(false);

  async function autoEvaluate() {
    setBusy(true);
    try {
      await api.autoEvaluateAb(report.test.id, workspaceId);
      pushToast({ level: 'success', message: '已写入自动指标（结构 / 长度 / 变量覆盖）' });
      onChanged();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function evaluate(version: 'A' | 'B', metric: string, value: number) {
    setBusy(true);
    try {
      await api.recordAbEvaluation(report.test.id, { workspaceId, version, metric, value, sampleSize: 1 });
      pushToast({ level: 'success', message: `已记录 ${version} 的 ${metric}=${value}` });
      onChanged();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true);
    try {
      await api.finishAbTest(report.test.id, workspaceId);
      pushToast({ level: 'success', message: '测试已结束' });
      onChanged();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  const manualMetrics = ['accuracy', 'clarity', 'usefulness'];

  return (
    <div className="space-y-3 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={report.test.status === 'finished' ? 'default' : 'info'}>{report.test.status}</Badge>
        <span className="text-fg">v{report.test.versionA} vs v{report.test.versionB}</span>
        {report.winner ? <Badge tone="ok">建议采用 {report.winner}</Badge> : <Badge tone="warn">暂无定论</Badge>}
        <Button onClick={autoEvaluate} disabled={busy}>跑自动指标</Button>
        {report.test.status !== 'finished' && <Button onClick={finish} disabled={busy}>结束测试</Button>}
      </div>

      <p className="rounded border border-border bg-panel p-2 text-muted">{report.reason}</p>

      {report.summary.length === 0 ? (
        <Empty>还没有任何评分。可先跑自动指标，再补人工评分。</Empty>
      ) : (
        <table className="w-full text-left">
          <thead className="text-muted">
            <tr>
              <th className="py-1 pr-2">版本</th>
              <th className="py-1 pr-2">指标</th>
              <th className="py-1 pr-2">数值</th>
              <th className="py-1 pr-2">样本</th>
              <th className="py-1">综合分</th>
            </tr>
          </thead>
          <tbody>
            {report.summary.map((s) => (
              <tr key={s.version} className="border-t border-border">
                <td className="py-1 pr-2 text-fg">{s.version}</td>
                <td className="py-1 pr-2 text-muted">
                  {Object.entries(s.metrics)
                    .map(([k, v]) => `${k}=${v}`)
                    .join(' · ') || '—'}
                </td>
                <td className="py-1 pr-2 text-muted">{s.score}</td>
                <td className="py-1 pr-2 text-muted">{s.sampleSize}</td>
                <td className="py-1 text-fg">{s.score}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {report.test.status !== 'finished' && (
        <div className="space-y-1">
          <p className="text-muted">人工评分（1~5，越多越可靠）</p>
          {(['A', 'B'] as const).map((version) => (
            <div key={version} className="flex flex-wrap items-center gap-2">
              <span className="w-6 text-fg">{version}</span>
              {manualMetrics.map((metric) => (
                <span key={metric} className="flex items-center gap-1">
                  <span className="text-muted">{metric}</span>
                  {[1, 2, 3, 4, 5].map((v) => (
                    <button
                      key={v}
                      type="button"
                      disabled={busy}
                      className="rounded border border-border px-1.5 hover:border-brand/60"
                      onClick={() => evaluate(version, metric, v)}
                    >
                      {v}
                    </button>
                  ))}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}

      <details className="rounded border border-border bg-panel p-2">
        <summary className="cursor-pointer text-muted">评估明细（{report.evaluations.length} 条）</summary>
        <ul className="mt-1 space-y-0.5 text-muted">
          {report.evaluations.map((e) => (
            <li key={e.id}>
              {e.version} · {e.metric} = {e.value}（n={e.sampleSize}）{e.note ? ` · ${e.note}` : ''}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

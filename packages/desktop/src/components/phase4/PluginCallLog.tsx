import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { describeError } from '@/stores/app-store';
import { Badge, Empty } from '@/components/ui';

/** 插件调用日志（含被拒调用：谁在什么时候试图越权）。入参已在服务端脱敏。 */
export function PluginCallLog({ installationId, workspaceId }: { installationId: string; workspaceId: string }) {
  const [calls, setCalls] = useState<{ id: string; tool: string; args: Record<string, unknown>; ok: boolean; durationMs: number; error: string | null; createdAt: string }[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await api.pluginCalls(installationId, workspaceId, 100);
        setCalls(res.calls);
        setError(null);
      } catch (e) {
        setError(describeError(e));
      }
    })();
  }, [installationId, workspaceId]);

  if (error) return <p className="text-xs text-rose-300">{error}</p>;
  if (calls.length === 0) return <Empty>暂无调用记录。插件被调用（含被拒）后都会出现在这里。</Empty>;

  return (
    <div className="overflow-auto">
      <table className="w-full text-left text-[11px]">
        <thead className="text-muted">
          <tr>
            <th className="py-1 pr-2">时间</th>
            <th className="py-1 pr-2">工具</th>
            <th className="py-1 pr-2">状态</th>
            <th className="py-1 pr-2">耗时</th>
            <th className="py-1">入参（已脱敏）</th>
          </tr>
        </thead>
        <tbody>
          {calls.map((c) => (
            <tr key={c.id} className="border-t border-border">
              <td className="py-1 pr-2 text-muted">{new Date(c.createdAt).toLocaleString()}</td>
              <td className="py-1 pr-2 text-fg">{c.tool}</td>
              <td className="py-1 pr-2">
                <Badge tone={c.ok ? 'ok' : 'error'}>{c.ok ? '成功' : '失败'}</Badge>
                {c.error && <span className="ml-1 text-rose-300">{c.error.slice(0, 60)}</span>}
              </td>
              <td className="py-1 pr-2 text-muted">{c.durationMs}ms</td>
              <td className="py-1 font-mono text-muted">{JSON.stringify(c.args).slice(0, 120)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

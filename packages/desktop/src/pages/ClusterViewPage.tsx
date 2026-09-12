import { useCallback, useEffect, useState } from 'react';
import type { ClusterStatus } from '@ai/shared';
import { api } from '@/lib/api';
import { describeError, useAppStore } from '@/stores/app-store';
import { Badge, Button, Empty, Panel } from '@/components/ui';
import { confirmDanger } from '@/lib/utils';
import { ClusterNodeCard } from '@/components/phase4/ClusterNodeCard';
import { ClusterTaskBoard } from '@/components/phase4/ClusterTaskBoard';
import { ClusterHealthChart } from '@/components/phase4/ClusterHealthChart';

/**
 * 集群视图（Phase 4 Step 7）。
 * 「实验性」定位要写清楚：节点是本机/自有机器，不是托管服务；
 * 降级单机时必须在顶部显著提示，避免用户以为任务跑在集群上。
 */
export function ClusterViewPage() {
  const workspace = useAppStore((s) => s.workspace);
  const pushToast = useAppStore((s) => s.pushToast);
  const [status, setStatus] = useState<ClusterStatus | null>(null);
  const [tasks, setTasks] = useState<{ id: string; taskId: string | null; status: string; assignedNodeId: string | null; error: string | null }[]>([]);
  const [policy, setPolicy] = useState<{ maxNodes: number; maxParallelTasks: number; fallbackEnabled: boolean; heartbeatTimeoutMs: number } | null>(null);
  const [newNode, setNewNode] = useState({ name: '', host: '127.0.0.1', cpu: 4, memoryMb: 8192 });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!workspace) return;
    try {
      const [st, tk, po] = await Promise.all([api.clusterStatus(workspace.id, 'cluster'), api.clusterTasks(workspace.id, 100), api.clusterPolicy(workspace.id)]);
      setStatus(st);
      setTasks(tk.tasks as never);
      setPolicy(po.policy);
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  async function bootstrap() {
    if (!workspace) return;
    setBusy(true);
    try {
      const res = await api.clusterBootstrap(workspace.id);
      pushToast({ level: 'success', message: `本机节点已注册（${res.nodeId.slice(-6)}），term=${res.term}` });
      await load();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function addNode() {
    if (!workspace || !newNode.name.trim()) {
      pushToast({ level: 'warn', message: '请填写节点名' });
      return;
    }
    setBusy(true);
    try {
      await api.registerClusterNode({
        workspaceId: workspace.id,
        name: newNode.name.trim(),
        host: newNode.host,
        resources: { cpu: newNode.cpu, memoryMb: newNode.memoryMb },
      });
      pushToast({ level: 'success', message: '节点已注册（默认 offline，发心跳后变 online）' });
      setNewNode({ name: '', host: '127.0.0.1', cpu: 4, memoryMb: 8192 });
      await load();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function sweep() {
    if (!workspace) return;
    try {
      const res = await api.clusterSweep(workspace.id);
      pushToast({ level: 'info', message: `扫描完成：离线 ${res.offline.length}，在线 ${res.online.length}` });
      await load();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    }
  }

  async function forceElection() {
    if (!workspace) return;
    if (!confirmDanger('强制重新选举', '会短暂中断调度（当前任务不受影响），用于 leader 卡住时恢复。')) return;
    try {
      const res = await api.forceElection(workspace.id);
      pushToast({ level: 'success', message: `选举完成：term ${res.term}，leader ${res.leaderNodeId.slice(-6)}` });
      await load();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    }
  }

  async function updatePolicy(patch: Record<string, number | boolean>) {
    if (!workspace || !policy) return;
    try {
      await api.updateClusterPolicy(workspace.id, patch);
      pushToast({ level: 'success', message: '集群策略已更新' });
      await load();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    }
  }

  async function removeNode(id: string, name: string) {
    if (!workspace) return;
    if (!confirmDanger(`移除节点 ${name}`, '该节点上未完成的分片会被改派到其他节点。')) return;
    try {
      await api.removeClusterNode(id, workspace.id);
      pushToast({ level: 'success', message: '节点已移除' });
      await load();
    } catch (e) {
      pushToast({ level: 'error', message: describeError(e) });
    }
  }

  if (!workspace) return <p className="p-4 text-xs text-muted">正在加载工作区…</p>;

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
      {status?.degraded && (
        <p className="rounded border border-amber-500/50 bg-amber-500/10 p-2 text-xs text-amber-300">
          ⚠️ 当前已降级单机执行：{status.degradeReason}。任务仍然会跑完，但不会分发到集群节点。
        </p>
      )}

      <Panel
        title="集群状态"
        actions={
          <div className="flex items-center gap-1">
            <Button onClick={bootstrap} disabled={busy}>注册本机节点</Button>
            <Button onClick={sweep} disabled={busy}>扫描心跳</Button>
            <Button onClick={forceElection} disabled={busy}>重新选举</Button>
          </div>
        }
      >
        {!status ? (
          <Empty>正在读取集群状态…</Empty>
        ) : (
          <ClusterHealthChart status={status} />
        )}
      </Panel>

      <Panel
        title="节点"
        actions={
          <div className="flex items-center gap-1">
            <input className="w-28 rounded border border-border bg-bg px-2 py-1 text-[11px] text-fg" placeholder="节点名" value={newNode.name} onChange={(e) => setNewNode((s) => ({ ...s, name: e.target.value }))} />
            <input className="w-32 rounded border border-border bg-bg px-2 py-1 text-[11px] text-fg" placeholder="host" value={newNode.host} onChange={(e) => setNewNode((s) => ({ ...s, host: e.target.value }))} />
            <Button onClick={addNode} disabled={busy}>添加节点</Button>
          </div>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(status?.nodes ?? []).map((n) => (
            <ClusterNodeCard
              key={n.id}
              node={n}
              busy={busy}
              onHeartbeat={() => void api.clusterHeartbeat(n.id, { cpu: 10, memory: 20 }).then(load).catch((e) => pushToast({ level: 'error', message: describeError(e) }))}
              onRemove={() => removeNode(n.id, n.name)}
            />
          ))}
          {(status?.nodes ?? []).length === 0 && <Empty>还没有节点。点击「注册本机节点」即可把本机加入集群（单机集群是合法起点）。</Empty>}
        </div>
      </Panel>

      <Panel title="集群任务">
        <ClusterTaskBoard
          tasks={tasks as never}
          onCancel={(id) => void api.cancelClusterTask(id, workspace.id).then(load).catch((e) => pushToast({ level: 'error', message: describeError(e) }))}
        />
      </Panel>

      <Panel title="集群策略">
        {policy && (
          <div className="grid gap-2 text-[11px] sm:grid-cols-2 lg:grid-cols-4">
            <label className="text-muted">
              最大节点数
              <input
                type="number"
                className="mt-0.5 w-full rounded border border-border bg-bg px-2 py-1 text-fg"
                value={policy.maxNodes}
                onChange={(e) => void updatePolicy({ maxNodes: Number(e.target.value) })}
              />
            </label>
            <label className="text-muted">
              最大并行任务
              <input
                type="number"
                className="mt-0.5 w-full rounded border border-border bg-bg px-2 py-1 text-fg"
                value={policy.maxParallelTasks}
                onChange={(e) => void updatePolicy({ maxParallelTasks: Number(e.target.value) })}
              />
            </label>
            <label className="text-muted">
              心跳超时（ms）
              <input
                type="number"
                className="mt-0.5 w-full rounded border border-border bg-bg px-2 py-1 text-fg"
                value={policy.heartbeatTimeoutMs}
                onChange={(e) => void updatePolicy({ heartbeatTimeoutMs: Number(e.target.value) })}
              />
            </label>
            <label className="flex items-center gap-2 text-muted">
              <input type="checkbox" checked={policy.fallbackEnabled} onChange={(e) => void updatePolicy({ fallbackEnabled: e.target.checked })} />
              允许降级单机
              <Badge tone={policy.fallbackEnabled ? 'ok' : 'warn'}>{policy.fallbackEnabled ? '开' : '关'}</Badge>
            </label>
          </div>
        )}
      </Panel>
    </div>
  );
}

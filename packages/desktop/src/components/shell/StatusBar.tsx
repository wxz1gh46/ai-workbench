import { useAppStore } from '@/stores/app-store';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/utils';
import type { TabKey } from '@/nav/nav-config';
import { NAV_BY_KEY } from '@/nav/nav-config';

/**
 * 底部状态栏（桌面应用必备的「一眼看全局」位置）。
 *
 * 这里只放"随时需要确认、但不值得占正文"的信息：
 * 连接状态 / 是否降级 / Agent 数 / 工作区目录 / 当前功能。
 * 所有值都来自已有的 app-store，不新增请求 —— 状态栏不该拖慢启动。
 */
export function StatusBar({ active, onGoSettings }: { active: TabKey; onGoSettings: () => void }) {
  const { workspace, agents, degraded, ready, error } = useAppStore();
  const item = NAV_BY_KEY[active];

  const state = error
    ? { tone: 'error' as const, text: '未连接本地服务' }
    : !ready
      ? { tone: 'warn' as const, text: '连接中…' }
      : degraded
        ? { tone: 'warn' as const, text: '离线兜底模式' }
        : { tone: 'ok' as const, text: '已连接' };

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-panel px-3 text-[10px] text-muted">
      <Badge tone={state.tone}>{state.text}</Badge>
      <span className="truncate">{item ? `${item.group} / ${item.label}` : '—'}</span>
      <span className="ml-auto flex items-center gap-3">
        <span>Agent {agents.length}</span>
        <button
          type="button"
          title={workspace?.rootPath ?? '未设置工作区目录'}
          onClick={onGoSettings}
          className={cn('max-w-[280px] truncate hover:text-fg', !workspace && 'text-amber-400')}
        >
          {workspace?.rootPath ? `工作区：${workspace.rootPath}` : '未设置工作区 → 去设置'}
        </button>
      </span>
    </footer>
  );
}

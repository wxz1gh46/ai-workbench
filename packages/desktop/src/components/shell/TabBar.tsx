import { X } from 'lucide-react';
import { NAV_BY_KEY, type TabKey } from '@/nav/nav-config';
import { cn } from '@/lib/utils';
import { nextActiveAfterClose, openTab } from '@/components/shell/tab-state';

/**
 * 桌面版顶部「打开过的工作区」标签栏。
 *
 * 桌面应用与网页最大的手感差异就在这里：用户会同时开着部署中心 + 定时任务 + 日志，
 * 来回切。单靠侧边栏等于一路返回再一路点进，所以这里维护「已打开列表」。
 *
 * 规则（对齐 VS Code / Chrome）：
 * - 点击侧边栏：已打开则激活，未打开则追加到末尾；
 * - 关闭当前标签：自动激活右邻居，没有右侧则左侧；
 * - 关闭全部后回到兜底功能（不能出现空白工作区）；
 * - 中键点击关闭（浏览器习惯，桌面版用户也吃这一套）。
 */
export function TabBar({
  open,
  active,
  onSelect,
  onClose,
}: {
  open: TabKey[];
  active: TabKey;
  onSelect: (key: TabKey) => void;
  onClose: (key: TabKey) => void;
}) {
  if (open.length === 0) return null;

  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border bg-panel">
      {open.map((key) => {
        const item = NAV_BY_KEY[key];
        if (!item) return null;
        const isActive = key === active;
        return (
          <div
            key={key}
            onAuxClick={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(key);
              }
            }}
            className={cn(
              'group flex items-center gap-1.5 border-r border-border px-3 text-xs',
              isActive ? 'bg-bg text-fg' : 'text-muted hover:bg-bg/60 hover:text-fg',
            )}
          >
            <button type="button" onClick={() => onSelect(key)} className="flex items-center gap-1.5 whitespace-nowrap">
              <item.icon size={12} />
              {item.label}
            </button>
            <button
              type="button"
              title="关闭标签"
              onClick={() => onClose(key)}
              className={cn(
                'rounded p-0.5 hover:bg-panel hover:text-fg',
                isActive ? 'opacity-60' : 'opacity-0 group-hover:opacity-60',
              )}
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

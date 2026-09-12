import { useMemo, useState } from 'react';
import { ChevronDown, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react';
import { NAV_GROUPS, navItemsByGroup, type NavItem, type TabKey } from '@/nav/nav-config';
import { cn } from '@/lib/utils';

/**
 * 桌面版左侧导航（类 VS Code / Cursor）。
 *
 * 设计要点：
 * 1. 分组可折叠，折叠状态存 localStorage —— 桌面用户会反复开关同一组，不该每次重开。
 * 2. 支持两种形态：展开（240px，图标 + 文字 + 说明）与窄栏（56px，仅图标 + tooltip）。
 *    小屏笔记本上窄栏能多出 180px 的正文宽度。
 * 3. 顶部搜索框直接对接命令面板的同一份数据（nav-config），保证入口永远一致。
 */
export function Sidebar({
  active,
  onSelect,
  onOpenPalette,
  collapsed,
  onToggleCollapse,
}: {
  active: TabKey;
  onSelect: (key: TabKey) => void;
  onOpenPalette: () => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem('nav.collapsedGroups') ?? '{}') as Record<string, boolean>;
    } catch {
      return {};
    }
  });

  const groups = useMemo(() => navItemsByGroup(), []);

  function toggleGroup(group: string) {
    setCollapsedGroups((prev) => {
      const next = { ...prev, [group]: !prev[group] };
      try {
        localStorage.setItem('nav.collapsedGroups', JSON.stringify(next));
      } catch {
        /* 隐私模式下 localStorage 可能不可写，忽略即可 */
      }
      return next;
    });
  }

  if (collapsed) {
    return (
      <nav className="flex w-14 shrink-0 flex-col items-center border-r border-border bg-panel py-2">
        <button
          type="button"
          title="展开侧边栏"
          onClick={onToggleCollapse}
          className="mb-2 rounded p-2 text-muted hover:bg-bg hover:text-fg"
        >
          <PanelLeftOpen size={16} />
        </button>
        <button
          type="button"
          title="搜索功能（Ctrl/Cmd+K）"
          onClick={onOpenPalette}
          className="mb-2 rounded p-2 text-muted hover:bg-bg hover:text-fg"
        >
          <Search size={16} />
        </button>
        <ul className="flex-1 space-y-0.5 overflow-auto">
          {groups.flatMap((g) =>
            g.items.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  title={`${item.label} · ${item.summary}`}
                  onClick={() => onSelect(item.key)}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded transition-colors',
                    active === item.key ? 'bg-brand/20 text-brand' : 'text-muted hover:bg-bg hover:text-fg',
                  )}
                >
                  <item.icon size={16} />
                </button>
              </li>
            )),
          )}
        </ul>
      </nav>
    );
  }

  return (
    <nav className="flex w-60 shrink-0 flex-col border-r border-border bg-panel">
      <div className="border-b border-border px-3 py-2.5">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">AI 工作台</div>
          <button
            type="button"
            title="收起侧边栏"
            onClick={onToggleCollapse}
            className="rounded p-0.5 text-muted hover:bg-bg hover:text-fg"
          >
            <PanelLeftClose size={14} />
          </button>
        </div>
        <div className="mt-0.5 text-[10px] text-muted">你定义方向，它完成全过程</div>
        <button
          type="button"
          onClick={onOpenPalette}
          className="mt-2 flex w-full items-center gap-2 rounded border border-border bg-bg px-2 py-1.5 text-[11px] text-muted hover:border-brand/50 hover:text-fg"
        >
          <Search size={12} />
          搜索功能…
          <span className="ml-auto rounded border border-border px-1 text-[9px]">Ctrl K</span>
        </button>
      </div>

      <ul className="min-h-0 flex-1 overflow-auto p-2">
        {groups.map((g) => {
          const isCollapsed = collapsedGroups[g.group] ?? false;
          return (
            <li key={g.group}>
              <button
                type="button"
                onClick={() => toggleGroup(g.group)}
                className="mt-2 mb-1 flex w-full items-center gap-1 px-1 text-[9px] uppercase tracking-wide text-muted/70 hover:text-fg"
              >
                <ChevronDown size={10} className={cn('transition-transform', isCollapsed && '-rotate-90')} />
                {g.group}
                <span className="ml-auto text-[9px] text-muted/50">{g.items.length}</span>
              </button>
              {!isCollapsed && (
                <ul className="space-y-0.5">
                  {g.items.map((item) => (
                    <li key={item.key}>
                      <SidebarLink item={item} active={active === item.key} onSelect={onSelect} />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      <div className="px-3 py-1.5 text-[9px] text-muted/60">共 {NAV_GROUPS.length} 组功能</div>
    </nav>
  );
}

function SidebarLink({
  item,
  active,
  onSelect,
}: {
  item: NavItem;
  active: boolean;
  onSelect: (key: TabKey) => void;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      title={item.summary}
      onClick={() => onSelect(item.key)}
      className={cn(
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors',
        active ? 'bg-brand/15 text-fg' : 'text-muted hover:bg-bg hover:text-fg',
      )}
    >
      <Icon size={14} className="shrink-0" />
      <span className="truncate">{item.label}</span>
    </button>
  );
}

import type { ReactNode } from 'react';
import { NAV_BY_KEY, type TabKey } from '@/nav/nav-config';

/**
 * 每个功能页统一的标题区：功能名 + 一句话说明 + 右侧动作。
 *
 * 之前各页面各写各的标题（有的用 Panel title，有的干脆没有），
 * 用户点进一个陌生页面时不知道"这个功能是干嘛的、当前处于什么状态"。
 * 统一在这里给出 group/功能名/用途，动作按钮放右侧。
 */
export function PageHeader({
  tabKey,
  actions,
  meta,
}: {
  tabKey: TabKey;
  actions?: ReactNode;
  meta?: ReactNode;
}) {
  const item = NAV_BY_KEY[tabKey];
  if (!item) return null;
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-panel px-4 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <item.icon size={16} className="shrink-0 text-brand" />
        <h1 className="text-sm font-medium text-fg">{item.label}</h1>
        <span className="truncate text-[11px] text-muted">{item.summary}</span>
      </div>
      {meta && <div className="flex items-center gap-2 text-[11px] text-muted">{meta}</div>}
      <div className="ml-auto flex items-center gap-1">{actions}</div>
    </header>
  );
}

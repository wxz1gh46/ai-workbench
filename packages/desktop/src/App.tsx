import { useEffect } from 'react';
import { useAppStore } from '@/stores/app-store';
import { Toasts } from '@/components/Toasts';
import { Sidebar } from '@/components/shell/Sidebar';
import { TabBar } from '@/components/shell/TabBar';
import { CommandPalette } from '@/components/shell/CommandPalette';
import { StatusBar } from '@/components/shell/StatusBar';
import { PageHeader } from '@/components/shell/PageHeader';
import { useShell } from '@/components/shell/use-shell';
import { NAV_BY_KEY } from '@/nav/nav-config';
import { PAGES } from '@/pages/registry';

/**
 * 桌面版壳层：侧边栏 + 多标签工作区 + 命令面板 + 底部状态栏。
 *
 * 分层：
 *   nav-config    → 功能清单（唯一数据源）
 *   pages/registry→ 功能到页面的映射（类型安全，缺一个就编译不过）
 *   use-shell     → 标签/侧边栏/快捷键等纯 UI 状态（含 localStorage 持久化）
 *   App           → 只负责组装
 */
export default function App() {
  const { ready, error, init } = useAppStore();
  const shell = useShell();

  useEffect(() => {
    void init();
  }, [init]);

  if (!ready) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-xs text-muted">
        <div className="h-1 w-40 overflow-hidden rounded-full bg-panel">
          <div className="h-full w-1/2 animate-pulse rounded-full bg-brand" />
        </div>
        正在连接本地服务…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-rose-400">无法连接本地服务</p>
        <p className="max-w-md text-xs text-muted">{error}</p>
        <pre className="rounded border border-border bg-panel px-3 py-2 text-[11px] text-muted">pnpm dev:server</pre>
        <button
          type="button"
          onClick={() => void init()}
          className="rounded border border-brand bg-brand/20 px-3 py-1 text-xs hover:bg-brand/30"
        >
          重试连接
        </button>
      </div>
    );
  }

  const ActivePage = PAGES[shell.active] ?? PAGES.deploy;
  const activeItem = NAV_BY_KEY[shell.active];

  return (
    <div className="flex h-full">
      <Sidebar
        active={shell.active}
        onSelect={shell.go}
        onOpenPalette={() => shell.setPaletteOpen(true)}
        collapsed={shell.sidebarCollapsed}
        onToggleCollapse={shell.toggleSidebar}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <TabBar open={shell.open} active={shell.active} onSelect={shell.go} onClose={shell.close} />
        {activeItem && <PageHeader tabKey={shell.active} />}
        <main className="min-h-0 flex-1 overflow-hidden p-3">
          <ActivePage />
        </main>
        <StatusBar active={shell.active} onGoSettings={() => shell.go('settings')} />
      </div>

      <CommandPalette
        open={shell.paletteOpen}
        recent={shell.recent}
        onClose={() => shell.setPaletteOpen(false)}
        onSelect={shell.go}
      />
      <Toasts />
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Activity, Boxes, CalendarClock, FileText, LayoutDashboard, MessageSquare, Puzzle, Settings, Terminal, Target } from 'lucide-react';
import { useAppStore } from '@/stores/app-store';
import { Toasts } from '@/components/Toasts';
import { Badge } from '@/components/ui';
import { cn } from '@/lib/utils';
import { ChatPage } from '@/pages/ChatPage';
import { GoalPage } from '@/pages/GoalPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { FilesPage } from '@/pages/FilesPage';
import { SchedulePage } from '@/pages/SchedulePage';
import { PluginsPage } from '@/pages/PluginsPage';
import { PromptPage } from '@/pages/PromptPage';
import { ClusterPage } from '@/pages/ClusterPage';
import { SettingsPage } from '@/pages/SettingsPage';

type TabKey = 'goal' | 'chat' | 'dashboard' | 'files' | 'schedule' | 'plugins' | 'prompt' | 'cluster' | 'settings';

const TABS: { key: TabKey; label: string; icon: typeof Target }[] = [
  { key: 'goal', label: '目标模式', icon: Target },
  { key: 'chat', label: '对话', icon: MessageSquare },
  { key: 'dashboard', label: '看板', icon: LayoutDashboard },
  { key: 'files', label: '文件', icon: FileText },
  { key: 'schedule', label: '定时任务', icon: CalendarClock },
  { key: 'plugins', label: '插件', icon: Puzzle },
  { key: 'prompt', label: '提示词', icon: Terminal },
  { key: 'cluster', label: '集群', icon: Boxes },
  { key: 'settings', label: '设置', icon: Settings },
];

export default function App() {
  const { ready, error, init, agents, workspace, degraded } = useAppStore();
  const [tab, setTab] = useState<TabKey>('goal');

  useEffect(() => {
    void init();
  }, [init]);

  if (!ready) {
    return <div className="flex h-full items-center justify-center text-sm text-muted">正在连接本地服务…</div>;
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-rose-400">无法连接本地服务</p>
        <p className="max-w-md text-xs text-muted">{error}</p>
        <pre className="rounded border border-border bg-panel px-3 py-2 text-[11px] text-muted">pnpm dev:server</pre>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <nav className="flex w-44 flex-col border-r border-border bg-panel">
        <div className="border-b border-border px-3 py-3">
          <div className="text-sm font-semibold">AI 工作台</div>
          <div className="mt-0.5 text-[10px] text-muted">你定义方向，它完成全过程</div>
        </div>
        <ul className="flex-1 overflow-auto p-2">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <li key={t.key}>
                <button
                  onClick={() => setTab(t.key)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors',
                    tab === t.key ? 'bg-brand/15 text-fg' : 'text-muted hover:bg-bg hover:text-fg',
                  )}
                >
                  <Icon size={14} />
                  {t.label}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="border-t border-border p-2 text-[10px] text-muted">
          <div className="flex items-center justify-between">
            <span>Agent</span>
            <span>{agents.length}</span>
          </div>
          <div className="mt-1 flex items-center gap-1">
            {degraded ? <Badge tone="warn">离线模式</Badge> : <Badge tone="ok">模型已接入</Badge>}
          </div>
          <div className="mt-1 truncate" title={workspace?.rootPath ?? '未设置'}>
            目录：{workspace?.rootPath ?? '未设置'}
          </div>
        </div>
      </nav>

      <main className="min-h-0 flex-1 overflow-hidden p-3">
        {tab === 'goal' && <GoalPage />}
        {tab === 'chat' && <ChatPage />}
        {tab === 'dashboard' && <DashboardPage />}
        {tab === 'files' && <FilesPage />}
        {tab === 'schedule' && <SchedulePage />}
        {tab === 'plugins' && <PluginsPage />}
        {tab === 'prompt' && <PromptPage />}
        {tab === 'cluster' && <ClusterPage />}
        {tab === 'settings' && <SettingsPage />}
      </main>

      <Toasts />
      <span className="hidden">
        <Activity size={0} />
      </span>
    </div>
  );
}

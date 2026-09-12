import { useEffect, useState } from 'react';
import {
  Activity,
  Boxes,
  Brain,
  CalendarClock,
  Cloud,
  Database,
  BellRing,
  FileSpreadsheet,
  FileText,
  LayoutDashboard,
  MessageSquare,
  Microscope,
  Puzzle,
  Settings,
  Terminal,
  Target,
  Shield,
} from 'lucide-react';
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
import { AgentClusterPage } from '@/pages/AgentClusterPage';
import { SettingsPage } from '@/pages/SettingsPage';
import { MemoryPanelPage } from '@/pages/MemoryPanelPage';
import { OfficeWorkspacePage } from '@/pages/OfficeWorkspacePage';
import { ResearchPage } from '@/pages/ResearchPage';
import { DeployCenterPage } from '@/pages/DeployCenterPage';
import { DatabasePanelPage } from '@/pages/DatabasePanelPage';
import { DashboardEditorPage } from '@/pages/DashboardEditorPage';
import { ScheduleManagerPage } from '@/pages/ScheduleManagerPage';
import { NotificationSettingsPage } from '@/pages/NotificationSettingsPage';
import { PluginMarketPage } from '@/pages/PluginMarketPage';
import { PaidDataPanelPage } from '@/pages/PaidDataPanelPage';
import { PromptWorkbenchPage } from '@/pages/PromptWorkbenchPage';
import { ClusterViewPage } from '@/pages/ClusterViewPage';
import { SecurityCenterPage } from '@/pages/SecurityCenterPage';

type TabKey =
  | 'pluginMarket'
  | 'paidData'
  | 'promptWorkbench'
  | 'clusterView'
  | 'securityCenter'
  | 'deploy'
  | 'database'
  | 'boardEditor'
  | 'schedules'
  | 'notify'
  | 'goal'
  | 'chat'
  | 'cluster'
  | 'office'
  | 'research'
  | 'memory'
  | 'dashboard'
  | 'files'
  | 'schedule'
  | 'plugins'
  | 'prompt'
  | 'settings';

const TABS: { key: TabKey; label: string; icon: typeof Target; group?: string }[] = [
  { key: 'pluginMarket', label: '插件市场', icon: Puzzle, group: 'Phase 4' },
  { key: 'paidData', label: '付费数据库', icon: Database, group: 'Phase 4' },
  { key: 'promptWorkbench', label: '提示词工作台', icon: Terminal, group: 'Phase 4' },
  { key: 'clusterView', label: '集群视图', icon: Boxes, group: 'Phase 4' },
  { key: 'securityCenter', label: '安全中心', icon: Shield, group: 'Phase 4' },
  { key: 'deploy', label: '部署中心', icon: Cloud, group: 'Phase 3' },
  { key: 'database', label: '数据库面板', icon: Database, group: 'Phase 3' },
  { key: 'boardEditor', label: '看板编辑器', icon: LayoutDashboard, group: 'Phase 3' },
  { key: 'schedules', label: '定时任务', icon: CalendarClock, group: 'Phase 3' },
  { key: 'notify', label: '通知设置', icon: BellRing, group: 'Phase 3' },
  { key: 'goal', label: '目标模式', icon: Target, group: 'Phase 2' },
  { key: 'cluster', label: 'Agent 集群', icon: Boxes, group: 'Phase 2' },
  { key: 'office', label: 'Office 工作区', icon: FileSpreadsheet, group: 'Phase 2' },
  { key: 'research', label: '深度研究', icon: Microscope, group: 'Phase 2' },
  { key: 'memory', label: '记忆面板', icon: Brain, group: 'Phase 2' },
  { key: 'chat', label: '对话', icon: MessageSquare },
  { key: 'dashboard', label: '看板（简版）', icon: LayoutDashboard },
  { key: 'files', label: '文件', icon: FileText },
  { key: 'schedule', label: '定时任务（简版）', icon: CalendarClock },
  { key: 'plugins', label: '插件', icon: Puzzle },
  { key: 'prompt', label: '提示词', icon: Terminal },
  { key: 'settings', label: '设置', icon: Settings },
];

export default function App() {
  const { ready, error, init, agents, workspace, degraded } = useAppStore();
  const [tab, setTab] = useState<TabKey>('deploy');

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
          {TABS.map((t, idx) => {
            const Icon = t.icon;
            const showGroup = t.group && (idx === 0 || TABS[idx - 1]?.group !== t.group);
            return (
              <li key={t.key}>
                {showGroup && <div className="mb-1 mt-2 px-2 text-[9px] uppercase tracking-wide text-muted/70">{t.group}</div>}
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
        {tab === 'pluginMarket' && <PluginMarketPage />}
        {tab === 'paidData' && <PaidDataPanelPage />}
        {tab === 'promptWorkbench' && <PromptWorkbenchPage />}
        {tab === 'clusterView' && <ClusterViewPage />}
        {tab === 'securityCenter' && <SecurityCenterPage />}
        {tab === 'deploy' && <DeployCenterPage />}
        {tab === 'database' && <DatabasePanelPage />}
        {tab === 'boardEditor' && <DashboardEditorPage />}
        {tab === 'schedules' && <ScheduleManagerPage />}
        {tab === 'notify' && <NotificationSettingsPage />}
        {tab === 'goal' && <GoalPage />}
        {tab === 'cluster' && <AgentClusterPage />}
        {tab === 'office' && <OfficeWorkspacePage />}
        {tab === 'research' && <ResearchPage />}
        {tab === 'memory' && <MemoryPanelPage />}
        {tab === 'chat' && <ChatPage />}
        {tab === 'dashboard' && <DashboardPage />}
        {tab === 'files' && <FilesPage />}
        {tab === 'schedule' && <SchedulePage />}
        {tab === 'plugins' && <PluginsPage />}
        {tab === 'prompt' && <PromptPage />}
        {tab === 'settings' && <SettingsPage />}
      </main>

      <Toasts />
      <span className="hidden">
        <Activity size={0} />
      </span>
    </div>
  );
}

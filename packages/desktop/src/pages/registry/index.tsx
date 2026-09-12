import type { ComponentType } from 'react';
import type { TabKey } from '@/nav/nav-config';
import { ChatPage } from '@/pages/ChatPage';
import { GoalPage } from '@/pages/GoalPage';
import { DashboardEditorPage } from '@/pages/DashboardEditorPage';
import { FilesPage } from '@/pages/FilesPage';
import { OfficeWorkspacePage } from '@/pages/OfficeWorkspacePage';
import { ResearchPage } from '@/pages/ResearchPage';
import { MemoryPanelPage } from '@/pages/MemoryPanelPage';
import { AgentClusterPage } from '@/pages/AgentClusterPage';
import { ClusterViewPage } from '@/pages/ClusterViewPage';
import { PromptWorkbenchPage } from '@/pages/PromptWorkbenchPage';
import { DeployCenterPage } from '@/pages/DeployCenterPage';
import { DatabasePanelPage } from '@/pages/DatabasePanelPage';
import { PaidDataPanelPage } from '@/pages/PaidDataPanelPage';
import { ScheduleManagerPage } from '@/pages/ScheduleManagerPage';
import { NotificationSettingsPage } from '@/pages/NotificationSettingsPage';
import { PluginMarketPage } from '@/pages/PluginMarketPage';
import { SecurityCenterPage } from '@/pages/SecurityCenterPage';
import { SettingsPage } from '@/pages/SettingsPage';

/**
 * 功能 → 页面的注册表，与 nav-config 一一对应。
 *
 * 这里刻意用「显式 Record<TabKey, ComponentType>」而不是 if/else 链：
 * 少写一个页面 TS 会直接报错，不会出现"侧边栏有这个入口但点了空白"的情况。
 * 被取代的旧简版页面（DashboardPage/SchedulePage/PluginsPage/PromptPage）
 * 已从导航移除，文件保留，其中可复用逻辑由 Phase 3/4 的正式页面承担。
 */
export const PAGES: Record<TabKey, ComponentType> = {
  chat: ChatPage,
  goal: GoalPage,
  boardEditor: DashboardEditorPage,
  files: FilesPage,
  office: OfficeWorkspacePage,
  research: ResearchPage,
  memory: MemoryPanelPage,
  cluster: AgentClusterPage,
  clusterView: ClusterViewPage,
  promptWorkbench: PromptWorkbenchPage,
  deploy: DeployCenterPage,
  database: DatabasePanelPage,
  paidData: PaidDataPanelPage,
  schedules: ScheduleManagerPage,
  notify: NotificationSettingsPage,
  pluginMarket: PluginMarketPage,
  securityCenter: SecurityCenterPage,
  settings: SettingsPage,
};

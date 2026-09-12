import type { Id, IsoDateTime } from './ids.ts';

/* ================================================================== */
/* Step 1：网站生成                                                    */
/* ================================================================== */

export type WebsiteType = 'static' | 'fullstack' | 'fullstack-db';
export type WebsiteFramework = 'vanilla-html' | 'vite-react' | 'next' | 'astro' | 'node-http';
export type WebsiteProjectStatus = 'draft' | 'generated' | 'built' | 'deployed' | 'failed' | 'deleted';

export interface WebsitePlanPage {
  path: string;
  title: string;
  sections: string[];
  requiresAuth: boolean;
}

export interface WebsitePlanEntity {
  name: string;
  columns: { name: string; type: string; nullable: boolean; primary?: boolean }[];
  relations?: { to: string; type: 'one-to-many' | 'many-to-one' }[];
}

export interface WebsitePlanApi {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  description: string;
  entity?: string;
  requiresDb: boolean;
}

export interface WebsitePlan {
  summary: string;
  pages: WebsitePlanPage[];
  entities: WebsitePlanEntity[];
  apis: WebsitePlanApi[];
  styling: { tone: string; palette: string[]; darkMode: boolean };
  accessControl: { type: 'public' | 'password' | 'email-allowlist'; note: string };
  siteType: WebsiteType;
  framework: WebsiteFramework;
  needsDatabase: boolean;
  degraded?: boolean;
}

export interface WebsiteProject {
  id: Id;
  workspaceId: Id;
  name: string;
  description: string;
  type: WebsiteType;
  framework: WebsiteFramework;
  status: WebsiteProjectStatus;
  requirement: string;
  plan: WebsitePlan | Record<string, unknown>;
  rootDir: string | null;
  entryFile: string | null;
  previewUrl: string | null;
  databaseConnectionId: Id | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface WebsiteBuild {
  id: Id;
  websiteProjectId: Id;
  version: number;
  files: { path: string; bytes: number }[];
  buildLog: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  trigger: string;
  error: string | null;
  createdAt: IsoDateTime;
}

/* ================================================================== */
/* Step 3：部署                                                        */
/* ================================================================== */

export type DeployProvider = 'vercel' | 'cloudflare-pages' | 'netlify' | 'local-preview';
export type DeploymentStatus = 'queued' | 'building' | 'uploaded' | 'deployed' | 'failed' | 'rolled-back' | 'deleted';

export interface ProviderCapability {
  provider: DeployProvider;
  label: string;
  supportsEnvVars: boolean;
  supportsCustomDomain: boolean;
  supportsRollback: boolean;
  supportsPasswordProtection: boolean;
  /** 需要的环境变量名（UI 上提示用户手动配置） */
  tokenEnvKeys: string[];
  docsUrl: string;
  requiresToken: boolean;
}

export interface WebsiteDeployment {
  id: Id;
  websiteProjectId: Id;
  provider: DeployProvider;
  deploymentId: string | null;
  url: string | null;
  customDomain: string | null;
  envVars: { key: string; secretRef: string }[];
  status: DeploymentStatus;
  log: string;
  buildId: Id | null;
  rollbackOf: Id | null;
  error: string | null;
  deployedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface WebsiteAccessRule {
  id: Id;
  websiteProjectId: Id;
  type: 'password' | 'email-allowlist' | 'ip-allowlist';
  value: string;
  hash: string | null;
  createdAt: IsoDateTime;
}

/* ================================================================== */
/* Step 2：数据库                                                      */
/* ================================================================== */

export type DatabaseProvider = 'neon' | 'supabase' | 'postgres' | 'sqlite';
export type DatabaseConnectionStatus = 'unconfigured' | 'ok' | 'error' | 'migrating';

export interface DatabaseConnectionInfo {
  id: Id;
  workspaceId: Id;
  provider: DatabaseProvider;
  name: string;
  status: DatabaseConnectionStatus;
  /** 脱敏后的标识，绝不返回明文连接串 */
  target: string;
  schemaVersion: number;
  lastTestedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  /** 是否有可用凭据（环境变量或加密配置） */
  configured: boolean;
}

export interface DatabaseSchemaTable {
  name: string;
  columns: { name: string; type: string; nullable: boolean; default?: string | null; primary?: boolean }[];
  indexes?: string[];
  rls?: boolean;
}

export interface DatabaseSchemaSnapshot {
  tables: DatabaseSchemaTable[];
  generatedFrom: 'requirement' | 'introspect' | 'manual';
  note?: string;
}

export interface DatabaseMigration {
  id: Id;
  databaseConnectionId: Id;
  name: string;
  sql: string;
  downSql: string;
  status: 'pending' | 'applied' | 'failed' | 'rolled-back';
  appliedAt: IsoDateTime | null;
  error: string | null;
  createdAt: IsoDateTime;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  ms: number;
  readOnly: boolean;
}

/* ================================================================== */
/* Step 4：看板                                                        */
/* ================================================================== */

export type WidgetKind =
  | 'task-progress'
  | 'agent-status'
  | 'file-list'
  | 'website-status'
  | 'schedule-status'
  | 'data-query'
  | 'prompt-template';

export interface WidgetLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Dashboard {
  id: Id;
  workspaceId: Id;
  name: string;
  description: string;
  layoutJson: Record<string, unknown>;
  /** 布局快照历史（最近 20 个），用于布局回滚 */
  layoutHistory: { at: IsoDateTime; layout: Record<string, WidgetLayout> }[];
  isDefault: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface WidgetSpec {
  type: WidgetKind;
  label: string;
  description: string;
  naturalLanguageExamples: string[];
  defaultSize: { w: number; h: number };
  dataSource: 'local-db' | 'agent-runtime' | 'deployment-status' | 'schedule-status' | 'custom-http';
  configSchema: { key: string; type: 'string' | 'number' | 'boolean' | 'select'; label: string; options?: string[]; required?: boolean }[];
}

export interface WidgetInstance {
  id: Id;
  workspaceId: Id;
  dashboardId: string;
  type: WidgetKind;
  title: string;
  naturalLanguage: string | null;
  layout: WidgetLayout;
  config: Record<string, unknown>;
  pinnedToDesktop: boolean;
  refreshIntervalMs: number;
  position: number;
  size: 'sm' | 'md' | 'lg';
  dataSource: string;
  enabled: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface WidgetRenderData {
  widgetId: Id;
  type: WidgetKind;
  refreshedAt: IsoDateTime;
  degraded: boolean;
  payload: unknown;
  error?: string;
}

/* ================================================================== */
/* Step 5：定时任务                                                    */
/* ================================================================== */

export type ScheduleTaskType = 'goal' | 'research' | 'office' | 'deploy' | 'db-query' | 'custom';

export interface RetryPolicy {
  maxRetry: number;
  baseDelayMs: number;
  factor: number;
  maxDelayMs: number;
}

export interface ScheduleTask {
  id: Id;
  workspaceId: Id;
  name: string;
  trigger: 'cron' | 'interval' | 'once';
  expression: string;
  timezone: string;
  taskType: ScheduleTaskType;
  taskConfig: Record<string, unknown>;
  template: string | null;
  enabled: boolean;
  nextRunAt: IsoDateTime | null;
  lastRunAt: IsoDateTime | null;
  retryPolicy: RetryPolicy;
  channelIds: Id[];
  concurrency: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface ScheduleRunRecord {
  id: Id;
  scheduleId: Id;
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  attempt: number;
  retryCount: number;
  log: string;
  result: Record<string, unknown> | null;
  error: string | null;
  trigger: 'auto' | 'manual';
  startedAt: IsoDateTime;
  finishedAt: IsoDateTime | null;
}

/* ================================================================== */
/* Step 6：通知                                                        */
/* ================================================================== */

export type NotifyChannelType = 'desktop' | 'email' | 'webhook' | 'feishu' | 'dingtalk' | 'wecom';

export interface NotifyChannel {
  id: Id;
  workspaceId: Id;
  type: NotifyChannelType;
  name: string;
  /** 非敏感配置 */
  config: Record<string, unknown>;
  enabled: boolean;
  /** 是否已配置凭据（凭据本身永不返回） */
  configured: boolean;
  lastTestedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface NotifyLogRecord {
  id: Id;
  channelId: Id;
  scheduleRunId: Id | null;
  event: string;
  title: string;
  content: string;
  status: 'pending' | 'sent' | 'failed';
  attempt: number;
  sentAt: IsoDateTime | null;
  error: string | null;
  createdAt: IsoDateTime;
}

export type NotifyEvent = 'schedule' | 'goal' | 'deploy' | 'error' | 'test' | 'manual';

export interface NotifyMessage {
  event: NotifyEvent;
  title: string;
  content: string;
  url?: string;
  level?: 'info' | 'success' | 'warning' | 'error';
}

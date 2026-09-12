-- 回滚 Phase 3（Step 6 → Step 1 逆序删）
-- 只删除 0003 新增的表；新增列由 migrate.ts 的「列存在性检查」兼容，
-- 老版本 SQLite 无 DROP COLUMN，列保留但无数据依赖，不影响 Phase 1/2 运行。
DROP TABLE IF EXISTS schedule_audits;
DROP TABLE IF EXISTS db_audits;
DROP TABLE IF EXISTS deploy_audits;
DROP TABLE IF EXISTS notify_logs;
DROP TABLE IF EXISTS notify_channels;
DROP TABLE IF EXISTS widget_data_sources;
DROP TABLE IF EXISTS dashboards;
DROP TABLE IF EXISTS database_migrations;
DROP TABLE IF EXISTS database_schemas;
DROP TABLE IF EXISTS website_access_rules;
DROP TABLE IF EXISTS website_deployments;
DROP TABLE IF EXISTS website_builds;
DROP TABLE IF EXISTS website_projects;

DROP INDEX IF EXISTS website_projects_ws_idx;
DROP INDEX IF EXISTS website_builds_project_idx;
DROP INDEX IF EXISTS website_deployments_project_idx;
DROP INDEX IF EXISTS website_access_rules_project_idx;
DROP INDEX IF EXISTS database_schemas_conn_idx;
DROP INDEX IF EXISTS database_migrations_conn_idx;
DROP INDEX IF EXISTS dashboards_ws_idx;
DROP INDEX IF EXISTS widget_data_sources_widget_idx;
DROP INDEX IF EXISTS notify_channels_ws_idx;
DROP INDEX IF EXISTS notify_logs_channel_idx;
DROP INDEX IF EXISTS deploy_audits_ws_idx;
DROP INDEX IF EXISTS db_audits_ws_idx;
DROP INDEX IF EXISTS schedule_audits_ws_idx;

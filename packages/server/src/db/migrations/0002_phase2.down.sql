-- 回滚 Phase 2（Step 6 → Step 1 逆序删）
DROP TABLE IF EXISTS research_reports;
DROP TABLE IF EXISTS research_claims;
DROP TABLE IF EXISTS research_sources;
DROP TABLE IF EXISTS research_jobs;
DROP TABLE IF EXISTS file_exports;
DROP TABLE IF EXISTS office_previews;
DROP TABLE IF EXISTS office_documents;
DROP TABLE IF EXISTS cluster_configs;
DROP TABLE IF EXISTS goal_audits;
DROP TABLE IF EXISTS goal_runs;

-- SQLite 不支持 DROP COLUMN（3.35+ 支持），此处按版本尽力回滚；
-- 若数据库版本不支持，列保留但无数据依赖，不影响 Phase 1 运行。
DROP INDEX IF EXISTS agent_messages_thread_idx;
DROP INDEX IF EXISTS facts_conv_type_idx;

/**
 * 测试环境预置（必须在 `../config.ts` 之前被 import）。
 *
 * 做三件事：
 * 1) 指向临时目录的独立 SQLite，绝不污染开发数据；
 * 2) 把上下文预算调小，让滚动摘要阈值在少量消息下即可稳定触发；
 * 3) 清空外部服务配置（检索端点 / LibreOffice），保证测试走确定性降级路径。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(tmpdir(), 'ai-ctx-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.STORAGE_DIR = path.join(tmp, 'data', 'storage');
process.env.DB_FILE = path.join(tmp, 'data', 'ctx.db');
process.env.AI_CONTEXT_BUDGET = '12000';
process.env.AI_COMPACT_THRESHOLD = '0';
process.env.RESEARCH_SEARCH_ENDPOINT = '';
process.env.SOFFICE_PATH = '';

export const TEST_TMP_DIR = tmp;

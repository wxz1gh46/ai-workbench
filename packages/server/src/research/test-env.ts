/** 研究测试环境预置（必须在 ../config.ts 之前 import） */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(tmpdir(), 'ai-research-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.STORAGE_DIR = path.join(tmp, 'data', 'storage');
process.env.DB_FILE = path.join(tmp, 'data', 'research.db');
process.env.SOFFICE_PATH = '';
// 默认不联网；测试内会临时注入本地检索端点
process.env.RESEARCH_SEARCH_ENDPOINT = '';

export const RESEARCH_TEST_TMP = tmp;

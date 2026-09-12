/**
 * 目标引擎测试环境预置（必须在 ../config.ts 之前 import）。
 * 独立临时 SQLite，避免污染开发数据。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(tmpdir(), 'ai-goals-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.STORAGE_DIR = path.join(tmp, 'data', 'storage');
process.env.DB_FILE = path.join(tmp, 'data', 'goals.db');
process.env.SOFFICE_PATH = '';

export const GOALS_TEST_TMP = tmp;

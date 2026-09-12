/** Office 测试环境预置（必须在 ../config.ts 之前 import） */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(tmpdir(), 'ai-office-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.STORAGE_DIR = path.join(tmp, 'data', 'storage');
process.env.DB_FILE = path.join(tmp, 'data', 'office.db');
process.env.SOFFICE_PATH = '';

export const OFFICE_TEST_TMP = tmp;

import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const load = await import(pathToFileURL(path.resolve(import.meta.dirname, './client.ts')).href);
const { newId, nowIso } = await import(pathToFileURL(path.resolve(import.meta.dirname, '../utils/ids.ts')).href);
await load.getSqlite().exec('CREATE TABLE IF NOT EXISTS c (id TEXT PRIMARY KEY, t TEXT NOT NULL)');
after(() => load.closeDb());
const db = load.getDb();
const { ContextManager } = await import(pathToFileURL(path.resolve(import.meta.dirname, '../context/contextManager.ts')).href);
console.log('cm constructed');
const cm = new ContextManager(db);
console.log('after construct');
test('later defined test', async () => {
  console.log('inside test');
});

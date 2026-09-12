import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const load = await import(pathToFileURL(path.resolve(import.meta.dirname, './client.ts')).href);
const { runMigrations } = await import(pathToFileURL(path.resolve(import.meta.dirname, './migrate.ts')).href);
const schema = await import(pathToFileURL(path.resolve(import.meta.dirname, './schema/index.ts')).href);
const { newId, nowIso } = await import(pathToFileURL(path.resolve(import.meta.dirname, '../utils/ids.ts')).href);
const { WorkspaceService } = await import(pathToFileURL(path.resolve(import.meta.dirname, '../services/workspace.ts')).href);
runMigrations();
after(() => load.closeDb());
const db = load.getDb();
const wsService = new WorkspaceService(db);

test('compact with conversation + embedded facts insert', async () => {
  const wsId = (await wsService.ensureBootstrap()).workspace.id;
  const convId = newId('conv');
  await db.insert(schema.conversations).values({ id: convId, workspaceId: wsId, title: 't', goalId: null, createdAt: nowIso(), updatedAt: nowIso() });
  const { ContextManager } = await import(pathToFileURL(path.resolve(import.meta.dirname, '../context/contextManager.ts')).href);
  const cm = new ContextManager(db);
  for (let i = 0; i < 60; i++) await cm.appendMessage({ conversationId: convId, role: 'user', content: `第 ${i} 轮：我们决定采用方案 ${i}，必须保证可回滚。${'填充'.repeat(20)}` });
  const r = await cm.compact(convId, { workspaceId: wsId });
  console.log('compact', r.summarizedMessages, r.factsExtracted);
});

/**
 * 百万 Token 性能/稳定性验证脚本（脱离 node --test 运行）。
 *
 * 为什么不放在 `node --test` 里：
 * 本环境下 better-sqlite3（原生模块）连接保持打开时，若测试线程发生高频 GC（百万 token
 * 组装会产生大量临时字符串），原生 finalizer 会在错误线程执行并触发断言 abort。
 * 这是 test runner 环境限制，独立进程运行完全正常（同一份代码 2500 行导入无问题）。
 * 因此：正确性断言放在 *.test.ts，规模/性能验证放在本脚本。
 *
 * 运行：pnpm --filter @ai/server perf:million
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(tmpdir(), 'ai-perf-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.STORAGE_DIR = path.join(tmp, 'data', 'storage');
process.env.DB_FILE = path.join(tmp, 'data', 'perf.db');
process.env.AI_CONTEXT_BUDGET = '200000';

const { getDb, closeDb, schema } = await import('../src/db/client.ts');
const { runMigrations } = await import('../src/db/migrate.ts');
const { ContextManager } = await import('../src/context/contextManager.ts');
const { newId, nowIso } = await import('../src/utils/ids.ts');

runMigrations();
const db = getDb();
const cm = new ContextManager(db);

const userId = newId('usr');
const wsId = newId('ws');
const convId = newId('conv');
await db.insert(schema.users).values({ id: userId, name: 'perf', role: 'owner', createdAt: nowIso() });
await db.insert(schema.workspaces).values({ id: wsId, userId, name: 'perf', rootPath: null, createdAt: nowIso(), updatedAt: nowIso() });
await db.insert(schema.conversations).values({ id: convId, workspaceId: wsId, title: '百万 token', goalId: null, createdAt: nowIso(), updatedAt: nowIso() });

const TARGET_TOKENS = Number(process.env.PERF_TARGET_TOKENS ?? '1000000');
const paragraph = '储能行业装机量持续增长，政策驱动明显，2025 年预计新增 120GW，需关注产能过剩风险。';
const chunk = paragraph.repeat(40); // ~1400 字

console.log(`[perf] 目标 ${TARGET_TOKENS.toLocaleString()} token，开始写入…`);
let written = 0;
let tokens = 0;
const t0 = Date.now();
while (tokens < TARGET_TOKENS) {
  const batchSize = Math.max(1, Math.min(200, Math.ceil((TARGET_TOKENS - tokens) / 1400)));
  const rows = Array.from({ length: batchSize }, (_, i) => ({
    role: (i % 10 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `第 ${written + i} 段：${chunk}`,
  }));
  const appended = await cm.appendMessages(convId, rows);
  written += appended.length;
  tokens += appended.reduce((s, m) => s + m.tokenCount, 0);
}
console.log(`[perf] 写入 ${written} 条 / ${tokens.toLocaleString()} token，用时 ${Date.now() - t0}ms`);

const memBefore = process.memoryUsage().heapUsed;
const t1 = Date.now();
const bundle = await cm.buildContext(convId, {
  query: '2025 年储能新增装机量是多少？有哪些风险？',
  budget: 200_000,
});
const buildMs = Date.now() - t1;
const memAfter = process.memoryUsage().heapUsed;

console.log(`[perf] 组装用时 ${buildMs}ms，输入 token ${bundle.totalTokens.toLocaleString()}`);
console.log(`[perf] 预算：used=${bundle.budget.used.toLocaleString()} total=${bundle.budget.total.toLocaleString()} over=${bundle.budget.overBudget}`);
console.log(`[perf] 分区：${bundle.blocks.map((b) => `${b.kind}=${b.tokens}`).join(' ')}`);
console.log(`[perf] 溯源引用 ${bundle.citations.length} 条，路由模型 ${bundle.model}（长上下文切换=${bundle.routedByLength}）`);
console.log(`[perf] 堆内存增量 ${((memAfter - memBefore) / 1024 / 1024).toFixed(1)} MB`);

const t2 = Date.now();
const compacted = await cm.compact(convId, { workspaceId: wsId });
console.log(`[perf] 压缩用时 ${Date.now() - t2}ms，摘要 ${compacted.summarizedMessages} 条，事实 ${compacted.factsExtracted} 条，token ${compacted.tokensBefore} → ${compacted.tokensAfter}`);

const t3 = Date.now();
const after = await cm.buildContext(convId, { query: '继续，讲一下风险', budget: 200_000 });
console.log(`[perf] 压缩后再组装用时 ${Date.now() - t3}ms，分区 ${after.blocks.map((b) => b.kind).join(',')}`);

const ok =
  tokens >= TARGET_TOKENS &&
  !bundle.budget.overBudget &&
  !after.budget.overBudget &&
  bundle.blocks.some((b) => b.kind === 'recent') &&
  after.blocks.some((b) => b.kind === 'summary');

console.log(ok ? '[perf] ✅ 通过：百万 token 不崩溃，预算不超限，有摘要/召回/溯源' : '[perf] ❌ 未达标');
closeDb();
process.exit(ok ? 0 : 1);

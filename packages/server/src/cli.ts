#!/usr/bin/env node
/**
 * CLI：不依赖桌面端也能验证 Phase 1 全链路。
 *
 *   pnpm cli bootstrap
 *   pnpm cli goal "写一份2025年新能源行业简报" --auto
 *   pnpm cli advance <goalId>
 *   pnpm cli status <goalId>
 *   pnpm cli office docx --title "周报" --content "# 本周\n- 完成 A"
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getDb } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { WorkspaceService } from './services/workspace.ts';
import { GoalService } from './agent/goal-service.ts';
import { officeGenerateTool } from './tools/office-tools.ts';
import { registerBuiltinTools } from './tools/index.ts';
import { newId } from './utils/ids.ts';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx === -1 ? undefined : process.argv[idx + 1];
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  runMigrations();
  registerBuiltinTools();
  const db = getDb();
  const cmd = process.argv[2];

  if (cmd === 'bootstrap') {
    const wsService = new WorkspaceService(db);
    const { user, workspace } = await wsService.ensureBootstrap();
    console.log(JSON.stringify({ user, workspace }, null, 2));
    return;
  }

  if (cmd === 'goal') {
    const objective = process.argv[3];
    if (!objective) throw new Error('用法: cli goal "<目标>" [--auto]');
    const wsService = new WorkspaceService(db);
    const { workspace } = await wsService.ensureBootstrap();
    const goals = new GoalService(db);
    const res = await goals.createGoal({ workspaceId: workspace.id, objective, autoRun: has('auto') });
    console.log(`目标已创建: ${res.goal.id}`);
    console.log(`验收标准:\n${res.goal.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}`);
    console.log(`任务 ${res.tasks.length} 个: ${res.tasks.map((t) => `${t.title}[${t.agentRole}]`).join(' → ')}`);
    console.log(`查询进度: pnpm cli status ${res.goal.id}`);
    return;
  }

  if (cmd === 'advance' || cmd === 'run') {
    const goalId = process.argv[3];
    if (!goalId) throw new Error('用法: cli advance <goalId>');
    const goals = new GoalService(db);
    const res = cmd === 'run' ? await goals.advanceUntilFinished(goalId) : await goals.advance(goalId);
    printStatus(res.goal, res.tasks, res.verdict);
    return;
  }

  if (cmd === 'status') {
    const goalId = process.argv[3];
    if (!goalId) throw new Error('用法: cli status <goalId>');
    const goals = new GoalService(db);
    const goal = await goals.getGoal(goalId);
    printStatus(goal, await goals.listTasks(goalId), null);
    return;
  }

  if (cmd === 'office') {
    const format = (process.argv[3] ?? 'docx') as 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'markdown';
    const wsService = new WorkspaceService(db);
    const { workspace } = await wsService.ensureBootstrap();
    const outDir = path.resolve(process.cwd(), 'out');
    if (!existsSync(outDir)) {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(outDir, { recursive: true });
    }
    const res = await officeGenerateTool.run(
      {
        format,
        title: arg('title') ?? '示例文档',
        content: arg('content') ?? '# 示例\n\n- 由 CLI 生成',
      },
      {
        workspaceId: workspace.id,
        goalId: null,
        taskId: null,
        agentId: 'cli',
        runId: newId('run'),
        userConfirmed: true,
        workspaceRoot: path.dirname(outDir),
      },
    );
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  console.log('可用命令: bootstrap | goal | advance | run | status | office');
}

function printStatus(goal: { status: string; progress: number; iterations: number; auditReport: string | null }, tasks: { title: string; status: string; agentRole: string }[], verdict: unknown) {
  console.log(`目标状态: ${goal.status}  进度: ${goal.progress}%  轮次: ${goal.iterations}`);
  for (const t of tasks) console.log(`  [${t.status}] ${t.title} (${t.agentRole})`);
  if (verdict) console.log(`审计: ${JSON.stringify(verdict, null, 2).slice(0, 1200)}`);
  if (goal.auditReport) console.log(`\n审计报告:\n${goal.auditReport}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});

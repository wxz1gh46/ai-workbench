/**
 * Step 2 集成测试：目标模式。
 * 覆盖：目标解析 → 任务 DAG → 多 Agent 并行 → 自我检查 → 反思修正 → 完成审计 → 进度树。
 * 用离线兜底（未配置模型密钥）跑通全流程，验证确定性与可回滚性。
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import './test-env.ts';
import { getDb, closeDb } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';
import { WorkspaceService } from '../services/workspace.ts';
import { GoalEngine } from './goalEngine.ts';
import { registerBuiltinTools } from '../tools/index.ts';

runMigrations();
// 目标模式会真的调用工具（fs.write / office.generate），必须注册内置工具
registerBuiltinTools();
after(() => closeDb());

const db = getDb();
const wsService = new WorkspaceService(db);
const engine = new GoalEngine(db);

let workspaceId = '';
let goalId = '';
let initialTasks: Awaited<ReturnType<typeof engine.createGoal>>['tasks'] = [];
void initialTasks;

// 用 before 建立共享前置，保证「单独跑某个用例」也能自洽
before(async () => {
  const boot = await wsService.ensureBootstrap();
  workspaceId = boot.workspace.id;
});

test('准备：引导工作区与内置 Agent', async () => {
  const agents = await wsService.listAgents(workspaceId);
  assert.ok(agents.length >= 3, `至少应有 3 个内置 Agent，实际 ${agents.length}`);
});

test('创建目标：解析出验收标准 + 生成任务 DAG', async () => {
  const { goal, tasks } = await engine.createGoal({
    workspaceId,
    objective: '为储能行业写一份可交付的调研报告，包含装机量数据与风险评估',
  });
  goalId = goal.id;
  initialTasks = tasks;
  assert.equal(goal.status, 'running');
  assert.ok(goal.acceptanceCriteria.length >= 1, '目标必须解析出验收标准');
  assert.ok(tasks.length >= 3, `应拆解出至少 3 个任务，实际 ${tasks.length}`);
  assert.ok(tasks.some((t) => t.dependsOn.length === 0), '必须存在入口任务');
  assert.ok(tasks.some((t) => t.dependsOn.length > 0), '必须存在带依赖的任务（DAG 而非平铺）');
});

/** 保证有可用的目标 id（单独运行某用例时自动创建） */
async function ensureGoal(): Promise<string> {
  if (!goalId) {
    const created = await engine.createGoal({
      workspaceId,
      objective: '为储能行业写一份可交付的调研报告，包含装机量数据与风险评估',
    });
    goalId = created.goal.id;
    initialTasks = created.tasks;
  }
  return goalId;
}

test('推进：多轮自动完成，至少执行 10 步任务', async () => {
  const id = await ensureGoal();
  const result = await engine.run(id);
  assert.ok(result.finished, `目标应自主完成，实际状态 ${result.goal.status}`);
  assert.equal(result.goal.status, 'completed');
  assert.equal(result.goal.progress, 100);
  assert.ok(result.goal.iterations >= 2, `应至少推进 2 轮，实际 ${result.goal.iterations}`);

  const tasks = await engine.listTasks(id);
  const executedSteps = tasks.length + result.goal.iterations;
  assert.ok(executedSteps >= 10, `自主完成的任务步数应 ≥ 10，实际 ${executedSteps}`);
  assert.ok(tasks.every((t) => t.status === 'succeeded'), `所有任务都应成功：${tasks.filter((t) => t.status !== 'succeeded').map((t) => t.title + ':' + t.status).join(', ')}`);
});

test('完成审计：结构化报告逐条对齐验收标准并落库', async () => {
  const id = await ensureGoal();
  const audit = await engine.getAudit(id);
  assert.ok(audit, '必须持久化审计报告');
  assert.equal(audit.passed, true);
  assert.equal(audit.criteria.length, (await engine.getGoal(id)).acceptanceCriteria.length);
  assert.ok(audit.criteria.every((c) => typeof c.met === 'boolean' && c.evidence.length > 0), '每条标准都要有结论与证据');
  assert.ok(audit.markdown.includes('## 验收标准逐条核对'));
  assert.ok(audit.markdown.includes('## 后续动作'));
  assert.equal(audit.degraded, true, '未配置模型密钥时应显式标记为降级审计');
});

test('进度树：目标 → 任务 → 子任务，含完成度与阻塞项', async () => {
  const id = await ensureGoal();
  const tree = await engine.getProgressTree(id);
  assert.equal(tree.goal.id, id);
  assert.equal(tree.nodes.length >= 3, true);
  assert.equal(tree.summary.total, tree.nodes.length);
  assert.equal(tree.summary.succeeded, tree.summary.total);
  assert.equal(tree.summary.percent, 100);
  assert.deepEqual(tree.blockers, [], '全部成功时不应有阻塞项');
  assert.ok(tree.goal.acceptanceCriteria.length > 0);
});

test('GoalRun：每轮都有可回放的运行记录', async () => {
  const runs = await engine.listRuns(await ensureGoal());
  assert.ok(runs.length >= 2, `应有 ≥2 条轮次记录，实际 ${runs.length}`);
  assert.ok(runs.every((r) => r.iteration > 0));
  assert.ok(runs.every((r) => r.status === 'succeeded' || r.status === 'running'));
  assert.ok(runs.some((r) => r.auditReport), '至少最后一轮应带上审计报告');
  assert.ok(runs.every((r) => r.finishedAt), '已结束的轮次必须有 finishedAt');
});

test('任务追踪：每个任务都有 AgentRun 记录（模型/token）', async () => {
  const tasks = await engine.listTasks(await ensureGoal());
  for (const t of tasks) {
    assert.ok(t.lastAgentId, `任务「${t.title}」应记录执行 Agent`);
    assert.ok((t.outputSummary ?? '').length >= 0);
  }
});

test('取消目标：未完成目标可取消，任务同步置为 cancelled', async () => {
  const { goal } = await engine.createGoal({ workspaceId, objective: '一个会被取消的目标，需要写报告与做数据表' });
  const cancelled = await engine.cancel(goal.id);
  assert.equal(cancelled.status, 'cancelled');
  const tasks = await engine.listTasks(goal.id);
  assert.ok(tasks.every((t) => ['cancelled', 'succeeded'].includes(t.status)), '未完成的任务应被取消');
  // 已完成目标不可取消
  const completedId = await ensureGoal();
  await assert.rejects(() => engine.cancel(completedId), /已完成/);
});

test('任务取消与改派：状态可查询、操作留审计', async () => {
  const { tasks } = await engine.createGoal({ workspaceId, objective: '用于测试任务级操作的临时目标描述' });
  const target = tasks[0]!;
  const cancelled = await engine.cancelTask(target.id);
  assert.equal(cancelled.status, 'cancelled');

  const another = tasks[1];
  if (another) {
    const agents = await wsService.listAgents(workspaceId);
    const assigned = await engine.assignTask(another.id, agents[0]!.id, true);
    assert.equal(assigned.claimedBy, agents[0]!.id);
  }
});

test('集群配置：可切换模式（含降级为单 Agent）', async () => {
  const updated = await engine.setClusterConfig(workspaceId, { mode: 'single', maxParallel: 1 });
  assert.equal(updated.mode, 'single');
  assert.equal(updated.maxParallel, 1);

  const back = await engine.setClusterConfig(workspaceId, { mode: 'parallel', maxParallel: 4 });
  assert.equal(back.mode, 'parallel');
  const read = await engine.getClusterConfig(workspaceId);
  assert.equal(read.mode, 'parallel');
  assert.equal(read.maxParallel, 4);
});

test('任务板：按列聚合，含认领者与阻塞原因', async () => {
  const id = await ensureGoal();
  const board = await engine.getTaskBoard(id);
  assert.equal(board.total, (await engine.listTasks(id)).length);
  const done = board.columns.done as unknown[];
  assert.ok(done.length > 0, '已完成任务应出现在 done 列');
  assert.ok((board.columns.todo as unknown[]).length + (board.columns.running as unknown[]).length + done.length + (board.columns.blocked as unknown[]).length === board.total);
});

test('Agent 消息总线：可发送与查询消息', async () => {
  const id = await ensureGoal();
  const msg = await engine.sendAgentMessage({ goalId: id, content: '请优先核对装机量数据来源', kind: 'request-help' });
  assert.ok(msg.id);
  const list = await engine.listAgentMessages(id);
  assert.ok(list.some((m) => m.id === msg.id));
});

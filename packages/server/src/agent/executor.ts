import { and, eq } from 'drizzle-orm';
import { EventType, type Agent, type Task } from '@ai/shared';
import type { Db } from '../db/client.ts';
import { agentRuns, agents, tasks, toolCalls } from '../db/schema/index.ts';
import { eventBus } from '../events/bus.ts';
import { toolRegistry } from '../tools/index.ts';
import type { ToolContext } from '../tools/types.ts';
import { modelRouter } from './model-router.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { logger } from '../utils/logger.ts';

export interface ExecuteResult {
  status: 'succeeded' | 'failed';
  output: Record<string, unknown>;
  error?: string;
  degraded: boolean;
}

export interface ExecuteOptions {
  /** 工作区根目录，由调用方注入；null 时文件类工具会拒绝执行 */
  workspaceRoot: string | null;
  /** 用户是否已确认危险操作 */
  userConfirmed?: boolean;
}

/**
 * Executor：执行单个任务。
 *
 * 1) 任务置 running，创建 AgentRun（可追踪）
 * 2) 组装 prompt：Agent 自己的 systemPrompt（独立上下文）+ 任务 + 上游产出 + 可用工具
 * 3) 模型输出 Markdown 结论，可选附带 toolCalls JSON 块
 * 4) 每个工具调用写 tool_calls 表 + 事件总线（含被权限拒绝的）
 * 5) 落库产出、更新任务状态、释放 Agent
 */
export class Executor {
  constructor(private readonly db: Db) {}

  async runTask(
    task: Task,
    agent: Agent,
    upstreamOutputs: Record<string, unknown>,
    opts: ExecuteOptions,
  ): Promise<ExecuteResult> {
    const startedAt = nowIso();
    const runId = newId('run');

    await this.db.insert(agentRuns).values({
      id: runId,
      agentId: agent.id,
      taskId: task.id,
      goalId: task.goalId,
      status: 'running',
      iteration: task.attempts,
      reasoning: '',
      promptDigest: '',
      model: modelRouter.selectModel(0, agent.model ?? undefined),
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      error: null,
      startedAt,
      finishedAt: null,
    });
    await this.db
      .update(tasks)
      .set({ status: 'running', startedAt, updatedAt: startedAt, claimedBy: agent.id })
      .where(eq(tasks.id, task.id));
    await this.db
      .update(agents)
      .set({ status: 'busy', currentTaskId: task.id, updatedAt: startedAt })
      .where(eq(agents.id, agent.id));

    eventBus.publishBuffered(
      EventType.RUN_STARTED,
      { runId, taskId: task.id, agentId: agent.id, agentRole: agent.role },
      { workspaceId: agent.workspaceId, goalId: task.goalId, taskId: task.id },
    );
    eventBus.publishBuffered(
      EventType.AGENT_STATUS,
      { agentId: agent.id, role: agent.role, status: 'busy', currentTaskId: task.id },
      { workspaceId: agent.workspaceId, goalId: task.goalId, taskId: task.id },
    );

    const tools = toolRegistry.describe(task.tools);
    const prompt = [
      `# 任务\n${task.title}\n\n${task.description}`,
      Object.keys(upstreamOutputs).length > 0
        ? `# 上游产出\n${JSON.stringify(upstreamOutputs, null, 2).slice(0, 8000)}`
        : '',
      tools.length > 0 ? `# 可用工具\n${JSON.stringify(tools, null, 2)}` : '',
      '# 输出要求\n先输出结论（Markdown）。如需调用工具，在最后附一个 JSON 代码块：\n' +
        '```json\n{"toolCalls":[{"name":"fs.write","args":{"path":"out/report.md","content":"..."}}]}\n```',
    ]
      .filter(Boolean)
      .join('\n\n');

    let reasoning = '';
    let degraded = false;
    let model = agent.model ?? modelRouter.selectModel(0);
    let inputTokens = 0;
    let outputTokens = 0;
    let runError: string | null = null;

    try {
      const chat = await modelRouter.chat({
        messages: [
          { role: 'system', content: agent.systemPrompt },
          { role: 'user', content: prompt },
        ],
        temperature: 0.3,
        ...(agent.model ? { model: agent.model } : {}),
      });
      reasoning = stripToolCallBlock(chat.content);
      degraded = chat.degraded;
      model = chat.model;
      inputTokens = chat.usage.inputTokens;
      outputTokens = chat.usage.outputTokens;

      for (const call of extractToolCalls(chat.content)) {
        const ctx: ToolContext = {
          workspaceId: agent.workspaceId,
          goalId: task.goalId,
          taskId: task.id,
          agentId: agent.id,
          runId,
          userConfirmed: opts.userConfirmed ?? false,
          workspaceRoot: opts.workspaceRoot,
        };
        const t0 = Date.now();
        const res = await toolRegistry.invoke(call.name, call.args, ctx);
        const durationMs = Date.now() - t0;
        await this.db.insert(toolCalls).values({
          id: newId('tc'),
          runId,
          agentId: agent.id,
          toolName: call.name,
          args: call.args,
          result: (res.data ?? { error: res.error }) as Record<string, unknown>,
          allowed: res.ok,
          durationMs,
          error: res.error ?? null,
          createdAt: nowIso(),
        });
        eventBus.publishBuffered(
          EventType.TOOL_CALLED,
          { toolName: call.name, ok: res.ok, durationMs, error: res.error ?? null, summary: res.summary ?? null },
          { workspaceId: agent.workspaceId, goalId: task.goalId, taskId: task.id },
        );
      }
    } catch (e) {
      runError = e instanceof Error ? e.message : String(e);
      logger.error('executor failed', { taskId: task.id, error: runError });
    }

    const finishedAt = nowIso();
    const status: ExecuteResult['status'] = runError ? 'failed' : 'succeeded';
    const output: Record<string, unknown> = { text: reasoning, degraded };

    await this.db
      .update(agentRuns)
      .set({
        status,
        reasoning,
        promptDigest: prompt.slice(0, 2000),
        model,
        inputTokens,
        outputTokens,
        costUsd: 0,
        error: runError,
        finishedAt,
      })
      .where(eq(agentRuns.id, runId));

    await this.db
      .update(tasks)
      .set({
        status,
        progress: status === 'succeeded' ? 100 : 0,
        output,
        error: runError,
        finishedAt,
        updatedAt: finishedAt,
      })
      .where(eq(tasks.id, task.id));

    await this.db
      .update(agents)
      .set({ status: 'idle', currentTaskId: null, updatedAt: finishedAt })
      .where(eq(agents.id, agent.id));

    eventBus.publishBuffered(
      EventType.RUN_FINISHED,
      { runId, status, taskId: task.id, agentId: agent.id },
      { workspaceId: agent.workspaceId, goalId: task.goalId, taskId: task.id },
    );
    eventBus.publishBuffered(
      EventType.TASK_UPDATED,
      { taskId: task.id, status, progress: status === 'succeeded' ? 100 : 0 },
      { workspaceId: agent.workspaceId, goalId: task.goalId, taskId: task.id },
    );

    return { status, output, degraded, ...(runError ? { error: runError } : {}) };
  }
}

/** 从模型输出里提取 JSON 工具调用块（取最后一个合法块） */
export function extractToolCalls(content: string): { name: string; args: Record<string, unknown> }[] {
  const blocks = [...content.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (const b of blocks.reverse()) {
    const raw = b[1];
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw.trim()) as { toolCalls?: unknown };
      if (!Array.isArray(parsed.toolCalls)) continue;
      return parsed.toolCalls
        .filter(
          (c): c is { name: string; args?: Record<string, unknown> } =>
            typeof c === 'object' && c !== null && typeof (c as { name?: unknown }).name === 'string',
        )
        .map((c) => ({ name: c.name, args: c.args ?? {} }));
    } catch {
      continue;
    }
  }
  return [];
}

export function stripToolCallBlock(content: string): string {
  return content.replace(/```(?:json)?\s*\{[\s\S]*?"toolCalls"[\s\S]*?\}\s*```/g, '').trim();
}

/** 按角色查找可用 Agent（角色在 workspaces 内唯一） */
export async function findAgentForRole(db: Db, workspaceId: string, role: string): Promise<Agent | null> {
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), eq(agents.role, role)))
    .limit(1);
  return (rows[0] as Agent | undefined) ?? null;
}

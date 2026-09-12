import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { clusterPolicies } from '../db/schema/index.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';

/**
 * 集群策略（Phase 4 Step 4）。
 *
 * 策略是「资源治理」的唯一入口：
 *   - maxNodes / maxParallelTasks：硬上限，超过直接报错（不静默降级）
 *   - resourceLimits：单节点可用资源上限，分发任务时校验
 *   - fallbackEnabled：是否允许集群异常时自动回退单机
 *   - heartbeatTimeoutMs：心跳超时（决定多快判定节点离线）
 */

export const DEFAULT_POLICY = {
  name: 'default',
  maxNodes: 8,
  maxParallelTasks: 4,
  resourceLimits: { cpu: 4, memoryMb: 8192, gpu: 0, diskGb: 100, networkMbps: 200 } as Record<string, number>,
  fallbackEnabled: true,
  heartbeatTimeoutMs: 30_000,
};

export class ClusterPolicyService {
  constructor(private readonly db: Db) {}

  async get(workspaceId: string) {
    const rows = (await this.db.select().from(clusterPolicies).where(eq(clusterPolicies.workspaceId, workspaceId))) as unknown as PolicyRow[];
    if (rows[0]) return rows[0];
    return this.create(workspaceId, DEFAULT_POLICY);
  }

  async create(workspaceId: string, input: Partial<typeof DEFAULT_POLICY>) {
    const now = nowIso();
    const row = {
      id: newId('cpl'),
      workspaceId,
      name: input.name ?? DEFAULT_POLICY.name,
      maxNodes: input.maxNodes ?? DEFAULT_POLICY.maxNodes,
      maxParallelTasks: input.maxParallelTasks ?? DEFAULT_POLICY.maxParallelTasks,
      resourceLimits: (input.resourceLimits ?? DEFAULT_POLICY.resourceLimits) as never,
      fallbackEnabled: input.fallbackEnabled ?? DEFAULT_POLICY.fallbackEnabled,
      heartbeatTimeoutMs: input.heartbeatTimeoutMs ?? DEFAULT_POLICY.heartbeatTimeoutMs,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(clusterPolicies).values(row as never);
    return row as unknown as PolicyRow;
  }

  async update(workspaceId: string, patch: Partial<typeof DEFAULT_POLICY>) {
    const current = await this.get(workspaceId);
    validatePolicy({ ...current, ...patch } as PolicyRow);
    const now = nowIso();
    await this.db
      .update(clusterPolicies)
      .set({
        name: patch.name ?? current.name,
        maxNodes: patch.maxNodes ?? current.maxNodes,
        maxParallelTasks: patch.maxParallelTasks ?? current.maxParallelTasks,
        resourceLimits: (patch.resourceLimits ?? current.resourceLimits) as never,
        fallbackEnabled: patch.fallbackEnabled ?? current.fallbackEnabled,
        heartbeatTimeoutMs: patch.heartbeatTimeoutMs ?? current.heartbeatTimeoutMs,
        updatedAt: now,
      } as never)
      .where(eq(clusterPolicies.id, current.id));
    return this.get(workspaceId);
  }

  /** 资源治理：任务所需资源是否超过单节点上限 */
  checkResource(limits: Record<string, number>, need: Record<string, number>): { ok: boolean; violations: string[] } {
    const violations: string[] = [];
    for (const [k, v] of Object.entries(need)) {
      const limit = limits[k];
      if (typeof limit === 'number' && v > limit) violations.push(`${k}: 需要 ${v}，策略上限 ${limit}`);
    }
    return { ok: violations.length === 0, violations };
  }
}

export function validatePolicy(policy: { maxNodes: number; maxParallelTasks: number; heartbeatTimeoutMs: number; resourceLimits: Record<string, number> }): void {
  if (!Number.isInteger(policy.maxNodes) || policy.maxNodes < 1 || policy.maxNodes > 256) {
    throw AppError.badRequest(`maxNodes 必须是 1~256 的整数（收到 ${policy.maxNodes}）`);
  }
  if (!Number.isInteger(policy.maxParallelTasks) || policy.maxParallelTasks < 1 || policy.maxParallelTasks > 64) {
    throw AppError.badRequest(`maxParallelTasks 必须是 1~64 的整数（收到 ${policy.maxParallelTasks}）`);
  }
  if (!Number.isInteger(policy.heartbeatTimeoutMs) || policy.heartbeatTimeoutMs < 1000 || policy.heartbeatTimeoutMs > 10 * 60 * 1000) {
    throw AppError.badRequest(`heartbeatTimeoutMs 必须是 1000~600000 之间的整数（收到 ${policy.heartbeatTimeoutMs}）`);
  }
  for (const [k, v] of Object.entries(policy.resourceLimits ?? {})) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw AppError.badRequest(`资源上限 ${k} 必须是非负数（收到 ${String(v)}）`);
    }
  }
}

export type PolicyRow = typeof clusterPolicies.$inferSelect;

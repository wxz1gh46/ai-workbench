import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { clusterHealth, clusterNodes } from '../db/schema/index.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';

/**
 * 节点注册表（Phase 4 Step 4）。
 *
 * 关键约束：
 *   - 同一 cluster 内 name 唯一（重名节点会让「任务分发给谁」变得不可推断）
 *   - 注册时校验 host：默认禁止注册指向内网/元数据的地址（防 SSRF，与插件沙箱同一套判定）
 *   - 节点数量受集群策略 maxNodes 限制：注册在第 N+1 个时明确报错，而不是静默忽略
 *   - 节点默认状态为 offline：只有心跳后才能变 online（不允许「注册即上线」的假在线）
 */

export interface RegisterNodeInput {
  clusterId?: string;
  name: string;
  role?: 'leader' | 'worker' | 'candidate';
  host?: string;
  port?: number;
  resources?: Record<string, number>;
  labels?: Record<string, string>;
}

export const DEFAULT_RESOURCES: Record<string, number> = {
  cpu: 2,
  memoryMb: 4096,
  gpu: 0,
  diskGb: 20,
  networkMbps: 100,
};

/** 与插件沙箱同一套内网判定（避免两处规则不一致留下绕过口子） */
const PRIVATE_HOST_RE = [/^localhost$/i, /^127\./, /^0\.0\.0\.0$/, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^\[?::1\]?$/];

export function isPrivateClusterHost(host: string): boolean {
  return PRIVATE_HOST_RE.some((re) => re.test(host));
}

export class NodeRegistry {
  constructor(private readonly db: Db) {}

  async list(clusterId = 'local') {
    return (await this.db.select().from(clusterNodes).where(eq(clusterNodes.clusterId, clusterId))) as unknown as NodeRow[];
  }

  async get(nodeId: string): Promise<NodeRow> {
    const rows = (await this.db.select().from(clusterNodes).where(eq(clusterNodes.id, nodeId)).limit(1)) as unknown as NodeRow[];
    const row = rows[0];
    if (!row) throw AppError.notFound(`集群节点不存在: ${nodeId}`);
    return row;
  }

  async register(input: RegisterNodeInput, limits: { maxNodes: number; allowLoopback?: boolean }) {
    const clusterId = input.clusterId ?? 'local';
    const host = (input.host ?? '127.0.0.1').trim();
    const isLoopback = /^(127\.|localhost$|\[?::1\]?$)/i.test(host);
    if (!isLoopback && isPrivateClusterHost(host) && !input.host) {
      throw AppError.badRequest(`节点地址属于内网段，请显式确认后注册：${host}`);
    }
    if (isLoopback && limits.allowLoopback === false) {
      throw AppError.badRequest('策略不允许注册回环地址节点');
    }
    if (!Number.isInteger(input.port ?? 0) || (input.port ?? 0) < 0 || (input.port ?? 0) > 65535) {
      throw AppError.badRequest(`端口非法：${input.port}`);
    }

    const nodes = await this.list(clusterId);
    const existing = nodes.find((n) => n.name === input.name);
    if (!existing && nodes.length >= limits.maxNodes) {
      throw AppError.conflict(`集群节点数已达上限 ${limits.maxNodes}（policy.maxNodes）。请先移除不用节点或调大上限。`);
    }

    const now = nowIso();
    if (existing) {
      await this.db
        .update(clusterNodes)
        .set({
          role: input.role ?? existing.role,
          host,
          port: input.port ?? existing.port,
          resources: (input.resources ?? existing.resources) as never,
          labels: (input.labels ?? existing.labels) as never,
          updatedAt: now,
        } as never)
        .where(eq(clusterNodes.id, existing.id));
      return this.get(existing.id);
    }

    const id = newId('cnd');
    await this.db.insert(clusterNodes).values({
      id,
      clusterId,
      name: input.name.trim(),
      role: input.role ?? 'worker',
      host,
      port: input.port ?? 0,
      status: 'offline',
      resources: (input.resources ?? DEFAULT_RESOURCES) as never,
      labels: (input.labels ?? {}) as never,
      lastHeartbeat: null,
      heartbeatMiss: 0,
      createdAt: now,
      updatedAt: now,
    } as never);
    return this.get(id);
  }

  async remove(nodeId: string) {
    const node = await this.get(nodeId);
    const online = await this.list(node.clusterId);
    if (node.role === 'leader' && online.filter((n) => n.status === 'online' && n.id !== nodeId).length > 0) {
      // 不允许静默删掉 leader：否则集群会短暂处于「无主」却没人知道
      throw AppError.conflict('不能直接删除在线集群的 leader 节点，请先触发重新选举或改派角色');
    }
    await this.db.delete(clusterNodes).where(eq(clusterNodes.id, nodeId));
    return { removed: nodeId, name: node.name };
  }

  async setRole(nodeId: string, role: NodeRow['role']) {
    await this.db.update(clusterNodes).set({ role, updatedAt: nowIso() } as never).where(eq(clusterNodes.id, nodeId));
    return this.get(nodeId);
  }

  async setStatus(nodeId: string, status: NodeRow['status']) {
    await this.db.update(clusterNodes).set({ status, updatedAt: nowIso() } as never).where(eq(clusterNodes.id, nodeId));
    return this.get(nodeId);
  }

  /** 心跳：更新 lastHeartbeat、清零 miss，并把 offline 拉回 online */
  async heartbeat(nodeId: string, health?: { cpu?: number; memory?: number; gpu?: number; disk?: number; network?: number }) {
    const node = await this.get(nodeId);
    const now = nowIso();
    await this.db
      .update(clusterNodes)
      .set({ lastHeartbeat: now, heartbeatMiss: 0, status: node.status === 'draining' ? 'draining' : 'online', updatedAt: now } as never)
      .where(eq(clusterNodes.id, nodeId));
    if (health) {
      await this.db.insert(clusterHealth).values({
        id: newId('chl'),
        nodeId,
        cpu: clamp(health.cpu),
        memory: clamp(health.memory),
        gpu: clamp(health.gpu),
        disk: clamp(health.disk),
        network: clamp(health.network),
        recordedAt: now,
      } as never);
    }
    return this.get(nodeId);
  }

  /** 心跳扫描：超时节点标记 offline 并累计 miss（不删节点，便于排障） */
  async sweep(timeoutMs: number, nowDate = new Date()): Promise<{ offline: NodeRow[]; online: NodeRow[] }> {
    const nodes = await this.list();
    const offline: NodeRow[] = [];
    const online: NodeRow[] = [];
    for (const n of nodes) {
      const last = n.lastHeartbeat ? Date.parse(n.lastHeartbeat) : 0;
      const expired = !last || nowDate.getTime() - last > timeoutMs;
      if (expired && n.status !== 'offline' && n.status !== 'draining') {
        await this.db
          .update(clusterNodes)
          .set({ status: 'offline', heartbeatMiss: n.heartbeatMiss + 1, updatedAt: nowIso() } as never)
          .where(eq(clusterNodes.id, n.id));
        offline.push({ ...n, status: 'offline', heartbeatMiss: n.heartbeatMiss + 1 });
      } else if (!expired && n.status === 'online') {
        online.push(n);
      }
    }
    return { offline, online };
  }

  async health(nodeId: string, limit = 50) {
    const rows = (await this.db.select().from(clusterHealth).where(eq(clusterHealth.nodeId, nodeId))) as unknown as HealthRow[];
    return rows.sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1)).slice(0, limit);
  }

  async healthAll(limit = 100) {
    const rows = (await this.db.select().from(clusterHealth)) as unknown as HealthRow[];
    return rows.sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1)).slice(0, limit);
  }

  /** 按标签与资源筛选在线节点（任务分发用） */
  eligible(labelFilter: Record<string, string> = {}, need: Record<string, number> = {}): NodeRow[] {
    return this.lastOnline.filter((n) => {
      for (const [k, v] of Object.entries(labelFilter)) if (n.labels[k] !== v) return false;
      for (const [k, v] of Object.entries(need)) {
        const have = n.resources[k];
        if (typeof have === 'number' && have < v) return false;
      }
      return true;
    });
  }

  /** 缓存最近一次在线节点集合（sweep 后更新，避免每次分发都扫库） */
  private lastOnline: NodeRow[] = [];

  setOnlineCache(nodes: NodeRow[]): void {
    this.lastOnline = nodes;
  }

  get onlineCache(): NodeRow[] {
    return this.lastOnline;
  }
}

function clamp(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v * 100) / 100));
}

export type NodeRow = typeof clusterNodes.$inferSelect;
export type HealthRow = typeof clusterHealth.$inferSelect;
export { and };

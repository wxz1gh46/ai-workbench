import type { Db } from '../db/client.ts';
import { AppError } from '../utils/errors.ts';
import { newId, nowIso } from '../utils/ids.ts';
import { findManifest } from './pluginMarket.ts';
import { missingScopes, type PluginToolDecl } from './pluginManifest.ts';
import { PluginInstaller } from './pluginInstaller.ts';
import { PluginCallLogger } from './pluginCallLog.ts';
import { McpClient } from './mcpClient.ts';
import { ConcurrencyGate, DEFAULT_SANDBOX, withTimeout, type SandboxPolicy } from './pluginSandbox.ts';

/**
 * 插件运行期（Phase 4 Step 1）—— 把「权限 → 沙箱 → 执行 → 日志」串成一条链。
 *
 * 执行顺序（顺序本身就是安全设计，不要随意调整）：
 *   1) 插件已安装？→ 未安装直接拒绝
 *   2) 工具已声明？→ 未声明直接拒绝（不允许调用清单外的工具）
 *   3) 权限已授权？→ 缺权限拒绝，并把缺失的 scope 返回给 UI（用户可一键补授权）
 *   4) 沙箱策略校验（网络/路径/超时/并发）
 *   5) 执行（MCP 调用 或 注入的 executor）
 *   6) 无论成败都写调用日志
 */

export interface InvokeInput {
  workspaceId: string;
  installationId: string;
  tool: string;
  args?: Record<string, unknown>;
  /** 显式确认（危险工具必须为 true） */
  confirm?: boolean;
  sandbox?: Partial<SandboxPolicy>;
}

export interface InvokeResult {
  ok: boolean;
  tool: string;
  content: unknown;
  durationMs: number;
  degraded: boolean;
  denied?: { reason: string; missingScopes: string[] };
  error?: string;
}

export type ToolExecutor = (tool: PluginToolDecl, args: Record<string, unknown>) => Promise<unknown>;

export class PluginRuntime {
  private readonly gates = new Map<string, ConcurrencyGate>();
  private readonly installers = new Map<string, PluginInstaller>();

  constructor(
    private readonly db: Db,
    /** 可注入的执行器（测试 / 本地插件用）；缺失时走 MCP 客户端 */
    private readonly executors = new Map<string, ToolExecutor>(),
    private readonly mcpFactory?: (name: string) => McpClient | null,
  ) {}

  registerExecutor(pluginName: string, executor: ToolExecutor): void {
    this.executors.set(pluginName, executor);
  }

  private installer(db: Db): PluginInstaller {
    const key = 'default';
    let inst = this.installers.get(key);
    if (!inst) {
      inst = new PluginInstaller(db);
      this.installers.set(key, inst);
    }
    return inst;
  }

  async invoke(input: InvokeInput): Promise<InvokeResult> {
    const started = Date.now();
    const installer = this.installer(this.db);
    const logger = new PluginCallLogger(this.db);

    const installed = await installer.listInstalled(input.workspaceId);
    const inst = installed.find((p) => p.installationId === input.installationId);
    if (!inst) {
      throw AppError.notFound(`插件未安装: ${input.installationId}`);
    }
    const manifest = findManifest(inst.name);
    if (!manifest) throw AppError.notFound(`插件清单缺失: ${inst.name}`);

    const tool = manifest.tools.find((t) => t.name === input.tool);
    if (!tool) {
      // 调用清单外的工具：拒绝并留痕（可能是被篡改的客户端）
      await logger.log({ installationId: input.installationId, tool: input.tool, args: input.args ?? {}, ok: false, durationMs: 0, error: '工具未在插件清单中声明' });
      throw AppError.forbidden(`工具未在插件清单中声明，已拒绝调用: ${input.tool}`);
    }

    const grantedScopes = inst.grantedScopes;
    const missing = missingScopes(tool, grantedScopes);
    if (missing.length > 0) {
      await logger.log({ installationId: input.installationId, tool: input.tool, args: input.args ?? {}, ok: false, durationMs: 0, error: `权限不足：${missing.join(', ')}`, denied: true });
      return {
        ok: false,
        tool: input.tool,
        content: null,
        durationMs: Date.now() - started,
        degraded: false,
        denied: { reason: '权限未授权', missingScopes: missing },
      };
    }

    if (tool.dangerous && input.confirm !== true) {
      throw AppError.confirmRequired(`插件工具「${tool.name}」属于危险操作，需要二次确认：${tool.description}`, {
        tool: tool.name,
        requires: tool.requires ?? [],
      });
    }
    if (manifest.requiresUserAuth && grantedScopes.length === 0) {
      return {
        ok: false,
        tool: input.tool,
        content: null,
        durationMs: Date.now() - started,
        degraded: false,
        denied: { reason: '该插件需要用户手动授权后才能调用', missingScopes: manifest.permissions.map((p) => p.scope) },
      };
    }

    const policy: SandboxPolicy = { ...DEFAULT_SANDBOX, ...input.sandbox, ...(manifest.config?.sandbox as Partial<SandboxPolicy> | undefined) };
    const gateKey = `${input.installationId}:${input.tool}`;
    let gate = this.gates.get(gateKey);
    if (!gate) {
      gate = new ConcurrencyGate(policy.maxConcurrency);
      this.gates.set(gateKey, gate);
    }

    try {
      const executor = this.executors.get(inst.name);
      const content = await gate.run(() =>
        withTimeout(async () => {
          if (executor) return executor(tool, input.args ?? {});
          const client = this.mcpFactory?.(inst.name) ?? null;
          if (!client) {
            // 未接入真实 MCP 宿主：显式降级，而不是假装成功
            return { degraded: true, note: `插件 ${inst.name} 未接入运行时宿主，调用已跳过`, tool: tool.name };
          }
          const res = await client.callTool(tool.name, input.args ?? {});
          if (!res.ok) throw AppError.tool(res.error ?? 'MCP 调用失败');
          return res.content;
        }, policy.timeoutMs, `plugin ${inst.name}.${tool.name}`),
      );
      const degraded = typeof content === 'object' && content !== null && (content as { degraded?: boolean }).degraded === true;
      await logger.log({ installationId: input.installationId, tool: input.tool, args: input.args ?? {}, ok: true, durationMs: Date.now() - started });
      return { ok: true, tool: input.tool, content, durationMs: Date.now() - started, degraded };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await logger.log({ installationId: input.installationId, tool: input.tool, args: input.args ?? {}, ok: false, durationMs: Date.now() - started, error: msg });
      return { ok: false, tool: input.tool, content: null, durationMs: Date.now() - started, degraded: false, error: msg };
    }
  }

  /** 生成调用日志 id（供上层写入全局审计时关联） */
  newCallId(): string {
    return newId('pcl');
  }

  static now(): string {
    return nowIso();
  }
}

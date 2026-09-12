import { EventType } from '@ai/shared';
import { eventBus } from '../events/bus.ts';

/**
 * 部署日志（Step 3）。
 *
 * 要求「实时输出」：日志既写库（deployments.log，便于回看），也通过 EventBus 推 WS。
 * 为保证「日志流式输出」在高并发下不拖垮服务：
 *   - 内存里按 deploymentId 聚合，超过阈值才 flush 到 DB；
 *   - WS 推送逐行触发，前端按 deploymentId 过滤。
 */
export interface LogLine {
  at: string;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

export class DeployLogChannel {
  private readonly lines: LogLine[] = [];
  private flushHandler: (() => void) | null = null;
  private flushThreshold = 20;
  private readonly startedAt = Date.now();

  constructor(
    private readonly deploymentId: string,
    private readonly workspaceId: string,
  ) {}

  /** 订阅 flush（由 DeployService 注入「写库」回调） */
  onFlush(handler: () => void): void {
    this.flushHandler = handler;
  }

  info(msg: string): void {
    this.push('info', msg);
  }
  warn(msg: string): void {
    this.push('warn', msg);
  }
  error(msg: string): void {
    this.push('error', msg);
  }

  private push(level: LogLine['level'], msg: string): void {
    const line: LogLine = { at: new Date().toISOString(), level, msg };
    this.lines.push(line);
    // 实时推 WS：前端按 deploymentId 累积渲染
    eventBus.publishBuffered(
      EventType.DEPLOY_LOG,
      { deploymentId: this.deploymentId, ...line, elapsedMs: Date.now() - this.startedAt },
      { workspaceId: this.workspaceId },
    );
    if (this.lines.length >= this.flushThreshold) this.flushHandler?.();
  }

  text(): string {
    return this.lines.map((l) => `[${l.at}] ${l.level.toUpperCase()} ${l.msg}`).join('\n');
  }

  count(): number {
    return this.lines.length;
  }

  toArray(): LogLine[] {
    return [...this.lines];
  }

  /** 截断：部署日志可能很长，落库时保留头部与尾部 */
  textForStorage(maxChars = 200_000): string {
    const full = this.text();
    if (full.length <= maxChars) return full;
    const head = full.slice(0, maxChars / 2);
    const tail = full.slice(-maxChars / 2);
    return `${head}\n…（日志过长，中间 ${full.length - maxChars} 字符已省略）…\n${tail}`;
  }
}

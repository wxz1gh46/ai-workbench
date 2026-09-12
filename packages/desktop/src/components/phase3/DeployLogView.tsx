import { useEffect, useRef } from 'react';
import { Badge, Empty } from '@/components/ui';

/**
 * 部署日志查看器。
 *
 * 实时性：日志行由 WS（deploy.log 事件）追加，这里只负责渲染 + 自动滚底。
 * 为什么不用虚拟滚动：部署日志量级在千行以内（超长日志服务端已截断），
 * 直接渲染更简单，也避免滚动位置跳动。
 */
export interface DeployLogLine {
  at: string;
  level: string;
  msg: string;
}

export function DeployLogView({
  lines,
  live,
  fallbackText,
}: {
  lines: DeployLogLine[];
  live?: boolean;
  /** 历史日志（从 DB 读的静态文本） */
  fallbackText?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (!el || !autoScroll.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const staticLines =
    !lines.length && fallbackText
      ? fallbackText
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const m = /^\[(.*?)\]\s+(\w+)\s+(.*)$/.exec(line);
            return m ? { at: m[1] as string, level: m[2] as string, msg: m[3] as string } : { at: '', level: 'info', msg: line };
          })
      : [];

  const all = lines.length ? lines : staticLines;

  if (all.length === 0) return <Empty>暂无日志</Empty>;

  const levelTone = (l: string) => (l === 'error' ? 'text-rose-400' : l === 'warn' ? 'text-amber-400' : 'text-muted');

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <Badge tone={live ? 'ok' : 'default'}>{live ? '实时' : '历史'}</Badge>
        <span className="text-[10px] text-muted">{all.length} 行</span>
      </div>
      <div
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          autoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        className="max-h-72 overflow-auto rounded border border-border bg-bg p-2 font-mono text-[10px] leading-relaxed"
      >
        {all.map((l, i) => (
          <div key={i} className="flex gap-2">
            {l.at && <span className="shrink-0 text-muted/60">{l.at.slice(11, 19)}</span>}
            <span className={levelTone(l.level)}>[{l.level}]</span>
            <span className="break-all">{l.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

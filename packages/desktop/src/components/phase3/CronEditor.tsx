import { useEffect, useState } from 'react';
import { Badge, Button } from '@/components/ui';

/**
 * Cron 编辑器。
 *
 * 核心设计：用户不需要懂 cron 语法。
 *   - 提供常用表达式预设（点一下就填好）；
 *   - 输入后立即预览「自然语言描述 + 后续 5 次执行时间」，
 *     让「0 0 * * * 到底是几点跑」这种误解在保存前就暴露；
 *   - 时区可选（默认 Asia/Shanghai），明确展示而不是隐式使用服务器时区。
 */
export interface CronPreview {
  ok: boolean;
  error?: string;
  description?: string;
  next: string[];
}

const TIMEZONES = ['Asia/Shanghai', 'UTC', 'Asia/Tokyo', 'Asia/Singapore', 'America/New_York', 'Europe/London'];

export function CronEditor({
  expression,
  timezone,
  presetList,
  onExpressionChange,
  onTimezoneChange,
  onPreview,
  preview,
  previewing,
}: {
  expression: string;
  timezone: string;
  presetList: { label: string; expression: string; note: string }[];
  onExpressionChange: (v: string) => void;
  onTimezoneChange: (v: string) => void;
  onPreview: (expression: string, timezone: string) => void | Promise<void>;
  preview: CronPreview | null;
  previewing?: boolean;
}) {
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!touched) return;
    const timer = setTimeout(() => void onPreview(expression, timezone), 300);
    return () => clearTimeout(timer);
  }, [expression, timezone, touched, onPreview]);

  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        <input
          value={expression}
          onChange={(e) => {
            setTouched(true);
            onExpressionChange(e.target.value);
          }}
          placeholder="0 9 * * *（分 时 日 月 周，或 6 段带秒）"
          className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 font-mono text-[11px] outline-none focus:border-brand"
        />
        <select value={timezone} onChange={(e) => onTimezoneChange(e.target.value)} className="rounded border border-border bg-bg px-2 py-1 text-[11px]">
          {TIMEZONES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <Button onClick={() => void onPreview(expression, timezone)} disabled={previewing}>
          预览
        </Button>
      </div>

      <div className="flex flex-wrap gap-1">
        {presetList.map((p) => (
          <button
            key={p.expression}
            title={p.note}
            onClick={() => {
              setTouched(true);
              onExpressionChange(p.expression);
            }}
            className={`rounded border px-1.5 py-0.5 text-[10px] transition-colors ${
              expression === p.expression ? 'border-brand bg-brand/15 text-fg' : 'border-border text-muted hover:border-brand/60'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {preview && (
        <div className="rounded border border-border bg-bg p-1.5 text-[10px]">
          {!preview.ok ? (
            <p className="text-rose-400">{preview.error}</p>
          ) : (
            <>
              <p>
                <Badge tone="info">{preview.description}</Badge> <span className="text-muted">时区 {timezone}</span>
              </p>
              <ul className="mt-1 space-y-0.5 font-mono text-muted">
                {preview.next.slice(0, 5).map((n, i) => (
                  <li key={i}>{new Date(n).toLocaleString('zh-CN', { hour12: false, timeZone: timezone })}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

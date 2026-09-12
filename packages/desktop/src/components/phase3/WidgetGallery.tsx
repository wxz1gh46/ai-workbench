import { useState } from 'react';
import type { WidgetSpec } from '@ai/shared';
import { Badge, Button } from '@/components/ui';

/**
 * 小组件库 + 自然语言创建。
 *
 * 交互设计：
 *   - 上方是自然语言输入（主入口，符合 Phase 3「自然语言创建」要求）；
 *   - 下方是 7 类组件的目录（用户也可以直接点选，避免「不知道能说什么」）。
 */
export function WidgetGallery({
  specs,
  onCreateFromNL,
  onCreateByType,
  busy,
}: {
  specs: WidgetSpec[];
  onCreateFromNL: (text: string) => void | Promise<void>;
  onCreateByType: (type: string) => void | Promise<void>;
  busy?: boolean;
}) {
  const [text, setText] = useState('');
  const [hint, setHint] = useState<string | null>(null);

  async function submit() {
    const t = text.trim();
    if (!t) {
      setHint('请先描述你想要什么，例如「显示最近 10 个文件」');
      return;
    }
    setHint(null);
    await onCreateFromNL(t);
    setText('');
  }

  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 text-[11px] font-medium">用自然语言添加小组件</div>
        <div className="flex gap-1">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
            placeholder="例如：显示网站部署状态 / 最近文件 / 定时任务"
            className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-[11px] outline-none focus:border-brand"
          />
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            添加
          </Button>
        </div>
        {hint && <p className="mt-1 text-[10px] text-amber-400">{hint}</p>}
        <div className="mt-1 flex flex-wrap gap-1">
          {['显示任务进度', '网站部署状态', '最近文件', '定时任务', '查询数据库'].map((ex) => (
            <button
              key={ex}
              onClick={() => setText(ex)}
              className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted hover:border-brand/60 hover:text-fg"
            >
              {ex}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1 text-[11px] font-medium">组件库（{specs.length} 类）</div>
        <ul className="space-y-1">
          {specs.map((s) => (
            <li key={s.type} className="rounded border border-border bg-bg p-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium">{s.label}</span>
                <Button onClick={() => void onCreateByType(s.type)} disabled={busy}>
                  添加
                </Button>
              </div>
              <p className="mt-0.5 text-[10px] text-muted">{s.description}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                <Badge>{s.type}</Badge>
                <Badge tone="info">
                  {s.defaultSize.w}×{s.defaultSize.h}
                </Badge>
                <Badge>{s.dataSource}</Badge>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

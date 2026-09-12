import { useEffect, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, Search } from 'lucide-react';
import { NAV_BY_KEY, searchNav, type TabKey } from '@/nav/nav-config';
import { cn } from '@/lib/utils';

/**
 * 命令面板（Ctrl/Cmd + K），桌面应用的标配肌肉记忆。
 *
 * 键盘契约必须是完整的，半套比没有更烦人：
 *   ↑/↓ 移动 · Enter 打开 · Esc 关闭 · 点击外部关闭 · 自动聚焦 · 输入框保持焦点
 * 另外支持「快速跳转」之外的下一步动作：Recents 记录最近打开的 5 个功能。
 */
export function CommandPalette({
  open,
  recent,
  onClose,
  onSelect,
}: {
  open: boolean;
  recent: TabKey[];
  onClose: () => void;
  onSelect: (key: TabKey) => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(() => {
    const matched = searchNav(query);
    if (query.trim()) return matched;
    // 空查询时优先展示最近使用，其余按注册顺序补齐
    const recentItems = recent.map((k) => NAV_BY_KEY[k]).filter(Boolean);
    const rest = matched.filter((i) => !recent.includes(i.key));
    return [...recentItems, ...rest].slice(0, 8);
  }, [query, recent]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      // 让浏览器先把弹层挂上去再聚焦，否则某些 WebView 上 focus 会丢
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, results.length - 1)));
  }, [results.length]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setIndex((i) => (results.length === 0 ? 0 : (i + 1) % results.length));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setIndex((i) => (results.length === 0 ? 0 : (i - 1 + results.length) % results.length));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const target = results[index];
        if (target) {
          onSelect(target.key);
          onClose();
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, results, index, onClose, onSelect]);

  // 选中项滚动进可视区，长列表下键盘操作才可用
  useEffect(() => {
    const el = listRef.current?.children[index] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24" onClick={onClose}>
      <div
        className="w-[min(560px,92vw)] overflow-hidden rounded-lg border border-border bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search size={14} className="text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索功能：部署 / 定时 / 插件 / 提示词…"
            className="w-full bg-transparent text-xs text-fg outline-none placeholder:text-muted"
          />
          <span className="rounded border border-border px-1 text-[9px] text-muted">Esc</span>
        </div>
        <ul ref={listRef} className="max-h-72 overflow-auto py-1">
          {results.length === 0 && <li className="px-3 py-4 text-center text-xs text-muted">没有匹配的功能</li>}
          {results.map((item, i) => (
            <li key={item.key}>
              <button
                type="button"
                onMouseEnter={() => setIndex(i)}
                onClick={() => {
                  onSelect(item.key);
                  onClose();
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-2 text-left text-xs',
                  i === index ? 'bg-brand/15 text-fg' : 'text-muted hover:bg-bg',
                )}
              >
                <item.icon size={14} className="shrink-0" />
                <span className="shrink-0 text-fg">{item.label}</span>
                <span className="truncate text-[10px] text-muted">{item.summary}</span>
                <span className="ml-auto shrink-0 text-[9px] text-muted/60">{item.group}</span>
                {i === index && <CornerDownLeft size={11} className="shrink-0 text-muted" />}
              </button>
            </li>
          ))}
        </ul>
        <div className="border-t border-border px-3 py-1.5 text-[9px] text-muted">↑↓ 选择 · Enter 打开 · Esc 关闭</div>
      </div>
    </div>
  );
}

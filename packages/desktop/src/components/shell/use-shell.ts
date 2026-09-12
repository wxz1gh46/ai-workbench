import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TabKey } from '@/nav/nav-config';
import { cycleTab, nextActiveAfterClose, openTab, removeTab } from '@/components/shell/tab-state';

const OPEN_KEY = 'shell.openTabs';
const ACTIVE_KEY = 'shell.activeTab';
const COLLAPSE_KEY = 'shell.sidebarCollapsed';
const RECENT_KEY = 'shell.recentTabs';

const DEFAULT_TAB: TabKey = 'deploy';

function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式忽略 */
  }
}

/**
 * 桌面壳层的全部 UI 状态：已打开标签、当前标签、侧边栏形态、最近使用。
 *
 * 为什么不用 zustand：这些状态只在壳层内部共享，且需要持久化，
 * 独立成一个 hook 更内聚，也避免往 app-store（数据层）里塞 UI 关注点。
 */
export function useShell() {
  const [open, setOpen] = useState<TabKey[]>(() => {
    const stored = readJSON<TabKey[]>(OPEN_KEY, [DEFAULT_TAB]);
    return stored.length > 0 ? stored : [DEFAULT_TAB];
  });
  const [active, setActive] = useState<TabKey>(() => readJSON<TabKey>(ACTIVE_KEY, DEFAULT_TAB));
  const [recent, setRecent] = useState<TabKey[]>(() => readJSON<TabKey[]>(RECENT_KEY, []));
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => readJSON<boolean>(COLLAPSE_KEY, false));
  const [paletteOpen, setPaletteOpen] = useState(false);

  // 首次加载时校正：active 必须属于 open，否则标签栏与正文会不一致
  useEffect(() => {
    setOpen((prev) => {
      const nextOpen = prev.includes(active) ? prev : [...prev, active];
      writeJSON(OPEN_KEY, nextOpen);
      return nextOpen;
    });
  }, [active]);

  useEffect(() => writeJSON(ACTIVE_KEY, active), [active]);
  useEffect(() => writeJSON(OPEN_KEY, open), [open]);
  useEffect(() => writeJSON(RECENT_KEY, recent), [recent]);
  useEffect(() => writeJSON(COLLAPSE_KEY, sidebarCollapsed), [sidebarCollapsed]);

  const go = useCallback((key: TabKey) => {
    setOpen((prev) => openTab(prev, key).open);
    setActive(key);
    setRecent((prev) => [key, ...prev.filter((k) => k !== key)].slice(0, 5));
  }, []);

  const close = useCallback(
    (key: TabKey) => {
      setOpen((prevOpen) => {
        setActive((curActive) => nextActiveAfterClose(prevOpen, key, curActive, DEFAULT_TAB));
        return removeTab(prevOpen, key, DEFAULT_TAB);
      });
    },
    [],
  );

  const closeActive = useCallback(() => close(active), [close, active]);

  // 全局快捷键：Ctrl/Cmd+K 命令面板，Ctrl/Cmd+W 关当前标签，Ctrl+Tab 轮换
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (key === 'w') {
        e.preventDefault();
        closeActive();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        setOpen((prevOpen) => {
          setActive((cur) => cycleTab(prevOpen, cur, e.shiftKey ? -1 : 1));
          return prevOpen;
        });
      } else if (/^[1-9]$/.test(key)) {
        // Ctrl/Cmd+1..9 直选第 N 个已打开标签
        e.preventDefault();
        const target = open[Number(key) - 1];
        if (target) setActive(target);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeActive, open]);

  return useMemo(
    () => ({
      open,
      active,
      recent,
      sidebarCollapsed,
      paletteOpen,
      go,
      close,
      setPaletteOpen,
      toggleSidebar: () => setSidebarCollapsed((v) => !v),
    }),
    [open, active, recent, sidebarCollapsed, paletteOpen, go, close],
  );
}

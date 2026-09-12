import type { TabKey } from '@/nav/nav-config';

/**
 * 标签栏的纯逻辑（与 React 无关，单独放 .ts 以便 node --test 直接跑）。
 *
 * 标签栏是最容易写出「点一下状态就乱」的组件：关错页、页面空白、重复开同一个。
 * 所以把决策逻辑全部抽成纯函数，组件只负责渲染与派发。
 */

/** 打开标签：已存在则只激活，不存在则追加到末尾（不会重复开同一个页面） */
export function openTab(open: TabKey[], key: TabKey): { open: TabKey[]; active: TabKey } {
  return { open: open.includes(key) ? open : [...open, key], active: key };
}

/** 关闭标签时的下一个激活项：优先右邻居，其次左邻居，最后兜底 */
export function nextActiveAfterClose(open: TabKey[], closing: TabKey, active: TabKey, fallback: TabKey): TabKey {
  if (closing !== active) return active;
  const idx = open.indexOf(closing);
  if (idx === -1) return active;
  return open[idx + 1] ?? open[idx - 1] ?? fallback;
}

/** 关闭标签后的剩余列表；关掉最后一个时保留兜底页，避免正文区空白 */
export function removeTab(open: TabKey[], closing: TabKey, fallback: TabKey): TabKey[] {
  const next = open.filter((k) => k !== closing);
  return next.length > 0 ? next : [fallback];
}

/** Ctrl/Cmd+Tab 在已打开标签间轮换 */
export function cycleTab(open: TabKey[], active: TabKey, direction: 1 | -1): TabKey {
  if (open.length < 2) return active;
  const idx = open.indexOf(active);
  if (idx === -1) return open[0] ?? active;
  return open[(idx + direction + open.length) % open.length] ?? active;
}

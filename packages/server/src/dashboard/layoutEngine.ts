import type { WidgetLayout } from '@ai/shared';

/**
 * 布局引擎（Step 4）。
 *
 * 职责：
 *   - 自动排布（避免组件重叠）
 *   - 布局校验（越界/重叠/过大一律拒绝，而不是让前端画出错乱的网格）
 *   - 布局快照与回滚（看板布局可回滚是 Phase 3 验收项）
 *
 * 栅格约定：12 列；w/h 单位为格子数。
 */

export const GRID_COLS = 12;
export const MAX_ROWS = 2000;
export const MIN_W = 2;
export const MIN_H = 2;

export interface LayoutItem extends WidgetLayout {
  id: string;
}

export function validateLayout(layout: WidgetLayout): { ok: boolean; reason?: string } {
  if (![layout.x, layout.y, layout.w, layout.h].every((n) => Number.isFinite(n) && n >= 0)) {
    return { ok: false, reason: '布局参数必须是非负数字' };
  }
  if (layout.w < MIN_W || layout.h < MIN_H) return { ok: false, reason: `组件最小尺寸为 ${MIN_W}x${MIN_H}` };
  if (layout.w > GRID_COLS) return { ok: false, reason: `组件宽度不能超过 ${GRID_COLS} 列` };
  if (layout.x + layout.w > GRID_COLS) return { ok: false, reason: `组件超出右边界（x=${layout.x}, w=${layout.w}，共 ${GRID_COLS} 列）` };
  if (layout.y + layout.h > MAX_ROWS) return { ok: false, reason: `组件超出最大行数（${MAX_ROWS}）` };
  return { ok: true };
}

export function overlaps(a: WidgetLayout, b: WidgetLayout): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** 找一个不重叠的落点：从上往下、从左往右扫描 */
export function findFreeSlot(existing: LayoutItem[], size: { w: number; h: number }): WidgetLayout {
  const w = Math.min(Math.max(size.w, MIN_W), GRID_COLS);
  const h = Math.max(size.h, MIN_H);
  for (let y = 0; y < MAX_ROWS; y += 1) {
    for (let x = 0; x + w <= GRID_COLS; x += 1) {
      const candidate = { x, y, w, h };
      if (!existing.some((e) => overlaps(candidate, e))) return candidate;
    }
  }
  // 极端情况：所有位置都占满 → 放到最后一行下面（永远不会重叠）
  const maxY = existing.reduce((m, e) => Math.max(m, e.y + e.h), 0);
  return { x: 0, y: maxY, w, h };
}

/**
 * 紧凑排列：把组件向上吸附（等价于 React Grid Layout 的 compact('vertical')）。
 *
 * 重要语义（真实踩坑）：compact 是「消除空洞」而不是「全部归零」。
 * 早期实现从 y=0 开始找空位，导致用户把组件往下拖到 y=4 后保存，
 * 服务端又把它压回 y=0 —— 用户会觉得「拖了没反应」。
 * 正确做法：每个组件只在自己当前的 y 之上找位置（不能低于原地），
 * 这样既消除空洞，又尊重用户的向下布局意图。
 */
export function compact(items: LayoutItem[]): LayoutItem[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const placed: LayoutItem[] = [];
  for (const item of sorted) {
    // 关键：只在「上方存在阻挡物」时才下移。没有任何阻挡时保持用户放置的位置
    // （不能无条件吸附到 y=0，否则用户向下拖动的意图会被服务端抹掉）。
    let y = item.y;
    while (y > 0 && placed.some((p) => overlaps({ ...item, y }, p))) y -= 1;
    if (placed.some((p) => overlaps({ ...item, y }, p))) {
      // 原位也冲突（异常请求）：顺序回退到第一个不冲突的位置
      y = item.y;
      while (placed.some((p) => overlaps({ ...item, y }, p))) y += 1;
    }
    placed.push({ ...item, y });
  }
  return placed.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** 校验整块布局：逐条校验 + 两两重叠检测 */
export function validateBoard(items: LayoutItem[]): { ok: boolean; issues: { id: string; reason: string }[] } {
  const issues: { id: string; reason: string }[] = [];
  for (const item of items) {
    const res = validateLayout(item);
    if (!res.ok) issues.push({ id: item.id, reason: res.reason ?? '布局不合法' });
  }
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const a = items[i] as LayoutItem;
      const b = items[j] as LayoutItem;
      if (overlaps(a, b)) {
        issues.push({ id: b.id, reason: `与组件 ${a.id} 位置重叠` });
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

export interface LayoutSnapshot {
  at: string;
  layout: Record<string, WidgetLayout>;
}

/** 生成快照（用于回滚） */
export function snapshotLayout(items: LayoutItem[]): LayoutSnapshot {
  const layout: Record<string, WidgetLayout> = {};
  for (const i of items) layout[i.id] = { x: i.x, y: i.y, w: i.w, h: i.h };
  return { at: new Date().toISOString(), layout };
}

/** 从快照恢复：只恢复仍存在的组件，避免把已删除组件“复活” */
export function applySnapshot(current: LayoutItem[], snapshot: LayoutSnapshot): LayoutItem[] {
  return current.map((item) => {
    const saved = snapshot.layout[item.id];
    return saved ? { ...item, ...saved } : item;
  });
}

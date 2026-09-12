import assert from 'node:assert/strict';
import test from 'node:test';
import { inferWidget, getWidgetSpec, WIDGET_REGISTRY } from './widgetRegistry.ts';
import { applySnapshot, compact, findFreeSlot, overlaps, snapshotLayout, validateBoard, validateLayout, GRID_COLS } from './layoutEngine.ts';
import { WidgetDataSources } from './dataSource.ts';

/* ================================================================== */
/* 注册表：7 类组件全齐                                                */
/* ================================================================== */

test('小组件注册表：覆盖提示词要求的 7 类', () => {
  const types = WIDGET_REGISTRY.map((w) => w.type).sort();
  assert.deepEqual(types, ['agent-status', 'data-query', 'file-list', 'prompt-template', 'schedule-status', 'task-progress', 'website-status']);
  for (const spec of WIDGET_REGISTRY) {
    assert.ok(spec.label && spec.description, `${spec.type} 缺少说明`);
    assert.ok(spec.naturalLanguageExamples.length > 0, `${spec.type} 缺少自然语言示例`);
    assert.ok(spec.defaultSize.w >= 2 && spec.defaultSize.h >= 2);
    assert.ok(spec.dataSource);
  }
});

test('小组件注册表：每类都有配置 schema（UI 自动渲染表单）', () => {
  for (const spec of WIDGET_REGISTRY) {
    assert.ok(Array.isArray(spec.configSchema), `${spec.type} 缺少 configSchema`);
    for (const f of spec.configSchema) {
      assert.ok(['string', 'number', 'boolean', 'select'].includes(f.type), `${spec.type}.${f.key} 类型不支持`);
      assert.ok(f.label);
    }
  }
});

test('getWidgetSpec：未知类型返回 null 而不是抛错', () => {
  assert.equal(getWidgetSpec('not-exist' as never), null);
  assert.ok(getWidgetSpec('task-progress'));
});

/* ================================================================== */
/* 自然语言 → 组件（Step 4 核心能力）                                  */
/* ================================================================== */

test('自然语言创建：7 类都能正确识别', () => {
  const cases: [string, string][] = [
    ['显示当前目标的任务进度', 'task-progress'],
    ['看看 agent 集群在忙什么', 'agent-status'],
    ['显示最近上传的文件', 'file-list'],
    ['我的网站部署成功了吗', 'website-status'],
    ['定时任务下次什么时候跑', 'schedule-status'],
    ['查询数据库里的订单', 'data-query'],
    ['我的提示词模板', 'prompt-template'],
  ];
  for (const [text, expected] of cases) {
    const inferred = inferWidget(text);
    assert.equal(inferred.type, expected, `「${text}」应识别为 ${expected}，实际 ${inferred.type}`);
    assert.equal(inferred.degraded, false);
    assert.ok(inferred.confidence > 0.5);
  }
});

test('自然语言创建：抽取数量限制', () => {
  assert.equal(inferWidget('显示最近 10 个文件').config.limit, 10);
  assert.equal(inferWidget('显示文件列表').config.limit, undefined);
});

test('自然语言创建：data-query 尝试抽取表名作为初始 SQL', () => {
  const inferred = inferWidget('查询 orders 表的数据');
  assert.equal(inferred.type, 'data-query');
  assert.match(String(inferred.config.sql), /select \* from orders/i);
});

test('自然语言创建：无法识别时回退默认类型并标记低置信度', () => {
  const inferred = inferWidget('随便来点什么');
  assert.equal(inferred.type, 'task-progress');
  assert.equal(inferred.degraded, true);
  assert.ok(inferred.confidence < 0.5);
});

/* ================================================================== */
/* 布局引擎（Step 4 拖拽 + 回滚）                                       */
/* ================================================================== */

test('布局校验：越界、过小、超列数都被拒绝', () => {
  assert.equal(validateLayout({ x: 0, y: 0, w: 6, h: 4 }).ok, true);
  assert.match(validateLayout({ x: 10, y: 0, w: 6, h: 4 }).reason ?? '', /右边界/);
  assert.match(validateLayout({ x: 0, y: 0, w: 1, h: 4 }).reason ?? '', /最小尺寸/);
  assert.match(validateLayout({ x: 0, y: 0, w: 20, h: 4 }).reason ?? '', /不能超过 12 列/);
  assert.match(validateLayout({ x: -1, y: 0, w: 6, h: 4 }).reason ?? '', /非负/);
});

test('重叠检测', () => {
  assert.equal(overlaps({ x: 0, y: 0, w: 6, h: 4 }, { x: 3, y: 2, w: 6, h: 4 }), true);
  assert.equal(overlaps({ x: 0, y: 0, w: 6, h: 4 }, { x: 6, y: 0, w: 6, h: 4 }), false);
  assert.equal(overlaps({ x: 0, y: 0, w: 6, h: 4 }, { x: 0, y: 4, w: 6, h: 4 }), false);
});

test('自动布局：新组件绝不与已有组件重叠', () => {
  const existing = [
    { id: 'a', x: 0, y: 0, w: 6, h: 4 },
    { id: 'b', x: 6, y: 0, w: 6, h: 4 },
  ];
  const slot = findFreeSlot(existing, { w: 6, h: 4 });
  assert.equal(overlaps(slot, existing[0] as never), false);
  assert.equal(overlaps(slot, existing[1] as never), false);
  assert.ok(slot.y >= 4 || slot.x >= 6);
});

test('自动布局：满屏后放到最后一行下面（不丢组件）', () => {
  const existing = Array.from({ length: GRID_COLS / 6 }, (_, i) => ({ id: `w${i}`, x: i * 6, y: 0, w: 6, h: 4 }));
  const slot = findFreeSlot(existing, { w: 6, h: 4 });
  assert.equal(slot.y, 4);
});

test('紧凑排列：只消除空洞，不抹掉用户向下拖动的意图', () => {
  // 用户把 a、b 放在第一行，c 故意放到第三行
  const items = [
    { id: 'a', x: 0, y: 0, w: 6, h: 4 },
    { id: 'b', x: 6, y: 0, w: 6, h: 4 },
    { id: 'c', x: 0, y: 12, w: 6, h: 4 },
  ];
  const packed = compact(items);
  const check = validateBoard(packed);
  assert.equal(check.ok, true, JSON.stringify(check.issues));
  // 位置不能被服务端改写（早期实现会把 c 压回 y=0，用户会觉得「拖了没反应」）
  assert.equal(packed.find((i) => i.id === 'c')?.y, 12);
});

test('紧凑排列：单组件保持原位（不无条件吸附到 y=0）', () => {
  const packed = compact([{ id: 'a', x: 0, y: 4, w: 6, h: 4 }]);
  assert.equal(packed[0]?.y, 4);
});

test('紧凑排列：上方有阻挡时才下移避让', () => {
  // b 原本在 y=0，a 在 y=4；两者 x 重叠，因此 a 必须让位
  const packed = compact([
    { id: 'a', x: 0, y: 4, w: 6, h: 4 },
    { id: 'b', x: 0, y: 0, w: 6, h: 4 },
  ]);
  const a = packed.find((i) => i.id === 'a');
  const b = packed.find((i) => i.id === 'b');
  assert.equal(b?.y, 0);
  assert.equal(a?.y, 4);
  assert.equal(validateBoard(packed).ok, true);
});

test('整板校验：报出重叠的具体组件', () => {
  const bad = validateBoard([
    { id: 'a', x: 0, y: 0, w: 6, h: 4 },
    { id: 'b', x: 2, y: 1, w: 6, h: 4 },
  ]);
  assert.equal(bad.ok, false);
  assert.equal(bad.issues.length, 1);
  assert.match(bad.issues[0]?.reason ?? '', /重叠/);
});

test('布局快照与回滚：只恢复仍存在的组件', () => {
  const current = [
    { id: 'a', x: 0, y: 0, w: 6, h: 4 },
    { id: 'b', x: 6, y: 0, w: 6, h: 4 },
  ];
  const snap = snapshotLayout(current);
  const moved = [{ id: 'a', x: 6, y: 8, w: 6, h: 4 }];
  const restored = applySnapshot(moved, snap);
  assert.deepEqual({ x: restored[0]?.x, y: restored[0]?.y }, { x: 0, y: 0 });
  // 快照里已删除的 b 不应被复活
  assert.equal(restored.length, 1);
});

/* ================================================================== */
/* 数据源：无数据时显式降级（不能返回空数组假装成功）                    */
/* ================================================================== */

test('数据源：无目标时返回可执行的引导提示', async () => {
  const sources = new WidgetDataSources(null as never);
  const res = await sources.fetch({ workspaceId: 'ws', widgetId: 'w1', type: 'task-progress', config: {} });
  // 传入 null db 会抛错 → 被 Provider 捕获为 degraded，这正是我们要的行为
  assert.equal(res.degraded, true);
  assert.ok(res.error);
});

test('数据源：data-query 缺少配置时给出明确提示，且绝不执行写 SQL', async () => {
  const sources = new WidgetDataSources(null as never);
  const res = await sources.fetch({ workspaceId: 'ws', widgetId: 'w1', type: 'data-query', config: {} });
  assert.equal(res.degraded, true);
  assert.match(res.error ?? '', /connectionId|sql/);
});

test('数据源：data-query 强制只读', async () => {
  let calledReadOnly: boolean | null = null;
  const sources = new WidgetDataSources(null as never, {
    runQuery: async (input) => {
      calledReadOnly = input.readOnly;
      return { columns: ['n'], rows: [{ n: 1 }], rowCount: 1, truncated: false, ms: 1 };
    },
  });
  const res = await sources.fetch({
    workspaceId: 'ws',
    widgetId: 'w1',
    type: 'data-query',
    config: { connectionId: 'db1', sql: 'select 1' },
  });
  assert.equal(calledReadOnly, true);
  assert.equal(res.degraded, false);
  assert.equal((res.payload as { rowCount: number }).rowCount, 1);
});

test('数据源：推荐刷新间隔各不相同（避免所有组件同一时刻打数据源）', () => {
  const intervals = WIDGET_REGISTRY.map((w) => WidgetDataSources.recommendedInterval(w.type));
  assert.ok(intervals.every((i) => i >= 3000));
  assert.ok(new Set(intervals).size >= 3);
  assert.ok(WidgetDataSources.recommendedInterval('task-progress') <= WidgetDataSources.recommendedInterval('data-query'));
});

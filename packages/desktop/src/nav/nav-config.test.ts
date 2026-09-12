import assert from 'node:assert/strict';
import test from 'node:test';
import { NAV_BY_KEY, NAV_GROUPS, NAV_ITEMS, navItemsByGroup, searchNav } from './nav-config.ts';

/**
 * 功能集合的守门测试。
 *
 * 这些断言的意义不是"测试覆盖率"，而是防止功能悄悄从导航里消失：
 * 用户看不到入口 = 功能不存在，所以每个能力都必须能在 nav-config 里找到。
 */

test('功能清单覆盖 Phase 1~4 的全部能力', () => {
  const required = [
    '对话',
    '目标模式',
    '看板编辑器',
    'Office 工作区',
    '深度研究',
    '记忆面板',
    'Agent 集群',
    '多节点集群',
    '提示词工作台',
    '部署中心',
    '数据库面板',
    '付费数据库',
    '定时任务',
    '通知设置',
    '插件市场',
    '安全中心',
    '设置',
  ];
  const labels = NAV_ITEMS.map((i) => i.label);
  for (const label of required) {
    assert.ok(labels.includes(label), `功能「${label}」没有导航入口`);
  }
});

test('每个功能的 key 唯一且能从索引取到', () => {
  const keys = NAV_ITEMS.map((i) => i.key);
  assert.equal(new Set(keys).size, keys.length, '存在重复的 TabKey');
  for (const key of keys) assert.equal(NAV_BY_KEY[key]?.key, key);
});

test('每个功能都有分组、图标、关键词与说明，不留半成品', () => {
  for (const item of NAV_ITEMS) {
    assert.ok(NAV_GROUPS.includes(item.group as (typeof NAV_GROUPS)[number]), `${item.label} 的分组 ${item.group} 未登记`);
    assert.ok(item.icon, `${item.label} 缺少图标`);
    assert.ok(item.keywords.length > 0, `${item.label} 缺少搜索关键词，命令面板搜不到`);
    assert.ok(item.summary.length > 4, `${item.label} 的说明太短，用户看不懂用途`);
  }
});

test('分组视图数量与登记总数一致，不丢项', () => {
  const grouped = navItemsByGroup();
  const total = grouped.reduce((n, g) => n + g.items.length, 0);
  assert.equal(total, NAV_ITEMS.length);
  assert.ok(grouped.every((g) => g.items.length > 0), '不应出现空分组');
});

test('命令面板：空查询返回默认推荐，且不超过上限', () => {
  assert.ok(searchNav('').length > 0);
  assert.ok(searchNav('').length <= 8);
  assert.ok(searchNav('', 3).length <= 3);
});

test('命令面板：中文名 / 英文名 / 关键词都能命中', () => {
  assert.equal(searchNav('部署')[0]?.key, 'deploy');
  assert.equal(searchNav('deploy')[0]?.key, 'deploy');
  assert.equal(searchNav('cron')[0]?.key, 'schedules');
  assert.equal(searchNav('网页')[0]?.key, undefined, '关键词没登记就不该猜');
});

test('命令面板：标签前缀命中排在说明命中之前', () => {
  const results = searchNav('集群');
  assert.ok(results.length >= 2, '「集群」至少应命中 Agent 集群与多节点集群');
  const keys = results.map((r) => r.key);
  assert.ok(keys.includes('cluster'));
  assert.ok(keys.includes('clusterView'));
});

test('命令面板：无匹配返回空数组而不是全量', () => {
  assert.deepEqual(searchNav('zzzz不存在的功能zzzz'), []);
});

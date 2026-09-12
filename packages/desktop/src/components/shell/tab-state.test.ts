import assert from 'node:assert/strict';
import test from 'node:test';
import { cycleTab, nextActiveAfterClose, openTab, removeTab } from './tab-state.ts';

/**
 * 标签栏的纯逻辑测试。
 *
 * 标签栏是最容易写出"点一下状态就乱"的组件（关错页、页面空白、重复开同一个），
 * 所以把决策逻辑抽成纯函数单独测，组件只负责渲染。
 */

test('openTab：未打开则追加到末尾并激活', () => {
  const r = openTab(['deploy', 'schedules'], 'notify');
  assert.deepEqual(r.open, ['deploy', 'schedules', 'notify']);
  assert.equal(r.active, 'notify');
});

test('openTab：已打开只切换，不产生重复标签', () => {
  const r = openTab(['deploy', 'schedules'], 'deploy');
  assert.deepEqual(r.open, ['deploy', 'schedules']);
  assert.equal(r.active, 'deploy');
});

test('关闭非当前标签：当前标签不变', () => {
  assert.equal(nextActiveAfterClose(['a' as never, 'b' as never], 'a' as never, 'b' as never, 'deploy' as never), 'b');
});

test('关闭当前标签：优先激活右邻居', () => {
  const open = ['a', 'b', 'c'] as never[];
  assert.equal(nextActiveAfterClose(open, 'b' as never, 'b' as never, 'deploy' as never), 'c');
});

test('关闭最后一个标签：回退到左邻居', () => {
  const open = ['a', 'b'] as never[];
  assert.equal(nextActiveAfterClose(open, 'b' as never, 'b' as never, 'deploy' as never), 'a');
});

test('关闭唯一标签：回到兜底页，不留空白工作区', () => {
  assert.equal(nextActiveAfterClose(['a'] as never[], 'a' as never, 'a' as never, 'deploy' as never), 'deploy');
});

test('removeTab：关掉最后一个标签时保留兜底页', () => {
  assert.deepEqual(removeTab(['a' as never], 'a' as never, 'deploy' as never), ['deploy']);
});

test('removeTab：正常关闭只移除目标', () => {
  assert.deepEqual(removeTab(['a', 'b', 'c'] as never[], 'b' as never, 'deploy' as never), ['a', 'c']);
});

test('cycleTab：正向与反向环绕', () => {
  const open = ['a', 'b', 'c'] as never[];
  assert.equal(cycleTab(open, 'c' as never, 1), 'a');
  assert.equal(cycleTab(open, 'a' as never, -1), 'c');
});

test('cycleTab：只有一个标签时原地不动', () => {
  assert.equal(cycleTab(['a'] as never[], 'a' as never, 1), 'a');
});

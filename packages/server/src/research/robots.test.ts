import assert from 'node:assert/strict';
import test from 'node:test';
import { isPathAllowed, parseRobots } from './robots.ts';

test('parseRobots：通配 User-agent 规则生效', () => {
  const rules = parseRobots(
    ['User-agent: *', 'Disallow: /private/', 'Allow: /private/ok', 'Disallow: /admin'].join('\n'),
    'AIWorkbenchBot/0.2',
  );
  assert.deepEqual(rules.disallow.sort(), ['/admin', '/private/']);
  assert.deepEqual(rules.allow, ['/private/ok']);
});

test('isPathAllowed：Disallow 命中即拒绝', () => {
  assert.equal(isPathAllowed('/private/x', { allow: [], disallow: ['/private/'] }), false);
  assert.equal(isPathAllowed('/public/x', { allow: [], disallow: ['/private/'] }), true);
});

test('isPathAllowed：Allow 更长时允许（robots 最长匹配优先）', () => {
  assert.equal(isPathAllowed('/private/ok/page', { allow: ['/private/ok'], disallow: ['/private/'] }), true);
  assert.equal(isPathAllowed('/private/no/page', { allow: ['/private/ok'], disallow: ['/private/'] }), false);
});

test('isPathAllowed：等长时 Allow 胜出', () => {
  assert.equal(isPathAllowed('/a', { allow: ['/a'], disallow: ['/a'] }), true);
});

test('parseRobots：指定 UA 优先于通配', () => {
  const text = ['User-agent: AIWorkbenchBot', 'Disallow: /strict', '', 'User-agent: *', 'Disallow: /none'].join('\n');
  const rules = parseRobots(text, 'AIWorkbenchBot/0.2');
  assert.ok(rules.disallow.includes('/strict'));
  assert.ok(!rules.disallow.includes('/none'), '指定 UA 命中时不应混入通配规则');
});

test('parseRobots：忽略注释与空行', () => {
  const rules = parseRobots(['# 注释', '', 'User-agent: *', '  Disallow: /x  # 行内注释'].join('\n'), 'bot/1');
  assert.deepEqual(rules.disallow, ['/x']);
});

test('parseRobots：无规则时全部允许', () => {
  const rules = parseRobots('', 'bot/1');
  assert.equal(isPathAllowed('/anything', rules), true);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { CURATED_PLUGINS, assertCompliant } from './plugin-service.ts';

test('精选插件全部通过合规校验', () => {
  for (const p of CURATED_PLUGINS) assertCompliant(p);
});

test('付费数据插件必须要求用户授权', () => {
  const bad = { ...CURATED_PLUGINS[0]!, name: 'evil-paid', permissions: [{ scope: 'paid:x', description: 'y', sensitive: true }], requiresUserAuth: false };
  assert.throws(() => assertCompliant(bad), /必须要求用户手动授权/);
});

test('声明绕过反爬的插件被拒绝', () => {
  const bad = { ...CURATED_PLUGINS[0]!, name: 'evil', source: 'market://bypass-anti-crawler' , config: {} };
  assert.throws(() => assertCompliant(bad), /违反合规要求/);
});

test('插件市场覆盖要求的付费数据源', () => {
  const names = CURATED_PLUGINS.map((p) => p.name).join(',');
  for (const k of ['tonghuashun', 'tianyancha', 'wind', 'juyuan', 'sp-global', 'imf', 'hyyd', 'academic']) {
    assert.ok(names.includes(k), `缺少插件: ${k}`);
  }
});

test('插件目录自洽：requiresUserAuth 为真时必须有明确凭据名', () => {
  const catalog = CURATED_PLUGINS;
  const inconsistent = catalog.filter((p) => p.requiresUserAuth && p.secretRefs.length === 0);
  assert.deepEqual(
    inconsistent.map((p) => p.name),
    [],
    '声明需要用户授权却未说明凭据名，会让用户不知道要配置什么',
  );
  // 付费/敏感来源必须声明权限且标记 sensitive
  const paid = catalog.filter((p) => p.permissions.some((x) => x.scope.startsWith('paid:')));
  assert.ok(paid.length >= 5, `付费数据源应不少于 5 个，实际 ${paid.length}`);
  assert.ok(paid.every((p) => p.requiresUserAuth), '付费数据源必须要求用户手动授权');
  assert.ok(paid.every((p) => p.permissions.some((x) => x.sensitive)), '付费权限必须标记 sensitive');
});

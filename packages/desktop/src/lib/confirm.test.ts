import assert from 'node:assert/strict';
import test from 'node:test';
import { setConfirmImpl, triggerConfirm } from './confirm.ts';

test('triggerConfirm：默认实现可被测试替身替换（避免测试挂起）', () => {
  setConfirmImpl(() => true);
  assert.equal(triggerConfirm('确认？'), true);
  setConfirmImpl(() => false);
  assert.equal(triggerConfirm('确认？'), false);
  // 恢复一个安全的默认值，避免影响其它用例
  setConfirmImpl(() => true);
});

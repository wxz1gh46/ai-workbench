import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateMessagesTokens, estimateTokens } from './tokens.ts';

test('英文按 4 字符 ≈ 1 token', () => {
  assert.equal(estimateTokens('abcdefgh'), 2);
});

test('中文按 1 字 ≈ 1 token', () => {
  assert.equal(estimateTokens('你好世界'), 4);
});

test('空文本为 0', () => {
  assert.equal(estimateTokens(''), 0);
});

test('消息含固定开销', () => {
  assert.equal(estimateMessagesTokens([{ content: '你好' }]), 6);
});

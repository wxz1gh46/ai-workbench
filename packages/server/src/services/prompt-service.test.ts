import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_PROMPT_SECTIONS } from '@ai/shared';
import { extractVariables, renderPrompt } from './prompt-service.ts';

test('renderPrompt 只输出非空章节并按顺序编号', () => {
  const out = renderPrompt({ ...EMPTY_PROMPT_SECTIONS, role: '专家', task: '写报告' });
  assert.match(out, /## 角色\n专家/);
  assert.match(out, /## 任务\n写报告/);
  assert.ok(!out.includes('## 示例'));
});

test('renderPrompt 替换变量，缺失的保留占位', () => {
  const out = renderPrompt({ ...EMPTY_PROMPT_SECTIONS, task: '分析 {{topic}} 的 {{unknown}}' }, { topic: '新能源' });
  assert.match(out, /分析 新能源 的 \{\{unknown\}\}/);
});

test('extractVariables 去重', () => {
  const vars = extractVariables({ ...EMPTY_PROMPT_SECTIONS, task: '{{a}} {{a}} {{b}}' });
  assert.deepEqual(vars.sort(), ['a', 'b']);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { extractToolCalls, stripToolCallBlock } from './executor.ts';

test('extractToolCalls 解析最后一个 JSON 块', () => {
  const content = [
    '结论如下：这是一段分析。',
    '```json',
    '{"note":"ignore me"}',
    '```',
    '```json',
    '{"toolCalls":[{"name":"fs.write","args":{"path":"a.md","content":"hi"}}]}',
    '```',
  ].join('\n');
  const calls = extractToolCalls(content);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, 'fs.write');
  assert.equal(calls[0]!.args.path, 'a.md');
});

test('extractToolCalls 对无工具内容返回空数组', () => {
  assert.deepEqual(extractToolCalls('纯文本回答，没有工具调用'), []);
  assert.deepEqual(extractToolCalls('```json\n{"toolCalls":"not-array"}\n```'), []);
});

test('stripToolCallBlock 去掉工具块但保留正文', () => {
  const content = '正文内容\n```json\n{"toolCalls":[{"name":"x","args":{}}]}\n```';
  assert.equal(stripToolCallBlock(content), '正文内容');
});

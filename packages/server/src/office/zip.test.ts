import assert from 'node:assert/strict';
import test from 'node:test';
import { readZip, writeZip, type ZipEntry } from './zip.ts';

test('writeZip → readZip 往返保持条目名与内容', () => {
  const entries: ZipEntry[] = [
    { name: 'a.txt', data: Buffer.from('hello') },
    { name: 'dir/b.xml', data: Buffer.from('<root><x>1</x></root>') },
  ];
  const zip = writeZip(entries);
  assert.ok(zip.length > 0);
  const back = readZip(zip);
  assert.deepEqual(back.map((e) => e.name), ['a.txt', 'dir/b.xml']);
  assert.equal(back[0]!.data.toString('utf8'), 'hello');
  assert.equal(back[1]!.data.toString('utf8'), '<root><x>1</x></root>');
});

test('writeZip：输出确定性（同样输入 → 同样字节）', () => {
  const entries: ZipEntry[] = [{ name: 'x.txt', data: Buffer.from('same') }];
  assert.deepEqual(writeZip(entries), writeZip(entries));
});

test('readZip：非 ZIP 输入抛出可读错误', () => {
  assert.throws(() => readZip(Buffer.from('not a zip at all')), /EOCD|不是合法/);
});

test('writeZip/readZip：中文内容与较大文本正确处理', () => {
  const text = '储能行业调研报告\n'.repeat(500);
  const back = readZip(writeZip([{ name: '中文名.md', data: Buffer.from(text, 'utf8') }]));
  assert.equal(back[0]!.name, '中文名.md');
  assert.equal(back[0]!.data.toString('utf8'), text);
});

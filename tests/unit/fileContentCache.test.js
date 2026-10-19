const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cache = require('../../main/fileContentCache');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewflow-context-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('上下文文件超 1 MiB 返回 null，不读取全文', (t) => {
  fs.writeFileSync(path.join(dir, 'large'), Buffer.alloc(1024 * 1024 + 1));
  const open = t.mock.method(fs, 'openSync', () => { throw new Error('must not open'); });
  assert.equal(cache.readFile(dir, 'large'), null);
  assert.equal(open.mock.calls.length, 0);
});
test('上下文缓存总字节限制为 32 MiB，最近访问条目保留', (t) => {
  for (let i = 0; i < 34; i++) fs.writeFileSync(path.join(dir, String(i)), 'x'.repeat(1024 * 1024));
  for (let i = 0; i < 32; i++) assert.equal(cache.readFile(dir, String(i)).length, 1024 * 1024);
  cache.readFile(dir, '0');
  cache.readFile(dir, '32');
  const open = t.mock.method(fs, 'openSync', () => { throw new Error('uncached'); });
  assert.equal(cache.readFile(dir, '1'), null);
  assert.equal(open.mock.calls.length, 1);
  assert.equal(cache.readFile(dir, '0').length, 1024 * 1024);
  assert.equal(cache.readFile(dir, 'missing'), null);
});

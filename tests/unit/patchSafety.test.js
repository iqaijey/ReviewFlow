const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const safety = require('../../main/patchSafety');

test('补丁读取使用 fd 安全读取，保留不存在、二进制及哈希语义并限制 2 MiB', (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-patch-read-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'a.js');
  assert.equal(safety.readTarget(folder, 'missing'), null);
  fs.writeFileSync(file, 'old\n');
  const hashes = safety.targetHashes(folder, [{ path: 'a.js' }]);
  const pathnameRead = t.mock.method(fs, 'readFileSync', () => { throw new Error('不得按路径读取'); });
  assert.equal(safety.readTarget(folder, 'a.js').toString(), 'old\n');
  assert.deepEqual(safety.targetHashes(folder, [{ path: 'a.js' }]), hashes);
  assert.equal(pathnameRead.mock.callCount(), 0);
  fs.writeFileSync(file, Buffer.alloc(2 * 1024 * 1024, 120));
  assert.equal(safety.readTarget(folder, 'a.js').length, 2 * 1024 * 1024);
  fs.appendFileSync(file, 'x');
  assert.throws(() => safety.readTarget(folder, 'a.js'), /目标文件超过 2 MiB 大小限制/);
  fs.writeFileSync(file, Buffer.from([0]));
  assert.throws(() => safety.readTarget(folder, 'a.js'), /二进制/);
});

test('补丁读取拒绝预检查之后 fd 的 inode 被替换', (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-patch-swap-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.writeFileSync(path.join(folder, 'a.js'), 'inside');
  const fstat = fs.fstatSync;
  t.mock.method(fs, 'fstatSync', (fd) => { const stat = fstat(fd); stat.ino++; return stat; });
  assert.throws(() => safety.readTarget(folder, 'a.js'), /读取前已变化/);
});

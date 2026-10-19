const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readRepoFile } = require('../../main/safeRead');
const cache = require('../../main/fileContentCache');

test('仓库读取拒绝符号链接、链接目录、遍历、绝对路径及 NUL，正常文件有界读取', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-safe-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'repo');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(root, 'outside'), 'secret');
  fs.writeFileSync(path.join(folder, 'normal'), 'normal');
  fs.symlinkSync(path.join(root, 'outside'), path.join(folder, 'link'));
  fs.symlinkSync(root, path.join(folder, 'linked-dir'));
  for (const rel of ['link', 'linked-dir/outside', '../outside', 'sub/../normal', path.join(root, 'outside'), 'normal\0bad', '.']) {
    assert.throws(() => readRepoFile(folder, rel, { maxBytes: 100 }));
    assert.equal(cache.readFile(folder, rel), null);
  }
  assert.equal(readRepoFile(folder, 'normal', { maxBytes: 6 }).toString(), 'normal');
  assert.throws(() => readRepoFile(folder, 'normal', { maxBytes: 5 }), /大小限制/);
  assert.equal(cache.readFile(folder, 'normal'), 'normal');
  fs.unlinkSync(path.join(folder, 'normal'));
  fs.symlinkSync(path.join(root, 'outside'), path.join(folder, 'normal'));
  assert.equal(cache.readFile(folder, 'normal'), null);
});

test('交错替换：首次最终 lstat 与 fd 同为外部 inode，但第二次检查恢复后必须拒绝', (t) => {
  const directory = { isDirectory: () => true };
  const inside = { dev: 1, ino: 10, size: 6, isFile: () => true, isSymbolicLink: () => false };
  const outside = { ...inside, ino: 20 };
  const calls = [];
  const sequence = [inside, inside, outside, inside, inside, inside];
  t.mock.method(fs, 'realpathSync', (file) => { calls.push('realpath'); return file; });
  t.mock.method(fs, 'statSync', () => directory);
  t.mock.method(fs, 'lstatSync', () => { calls.push('lstat'); return sequence.shift(); });
  t.mock.method(fs, 'openSync', (_file, flags) => { assert.ok(flags & fs.constants.O_NOFOLLOW); calls.push('open'); return 42; });
  t.mock.method(fs, 'fstatSync', () => outside);
  const read = t.mock.method(fs, 'readSync', () => { throw new Error('不得读取外部内容'); });
  const close = t.mock.method(fs, 'closeSync', () => {});
  assert.throws(() => readRepoFile('/repo', 'dir/file', { maxBytes: 100 }), /读取前已变化/);
  assert.equal(sequence.length, 0);
  assert.equal(read.mock.callCount(), 0);
  assert.equal(close.mock.callCount(), 1);
  assert.deepEqual(calls.slice(0, 6), ['realpath', 'lstat', 'lstat', 'lstat', 'realpath', 'open']);
});

test('读取后第三次检查拒绝 inode 或设备变化；fd 大小也必须受限', (t) => {
  const inside = { dev: 1, ino: 10, size: 6, isFile: () => true, isSymbolicLink: () => false };
  let inspections = 0, opened = inside, replacement = { ...inside, ino: 20 };
  t.mock.method(fs, 'realpathSync', (file) => file);
  t.mock.method(fs, 'statSync', () => ({ isDirectory: () => true }));
  t.mock.method(fs, 'lstatSync', () => ++inspections === 6 ? replacement : inside);
  t.mock.method(fs, 'openSync', () => 42);
  t.mock.method(fs, 'fstatSync', () => opened);
  t.mock.method(fs, 'readSync', () => 0);
  t.mock.method(fs, 'closeSync', () => {});
  for (replacement of [{ ...inside, ino: 20 }, { ...inside, dev: 2 }]) {
    inspections = 0;
    assert.throws(() => readRepoFile('/repo', 'file', { maxBytes: 100 }), /读取期间已变化/);
  }
  inspections = 0; opened = { ...inside, size: 101 };
  assert.throws(() => readRepoFile('/repo', 'file', { maxBytes: 100 }), /大小限制/);
});

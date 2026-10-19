const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic, readJsonFile } = require('../../main/atomicFile');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewflow-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('原子写入创建父目录、替换内容并保留权限，不残留临时文件', (t) => {
  const dir = path.join(fixture(t), 'nested');
  const file = path.join(dir, 'data.json');
  writeFileAtomic(file, '旧内容', { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(file, 0o640);
  writeFileAtomic(file, '新内容', 'utf8');
  assert.equal(fs.readFileSync(file, 'utf8'), '新内容');
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(dir), ['data.json']);
});

test('原子写入支持二进制数据', (t) => {
  const file = path.join(fixture(t), 'image.bin');
  const data = Buffer.from([0, 255, 1]);
  writeFileAtomic(file, data);
  assert.deepEqual(fs.readFileSync(file), data);
});

for (const operation of ['writeFileSync', 'fsyncSync', 'renameSync']) {
  test(`原子写入 ${operation} 失败保留原文件并清理临时文件`, (t) => {
    const dir = fixture(t);
    const file = path.join(dir, 'data.json');
    fs.writeFileSync(file, '原内容');
    const failure = new Error('模拟磁盘失败');
    const stub = t.mock.method(fs, operation, () => { throw failure; });
    assert.throws(() => writeFileAtomic(file, '新内容'), (error) => error === failure);
    stub.mock.restore();
    assert.equal(fs.readFileSync(file, 'utf8'), '原内容');
    assert.deepEqual(fs.readdirSync(dir), ['data.json']);
  });
}

test('JSON 缺失和 null 保持回退语义，有效 JSON 正常读取', (t) => {
  const file = path.join(fixture(t), 'data.json');
  const fallback = {};
  assert.equal(readJsonFile(file, fallback), fallback);
  writeFileAtomic(file, 'null');
  assert.equal(readJsonFile(file, fallback), fallback);
  writeFileAtomic(file, '{"ok":true}');
  assert.deepEqual(readJsonFile(file, fallback), { ok: true });
});

test('损坏 JSON 隔离后回退，后续保存不覆盖损坏内容且警告不含内容', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'data.json');
  const corrupt = '{private broken content';
  fs.writeFileSync(file, corrupt);
  const warning = t.mock.method(console, 'warn', () => {});
  const fallback = [];
  assert.equal(readJsonFile(file, fallback), fallback);
  assert.equal(fs.existsSync(file), false);
  const backups = fs.readdirSync(dir);
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^data\.json\.corrupt-\d+/);
  writeFileAtomic(file, '[]');
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), corrupt);
  assert.equal(warning.mock.calls.length, 1);
  assert.equal(warning.mock.calls[0].arguments.join(' ').includes(corrupt), false);
});

test('同一毫秒内的损坏备份互不覆盖', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'data.json');
  t.mock.method(Date, 'now', () => 123);
  t.mock.method(console, 'warn', () => {});
  for (const content of ['{first', '{second']) {
    fs.writeFileSync(file, content);
    readJsonFile(file, null);
  }
  assert.deepEqual(fs.readdirSync(dir).map((name) => fs.readFileSync(path.join(dir, name), 'utf8')).sort(), ['{first', '{second']);
});

test('隔离失败或读取权限错误必须抛出，不能静默回退', (t) => {
  const file = path.join(fixture(t), 'data.json');
  fs.writeFileSync(file, '{broken');
  const failure = Object.assign(new Error('拒绝访问'), { code: 'EACCES' });
  const rename = t.mock.method(fs, 'renameSync', () => { throw failure; });
  assert.throws(() => readJsonFile(file, {}), (error) => error === failure);
  rename.mock.restore();
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  t.mock.method(fs, 'readFileSync', () => { throw failure; });
  assert.throws(() => readJsonFile(file, {}), (error) => error === failure);
});

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewflow-update-'));
const load = Module._load;
Module._load = function (request, ...args) {
  return request === 'electron' ? { app: { getPath: () => dir } } : load.call(this, request, ...args);
};
const { parseLatestYml, downloadUpdate } = require('../../main/updateChecker');
Module._load = load;
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const body = Buffer.from('verified dmg');
const digest = crypto.createHash('sha512').update(body).digest('base64');
const manifest = `version: 2.0.0\nfiles:\n  - url: app-x64.dmg\n    sha512: wrong\n  - url: app-arm64.dmg\n    sha512: ${digest}\n    size: 12\npath: app.zip\nsha512: wrong`;

test('latest yml 选择 arm64 DMG 自己的 sha512', () => {
  assert.deepEqual(parseLatestYml(manifest), { version: '2.0.0', dmgFile: 'app-arm64.dmg', sha512: digest });
});
test('更新下载校验后改名，摘要不符删除 part，长度和上限受限', async (t) => {
  let payload = body;
  let length = String(body.length);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.ok(options.signal);
    return String(url).endsWith('.yml') ? new Response(manifest) : new Response(payload, { headers: { 'content-length': length } });
  });
  const url = 'https://github.com/iqaijey/ReviewFlow/releases/latest/download/app-arm64.dmg';
  const file = await downloadUpdate(url);
  assert.deepEqual(fs.readFileSync(file), body);
  fs.writeFileSync(file, 'damaged');
  payload = Buffer.from('bad'); length = '3';
  await assert.rejects(downloadUpdate(url), /更新包校验失败，已删除下载文件/);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['app-arm64.dmg']);
  assert.equal(fs.readFileSync(file, 'utf8'), 'damaged');
  length = '999';
  await assert.rejects(downloadUpdate(url), /长度与声明不符/);
  length = String(1024 ** 3 + 1);
  await assert.rejects(downloadUpdate(url), /超过 1 GiB/);
  await assert.rejects(downloadUpdate('https://evil.test/a.dmg'), /非法的下载地址/);
});

test('已下载安装包哈希匹配时复用，不匹配时重新下载', async (t) => {
  const url = 'https://github.com/iqaijey/ReviewFlow/releases/latest/download/app-arm64.dmg';
  const file = path.join(dir, 'downloads', 'app-arm64.dmg');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  let downloads = 0;
  t.mock.method(globalThis, 'fetch', async (request) => {
    if (String(request).endsWith('.yml')) return new Response(manifest);
    downloads++;
    return new Response(body);
  });
  assert.equal(await downloadUpdate(url), file);
  assert.equal(downloads, 0);
  fs.writeFileSync(file, 'bad');
  assert.equal(await downloadUpdate(url), file);
  assert.equal(downloads, 1);
  assert.deepEqual(fs.readFileSync(file), body);
});

test('下载 60 秒无字节到达则终止请求，不设置总时长限制', async (t) => {
  fs.rmSync(path.join(dir, 'downloads', 'app-arm64.dmg'), { force: true });
  t.mock.timers.enable(['setTimeout']);
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  let signal;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).endsWith('.yml')) return new Response(manifest);
    signal = options.signal;
    started();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const pending = downloadUpdate('https://github.com/iqaijey/ReviewFlow/releases/latest/download/app-arm64.dmg');
  await ready;
  t.mock.timers.tick(59999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await assert.rejects(pending, /60 秒未收到数据/);
  assert.equal(signal.aborted, true);
});

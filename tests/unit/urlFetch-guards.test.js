const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const { createRequire } = require('module');
const { EventEmitter } = require('events');
const dns = require('dns').promises;

function harness(action) {
  const hooks = {}, windows = [];
  const webRequest = Object.fromEntries(['onBeforeRequest', 'onResponseStarted', 'onBeforeRedirect', 'onCompleted'].map((name) => [name, (fn) => { hooks[name] = fn; }]));
  const lifecycle = [];
  const partition = { webRequest,
    async setProxy(options) { lifecycle.push(['proxy', options]); },
    async clearStorageData(options) { lifecycle.push(['clear', options]); },
    async closeAllConnections() { lifecycle.push(['close']); },
  };
  class Window extends EventEmitter {
    constructor() {
      assert.equal(lifecycle.at(-1)[0], 'proxy');
      super(); windows.push(this); this.destroyed = false; this.stops = 0;
      this.webContents = Object.assign(new EventEmitter(), {
        id: windows.length, stop: () => { this.stops++; }, setWindowOpenHandler() {},
        executeJavaScript: async () => { await action(hooks, this, 'extract'); return { title: '标题', text: '足够长的正常需求正文内容'.repeat(10) }; },
      });
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    async loadURL() { await action(hooks, this, 'load'); this.webContents.emit('did-finish-load'); }
  }
  const filename = require.resolve('../../main/urlFetch');
  const local = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (id) => id === 'electron' ? { BrowserWindow: Window, session: { fromPartition: () => partition } } : local(id),
    module, URL, Buffer, process, clearTimeout,
    setTimeout: (fn, ms) => ms < 30000 ? setTimeout(fn, 0) : setTimeout(fn, ms),
  }, { filename });
  return { api: module.exports, windows, hooks, lifecycle };
}

test('隐藏窗口守卫拒绝公网导入所有私网资源类型，不走 fallback', async (t) => {
  t.mock.method(dns, 'lookup', async (host) => [{ address: host === 'public.test' ? '8.8.8.8' : '127.0.0.1', family: 4 }]);
  for (const resourceType of ['mainFrame', 'subFrame', 'script', 'image', 'xhr', 'other']) {
    const h = harness(async (hooks, win, phase) => {
      if (phase !== 'load') return;
      const result = await new Promise((resolve) => hooks.onBeforeRequest({ webContentsId: win.webContents.id, resourceType, url: 'http://private.test/resource' }, resolve));
      assert.equal(result.cancel, true, resourceType);
    });
    await assert.rejects(h.api.fetchPrdFromUrl('https://public.test'), /已阻止/);
    assert.ok(h.windows[0].stops > 0);
    assert.equal(h.windows[0].destroyed, true);
  }
});

test('隐藏窗口三个实际 IP 事件均拒绝私网连接，提取期间违规也丢弃正文', async (t) => {
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  for (const event of ['onResponseStarted', 'onBeforeRedirect', 'onCompleted']) {
    for (const phase of ['load', 'extract']) {
      const h = harness(async (hooks, win, current) => {
        if (current === phase) hooks[event]({ webContentsId: win.webContents.id, resourceType: 'image', url: 'https://public.test/image', ip: '127.0.0.1' });
      });
      await assert.rejects(h.api.fetchPrdFromUrl('https://public.test'), /已阻止/);
      assert.ok(h.windows[0].stops > 0);
    }
  }
});

test('公网网络响应缺失或无效 IP 时中止并丢弃提取结果，非网络响应明确豁免', async (t) => {
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  for (const event of ['onResponseStarted', 'onBeforeRedirect', 'onCompleted']) {
    for (const phase of ['load', 'extract']) {
      for (const ip of [undefined, '', 'invalid']) {
        const h = harness(async (hooks, win, current) => {
          if (phase === current) hooks[event]({ webContentsId: win.webContents.id, url: 'https://public.test', ip });
        });
        await assert.rejects(h.api.fetchPrdFromUrl('https://public.test'), /已阻止/);
        assert.ok(h.windows[0].stops > 0);
        assert.equal(h.windows[0].destroyed, true);
      }
    }
  }
  const h = harness(async (hooks, win) => {
    for (const url of ['data:text/plain,a', 'blob:https://public.test/id', 'about:blank']) {
      hooks.onResponseStarted({ webContentsId: win.webContents.id, url });
    }
  });
  assert.match((await h.api.fetchPrdFromUrl('https://public.test')).text, /正常需求正文/);
});

test('专用分区直连、取消无归属请求并在关闭后清理 worker 和连接', async (t) => {
  t.mock.method(dns, 'lookup', async () => [{ address: '127.0.0.1', family: 4 }]);
  const h = harness(async (hooks, win, phase) => {
    if (phase !== 'load') return;
    for (const webContentsId of [undefined, -1, 99999]) {
      const result = await new Promise((resolve) => hooks.onBeforeRequest({ webContentsId, url: 'http://private.test/sw' }, resolve));
      assert.equal(result.cancel, true);
    }
    hooks.onResponseStarted({ webContentsId: win.webContents.id, url: 'http://private.test' });
  });
  await h.api.fetchPrdFromUrl('http://private.test');
  assert.equal(JSON.stringify(h.lifecycle), JSON.stringify([
    ['proxy', { mode: 'direct' }], ['clear', { storages: ['serviceworkers', 'cachestorage'] }], ['close'],
  ]));
  const late = await new Promise((resolve) => h.hooks.onBeforeRequest({ webContentsId: h.windows[0].webContents.id, url: 'http://private.test/late' }, resolve));
  assert.equal(late.cancel, true);
});

test('隐藏窗口内网入口仍可使用内网子资源和实际私网连接', async (t) => {
  t.mock.method(dns, 'lookup', async () => [{ address: '127.0.0.1', family: 4 }]);
  const h = harness(async (hooks, win, phase) => {
    if (phase !== 'load') return;
    const result = await new Promise((resolve) => hooks.onBeforeRequest({ webContentsId: win.webContents.id, resourceType: 'script', url: 'http://private.test/script' }, resolve));
    assert.notEqual(result.cancel, true);
    hooks.onResponseStarted({ webContentsId: win.webContents.id, ip: '127.0.0.1' });
    hooks.onCompleted({ webContentsId: 99999, ip: '127.0.0.1' });
  });
  const result = await h.api.fetchPrdFromUrl('http://private.test');
  assert.match(result.text, /正常需求正文/);
  assert.equal(h.windows[0].stops, 0);
});

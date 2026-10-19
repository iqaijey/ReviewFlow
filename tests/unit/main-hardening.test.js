const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const Module = require('module');
const load = Module._load;
let latestWindow;
let opened;
class Window extends EventEmitter {
  constructor() {
    super(); latestWindow = this;
    this.webContents = new EventEmitter();
    this.webContents.setWindowOpenHandler = (handler) => { this.openHandler = handler; };
  }
  loadFile(file) { this.file = file; }
}
const app = new EventEmitter();
app.whenReady = () => ({ then() {} });
app.getPath = () => '/nonexistent/reviewflow-test';
const electron = { app, BrowserWindow: Window, screen: { getAllDisplays: () => [] },
  shell: { openExternal: async (url) => { opened = url; } } };
Module._load = function (request, ...args) {
  return request === 'electron' ? electron : load.call(this, request, ...args);
};
const main = require('../../main/main');
after(() => { main.stopWatcher(); Module._load = load; });

test('主窗口拒绝 popup，仅 http(s) 外链转系统浏览器，阻止离开 index', async () => {
  main.createWindow();
  assert.deepEqual(latestWindow.openHandler({ url: 'https://example.com' }), { action: 'deny' });
  assert.equal(opened, 'https://example.com');
  latestWindow.openHandler({ url: 'file:///etc/passwd' });
  assert.equal(opened, 'https://example.com');
  let blocked = false;
  latestWindow.webContents.emit('will-navigate', { preventDefault() { blocked = true; } }, 'https://evil.test');
  assert.ok(blocked);
  blocked = false;
  latestWindow.webContents.emit('will-navigate', { preventDefault() { blocked = true; } }, require('url').pathToFileURL(latestWindow.file).href + '#settings');
  assert.equal(blocked, false);
});

test('watcher error 关闭监听，5 秒仅重试一次且不记录路径', (t) => {
  t.mock.timers.enable(['setTimeout']);
  let calls = 0;
  let closed = 0;
  const watchers = [];
  t.mock.method(fs, 'watch', () => {
    calls++;
    const watcher = new EventEmitter(); watcher.close = () => { closed++; };
    watchers.push(watcher); return watcher;
  });
  const warnings = [];
  t.mock.method(console, 'warn', (message) => warnings.push(message));
  main.startWatcher('/private/user-content', { isDestroyed: () => false });
  watchers[0].emit('error', new Error('private path'));
  assert.equal(closed, 1);
  t.mock.timers.tick(4999); assert.equal(calls, 1);
  t.mock.timers.tick(1); assert.equal(calls, 2);
  watchers[1].emit('error', new Error('second'));
  t.mock.timers.tick(10000); assert.equal(calls, 2);
  assert.ok(warnings.every((line) => !line.includes('private')));
});

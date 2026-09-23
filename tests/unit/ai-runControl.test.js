const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const state = require('../../main/ai/state');
const runControl = require('../../main/ai/runControl');

// state 是共享可变单例，每个用例后复位，避免互相污染
afterEach(() => {
  state.currentRun = null;
  state.pauseRequested = false;
  state.pausedState = null;
  state.batchRunActive = false;
  state.currentCancel = null;
  state.chunkSender = null;
});

// ---------- getCurrentRun ----------

test('getCurrentRun 无运行无暂停返回 null', () => {
  assert.strictEqual(runControl.getCurrentRun(), null);
});

test('getCurrentRun 有 currentRun 时优先返回 currentRun', () => {
  const run = { kind: 'overview', batch: '第 1/3 批' };
  state.currentRun = run;
  state.pausedState = { kind: 'overview', nextIndex: 1, batches: [1, 2, 3], pausedAt: 123 };
  assert.strictEqual(runControl.getCurrentRun(), run);
});

test('getCurrentRun 仅暂停时返回暂停态摘要', () => {
  state.pausedState = { kind: 'review', nextIndex: 2, batches: ['a', 'b', 'c'], pausedAt: 999 };
  const cur = runControl.getCurrentRun();
  assert.strictEqual(cur.paused, true);
  assert.strictEqual(cur.kind, 'review');
  assert.strictEqual(cur.batch, '已暂停，第 2/3 批');
  assert.strictEqual(cur.batchIndex, 2);
  assert.strictEqual(cur.batchTotal, 3);
  assert.strictEqual(cur.startedAt, 999);
});

// ---------- pauseRun ----------

test('pauseRun 置位 pauseRequested，返回 batchRunActive', () => {
  assert.strictEqual(state.pauseRequested, false);
  state.batchRunActive = true;
  assert.strictEqual(runControl.pauseRun(), true);
  assert.strictEqual(state.pauseRequested, true);

  state.batchRunActive = false;
  state.pauseRequested = false;
  assert.strictEqual(runControl.pauseRun(), false);
  assert.strictEqual(state.pauseRequested, true);
});

// ---------- cancelRun ----------

test('cancelRun 无取消句柄时返回 false，并清掉暂停状态', () => {
  state.pausedState = { kind: 'review', nextIndex: 1, batches: [], pausedAt: 1 };
  state.pauseRequested = true;
  assert.strictEqual(runControl.cancelRun(), false);
  assert.strictEqual(state.pausedState, null);
  assert.strictEqual(state.pauseRequested, false);
});

test('cancelRun 调用取消句柄并置空，返回 true', () => {
  let called = 0;
  state.currentCancel = () => { called += 1; };
  assert.strictEqual(runControl.cancelRun(), true);
  assert.strictEqual(called, 1);
  assert.strictEqual(state.currentCancel, null);
  // 第二次调用无句柄
  assert.strictEqual(runControl.cancelRun(), false);
});

// ---------- 其余小函数 ----------

test('setChunkSender 只接受函数', () => {
  const fn = () => {};
  runControl.setChunkSender(fn);
  assert.strictEqual(state.chunkSender, fn);
  runControl.setChunkSender('not-fn');
  assert.strictEqual(state.chunkSender, null);
});

test('cancelledError 带 cancelled 标记', () => {
  const err = runControl.cancelledError();
  assert.ok(err instanceof Error);
  assert.strictEqual(err.message, '已被用户终止');
  assert.strictEqual(err.cancelled, true);
});

test('timeoutMs 默认 10 分钟，非法值回退默认', () => {
  assert.strictEqual(runControl.timeoutMs({}), 10 * 60_000);
  assert.strictEqual(runControl.timeoutMs(null), 10 * 60_000);
  assert.strictEqual(runControl.timeoutMs({ timeoutMin: 5 }), 5 * 60_000);
  assert.strictEqual(runControl.timeoutMs({ timeoutMin: 0 }), 10 * 60_000);
  assert.strictEqual(runControl.timeoutMs({ timeoutMin: -3 }), 10 * 60_000);
  assert.strictEqual(runControl.timeoutMs({ timeoutMin: 'abc' }), 10 * 60_000);
});

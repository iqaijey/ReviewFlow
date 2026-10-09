const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const state = require('../../main/ai/state');
const runControl = require('../../main/ai/runControl');

// state.lanes 是共享可变 Map，每个用例后清空，避免互相污染
afterEach(() => {
  state.lanes.clear();
  state.chunkSender = null;
});

// ---------- ensureRunId / ensureLane ----------

test('ensureRunId 沿用传入的非空 id，缺省时生成唯一 id', () => {
  assert.strictEqual(runControl.ensureRunId('run-a'), 'run-a');
  const a = runControl.ensureRunId(null);
  const b = runControl.ensureRunId(undefined);
  assert.ok(a && b && a !== b);
});

test('ensureRunId 传入 id 与活跃跑道冲突时生成新 id', () => {
  runControl.ensureLane('run-x');
  const id = runControl.ensureRunId('run-x');
  assert.notStrictEqual(id, 'run-x');
  assert.ok(id.startsWith('run-x-'));
});

test('ensureLane 幂等返回同一跑道', () => {
  const a = runControl.ensureLane('r1');
  const b = runControl.ensureLane('r1');
  assert.strictEqual(a, b);
  assert.strictEqual(a.currentRun, null);
  assert.strictEqual(a.batchRunActive, false);
});

// ---------- getRuns / getCurrentRun ----------

test('getRuns 无跑道时返回空数组，getCurrentRun 返回 null', () => {
  assert.deepStrictEqual(runControl.getRuns(), []);
  assert.strictEqual(runControl.getCurrentRun(), null);
});

test('getRuns 返回各跑道运行态并携带 runId，最近活跃在前', async () => {
  const lane1 = runControl.ensureLane('r1');
  lane1.currentRun = { kind: '整体分析', batch: '（第 1/3 批）' };
  const lane2 = runControl.ensureLane('r2');
  lane2.currentRun = { kind: '逐文件分析', batch: 'a.js' };
  // 让 r1 的 lastActive 更早
  lane1.lastActive = Date.now() - 1000;
  const runs = runControl.getRuns();
  assert.strictEqual(runs.length, 2);
  assert.strictEqual(runs[0].runId, 'r2');
  assert.strictEqual(runs[1].runId, 'r1');
  assert.strictEqual(runs[0].kind, '逐文件分析');
});

test('getCurrentRun 兼容：返回最近活跃的一条运行', () => {
  const lane = runControl.ensureLane('r1');
  lane.currentRun = { kind: 'overview' };
  const cur = runControl.getCurrentRun();
  assert.strictEqual(cur.kind, 'overview');
  assert.strictEqual(cur.runId, 'r1');
});

test('getRuns 暂停跑道返回暂停态摘要', () => {
  const lane = runControl.ensureLane('r1');
  lane.pausedState = { kind: 'review', nextIndex: 2, batches: ['a', 'b', 'c'], pausedAt: 999 };
  const runs = runControl.getRuns();
  assert.strictEqual(runs.length, 1);
  assert.strictEqual(runs[0].paused, true);
  assert.strictEqual(runs[0].runId, 'r1');
  assert.strictEqual(runs[0].batch, '已暂停，第 2/3 批');
  assert.strictEqual(runs[0].batchIndex, 2);
  assert.strictEqual(runs[0].batchTotal, 3);
  assert.strictEqual(runs[0].startedAt, 999);
});

test('getRuns 分批间隙返回占位运行态', () => {
  const lane = runControl.ensureLane('r1');
  lane.batchRunActive = true;
  const runs = runControl.getRuns();
  assert.strictEqual(runs.length, 1);
  assert.strictEqual(runs[0].kind, '分批运行');
  assert.strictEqual(runs[0].runId, 'r1');
});

// ---------- pauseRun ----------

test('pauseRun(runId) 只置位对应跑道，返回其 batchRunActive', () => {
  const a = runControl.ensureLane('r1');
  const b = runControl.ensureLane('r2');
  a.batchRunActive = true;
  assert.strictEqual(runControl.pauseRun('r1'), true);
  assert.strictEqual(a.pauseRequested, true);
  assert.strictEqual(b.pauseRequested, false);
  assert.strictEqual(runControl.pauseRun('r2'), false);
  assert.strictEqual(b.pauseRequested, true);
});

test('pauseRun 未知 runId 返回 false；无参回退到最近活跃跑道', () => {
  assert.strictEqual(runControl.pauseRun('nope'), false);
  const lane = runControl.ensureLane('r1');
  lane.batchRunActive = true;
  assert.strictEqual(runControl.pauseRun(), true);
  assert.strictEqual(lane.pauseRequested, true);
});

// ---------- cancelRun ----------

test('cancelRun 无取消句柄时返回 false，并清掉该跑道暂停状态', () => {
  const lane = runControl.ensureLane('r1');
  lane.pausedState = { kind: 'review', nextIndex: 1, batches: [], pausedAt: 1 };
  lane.pauseRequested = true;
  assert.strictEqual(runControl.cancelRun('r1'), false);
  assert.strictEqual(lane.pausedState, null);
  assert.strictEqual(lane.pauseRequested, false);
});

test('cancelRun 调用对应跑道取消句柄并置空，跑道互不影响', () => {
  let called1 = 0;
  let called2 = 0;
  const a = runControl.ensureLane('r1');
  const b = runControl.ensureLane('r2');
  a.currentCancel = () => { called1 += 1; };
  b.currentCancel = () => { called2 += 1; };
  assert.strictEqual(runControl.cancelRun('r1'), true);
  assert.strictEqual(called1, 1);
  assert.strictEqual(called2, 0);
  assert.strictEqual(a.currentCancel, null);
  assert.notStrictEqual(b.currentCancel, null);
  // 第二次调用无句柄
  assert.strictEqual(runControl.cancelRun('r1'), false);
});

test('cancelRun 未知 runId 返回 false', () => {
  assert.strictEqual(runControl.cancelRun('nope'), false);
});

// ---------- maybeCleanupLane ----------

test('maybeCleanupLane 回收完全空闲的跑道，活跃跑道保留', () => {
  runControl.ensureLane('idle');
  runControl.maybeCleanupLane('idle');
  assert.strictEqual(state.lanes.has('idle'), false);
  const busy = runControl.ensureLane('busy');
  busy.batchRunActive = true;
  runControl.maybeCleanupLane('busy');
  assert.strictEqual(state.lanes.has('busy'), true);
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

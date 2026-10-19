const { test } = require('node:test');
const assert = require('node:assert/strict');
const { completeReview } = require('../../main/reviewLifecycle');
function memoryStore() {
  const history = [], checklist = [];
  return { history, checklist, listReviews: () => history, listChecklist: () => checklist,
    saveChecklist: (folder, items) => { checklist.splice(0, checklist.length, ...items); return items; },
    saveReview: (entry) => { const index = history.findIndex((e) => e.id === entry.id); if (index < 0) history.push(entry); else history[index] = entry; return entry; } };
}
const context = { parent: true, folder: '/test', reviewId: 'logical-id', title: '标题', kind: 'overview', historyKind: 'review', files: [], captured: [], noiseLevel: 'quiet' };
test('解析失败告知覆盖范围且保留原问题，通知写入历史', () => {
  const store = memoryStore();
  store.checklist.push(require('../../main/findings').normalizeFinding({ id: 'keep', text: '原问题', status: 'partial' }));
  const before = structuredClone(store.checklist);
  const result = completeReview({ markdown: '无法解析的报告', stats: null, coverageNotices: ['截断通知'] }, { ...context }, store);
  assert.deepEqual(store.checklist, before);
  assert.match(result.coverageNotices[1], /未能.*解析/);
  assert.deepEqual(result.historyEntry.coverageNotices, result.coverageNotices);
});
test('同逻辑运行重复交付仅一个历史，快照不因后续人工编辑改变', () => {
  const store = memoryStore(), result = { markdown: '## 问题清单\n- [高][正确性] @? | 崩溃', stats: null };
  const runContext = { ...context };
  let saves = 0;
  const save = store.saveReview;
  store.saveReview = (entry) => { saves++; return save(entry); };
  const first = completeReview(result, runContext, store);
  store.checklist[0].status = 'fixed';
  const second = completeReview(result, runContext, store);
  assert.equal(saves, 1);
  assert.equal(store.history.length, 1);
  assert.equal(second.reviewId, 'logical-id');
  assert.equal(second.historyEntry.findings[0].status, 'pending');
  assert.equal(first.historyEntry.noiseLevel, 'quiet');
});
test('暂停、失败与子运行不创建历史', () => {
  const store = memoryStore();
  for (const result of [{ markdown: '部分', paused: true }, { markdown: '失败', failed: {} }]) assert.equal(completeReview(result, context, store), result);
  completeReview({ markdown: '子运行' }, { ...context, parent: false }, store);
  assert.equal(store.history.length, 0);
});
test('存储失败保留 AI 成功结果和单独警告', () => {
  const store = memoryStore();
  store.saveChecklist = () => { throw new Error('磁盘满'); };
  store.saveReview = () => { throw new Error('磁盘满'); };
  const result = completeReview({ markdown: '## 问题清单\n- 问题', stats: null }, context, store);
  assert.equal(result.markdown, '## 问题清单\n- 问题');
  assert.equal(result.persistenceWarnings.length, 2);
  assert.equal(result.historyEntry, null);
});

test('来源与原始模型结果持久化，资源文件和未评审文件不标记 reviewed', () => {
  const snapshots = require('../../main/reviewSnapshot');
  const files = [{ path: 'a.js', status: 'deleted', hunks: [] }, { path: 'b.png', status: 'added', resource: true, hunks: [] }, { path: 'c.js', status: 'modified', hunks: [] }];
  const { snapshotId, ...provenance } = snapshots.buildSnapshot(files, null);
  const raw = [{ slotId: 'fallback', role: 'synthesizer', backend: 'codex', model: 'test', effort: 'high', outcome: 'complete', markdown: '原始', error: null, stats: null }];
  const result = completeReview({ markdown: '报告', stats: null }, { ...context, files: [files[0]], provenance, historyPerModel: raw }, memoryStore());
  assert.deepEqual(result.historyEntry.provenance.files.map((f) => f.reviewed), [true, false, false]);
  assert.deepEqual(provenance.files.map((f) => f.reviewed), [false, false, false]);
  assert.deepEqual(result.historyEntry.perModel, raw);
});

test('持久化失败可重试完成边界，不重新调用模型', () => {
  const store = memoryStore(), runContext = { ...context };
  const save = store.saveReview;
  let modelCalls = 0;
  const modelResult = (() => { modelCalls++; return { markdown: '成功', stats: null }; })();
  store.saveReview = () => { throw new Error('只读磁盘'); };
  assert.equal(completeReview(modelResult, runContext, store).historyEntry, null);
  store.saveReview = save;
  assert.ok(completeReview(modelResult, runContext, store).historyEntry);
  assert.equal(modelCalls, 1);
  assert.equal(store.history.length, 1);
});

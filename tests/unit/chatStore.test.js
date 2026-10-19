const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-chats-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const chats = require('../../main/chatStore');
const store = chats.createChatStore({ root: () => root });
const context = { codeContext: 'captured', planContext: 'old-plan', projectRulesText: 'old-rules', initialMarkdown: 'answer' };

test('thread round trip and summaries exclude captured inputs', () => {
  const thread = store.create({ folder: '/round', kind: 'line', context });
  assert.deepEqual(store.get({ folder: '/round', id: thread.id }), thread);
  const [summary] = store.list({ folder: '/round' });
  assert.equal(summary.id, thread.id);
  assert.equal('context' in summary, false);
  assert.equal('messages' in summary, false);
  assert.throws(() => store.get({ folder: '/round', id: '../bad' }), /会话/);
  assert.equal(store.get({ folder: '/other', id: thread.id }), null);
});

test('pending becomes interrupted after restart but not while active', () => {
  const thread = store.create({ folder: '/restart', kind: 'line', context });
  store.beginExchange('/restart', thread.id, { question: 'q', requestId: 'r' });
  assert.equal(store.get({ folder: '/restart', id: thread.id }).messages[1].status, 'pending');
  const restarted = chats.createChatStore({ root: () => root });
  assert.equal(restarted.get({ folder: '/restart', id: thread.id }).messages[1].status, 'interrupted');
});

test('UTF-8 context cap includes serialized selection and never splits characters', () => {
  const thread = store.create({ folder: '/cap', kind: 'line', context: { ...context, codeContext: '中😀'.repeat(50000) } });
  assert.equal(thread.context.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(thread.context)) <= 128 * 1024);
  assert.equal(thread.context.codeContext.includes('\ufffd'), false);
});

test('100 exchanges are retained and make thread read only', () => {
  const thread = store.create({ folder: '/exchanges', kind: 'line', context });
  for (let i = 0; i < 100; i++) {
    store.beginExchange('/exchanges', thread.id, { question: `q${i}`, requestId: `r${i}` });
    store.finishExchange('/exchanges', thread.id, { requestId: `r${i}`, status: 'complete', content: 'a', stats: null });
  }
  assert.equal(store.get({ folder: '/exchanges', id: thread.id }).messages.length, 200);
  assert.throws(() => store.beginExchange('/exchanges', thread.id, { question: 'q', requestId: 'overflow' }), /100/);
});

test('standalone retention keeps newest 100 without removing report-linked threads', () => {
  const linked = store.create({ folder: '/retention', kind: 'review', reviewId: 'parent', context });
  const first = store.create({ folder: '/retention', kind: 'line', context });
  for (let i = 0; i < 100; i++) store.create({ folder: '/retention', kind: 'line', context });
  assert.equal(store.list({ folder: '/retention' }).length, 101);
  assert.equal(store.get({ folder: '/retention', id: first.id }), null);
  assert.ok(store.get({ folder: '/retention', id: linked.id }));
});

test('report reuse keyed by parent and section, all conversation kinds survive restart', () => {
  for (const [kind, sectionTitle] of [['review', null], ['review-section', '安全'], ['full', 'full']]) {
    const thread = store.create({ folder: '/kinds', kind, reviewId: 'parent', sectionTitle, context });
    assert.equal(store.create({ folder: '/kinds', kind, reviewId: 'parent', sectionTitle, context }).id, thread.id);
    assert.equal(chats.createChatStore({ root: () => root }).get({ folder: '/kinds', id: thread.id }).kind, kind);
  }
  assert.deepEqual(store.deleteLinked('/kinds', 'parent'), []);
  assert.equal(store.list({ folder: '/kinds' }).length, 0);
});

test('line selection restored by index even with identical line content', () => {
  const { captureExplainSelection, buildIndexedExplainContext } = require('../../main/ai/prompts');
  const hunk = { header: '@@ -1 +1 @@', lines: [{ type: 'add', content: 'same', newLine: 1 }, { type: 'add', content: 'same', newLine: 2 }] };
  const selection = captureExplainSelection({ filePath: '中文.js', hunk, line: hunk.lines[1] });
  const thread = store.create({ folder: '/selection', kind: 'line', context: { ...context, selection } });
  const restored = store.get({ folder: '/selection', id: thread.id });
  assert.deepEqual(restored.context.selection[0].selectedLineIndexes, [1]);
  assert.equal(buildIndexedExplainContext(restored.context.selection).context.split('\n').filter((line) => line.startsWith('>')).length, 1);
  assert.ok(buildIndexedExplainContext(restored.context.selection).context.includes('>+2 same'));
});

test('folder mismatch and invalid JSON containers are not overwritten', () => {
  const thread = store.create({ folder: '/validation', kind: 'line', context });
  const file = path.join(root, 'review-chats', require('../../main/reviewSnapshot').hash('/validation'), `${thread.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...thread, folder: '/wrong' }));
  assert.throws(() => store.get({ folder: '/validation', id: thread.id }), /项目路径/);
  assert.equal(JSON.parse(fs.readFileSync(file)).folder, '/wrong');
});

test('history deletion and retention eviction remove linked threads', () => {
  const original = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return { app: { getPath: () => root } };
    return original.call(this, request, ...rest);
  };
  try {
    const history = require('../../main/store');
    const entry = history.saveReview({ folder: '/history', markdown: 'report' });
    const thread = chats.create({ folder: '/history', reviewId: entry.id, kind: 'review', context });
    history.deleteReview({ folder: '/history', id: entry.id });
    assert.equal(chats.get({ folder: '/history', id: thread.id }), null);
    const oldest = history.saveReview({ folder: '/evict', markdown: 'old' });
    const linked = chats.create({ folder: '/evict', reviewId: oldest.id, kind: 'review', context });
    for (let i = 0; i < 20; i++) history.saveReview({ folder: '/evict', markdown: `new${i}` });
    assert.equal(chats.get({ folder: '/evict', id: linked.id }), null);
  } finally { Module._load = original; }
});

test('child cleanup failures are returned as visible warnings', () => {
  const thread = store.create({ folder: '/cleanup-warning', reviewId: 'parent', kind: 'review', context });
  const file = path.join(root, 'review-chats', require('../../main/reviewSnapshot').hash('/cleanup-warning'), `${thread.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...thread, folder: '/wrong' }));
  assert.match(store.deleteLinked('/cleanup-warning', 'parent')[0], /清理失败/);
});

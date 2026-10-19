const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const vm = require('vm');
const { createRequire } = require('module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-chat-service-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const store = require('../../main/chatStore').createChatStore({ root: () => root });
const { createChatService } = require('../../main/chatService');
const context = { codeContext: 'frozen-code', planContext: 'frozen-plan', projectRulesText: 'frozen-rules', initialMarkdown: 'initial' };

test('captured context and initial result are used, requestId is idempotent', async () => {
  const thread = store.create({ folder: '/old', kind: 'line', context });
  let calls = 0;
  const service = createChatService({ store, callAI: async (messages, options) => {
    calls++;
    assert.equal(options.folder, '/old');
    const pending = store.get({ folder: '/old', id: thread.id }).messages;
    assert.deepEqual(pending.map((m) => m.status), ['complete', 'pending']);
    assert.ok(messages.some((m) => m.content.includes('frozen-code')));
    assert.ok(messages.some((m) => m.content.includes('frozen-plan')));
    assert.ok(messages.some((m) => m.content.includes('frozen-rules')));
    assert.ok(messages.some((m) => m.role === 'assistant' && m.content === 'initial'));
    return { content: 'completed', stats: { model: 'fake' } };
  } });
  const payload = { folder: '/old', threadId: thread.id, requestId: 'once', question: 'q', runId: 'run' };
  assert.equal((await service.send(payload)).markdown, 'completed');
  assert.equal((await service.send(payload)).markdown, 'completed');
  assert.equal(calls, 1);
});

test('concurrent duplicate returns pending, different request rejected, project switch does not lose answer', async () => {
  const thread = store.create({ folder: '/origin', kind: 'line', context });
  let resolve;
  const response = new Promise((done) => { resolve = done; });
  const service = createChatService({ store, callAI: () => response });
  const payload = { folder: '/origin', threadId: thread.id, requestId: 'r', question: 'q', runId: 'run' };
  const first = service.send(payload);
  assert.equal((await service.send(payload)).thread.messages[1].status, 'pending');
  await assert.rejects(service.send({ ...payload, requestId: 'other' }), /正在/);
  store.list({ folder: '/switched-project' });
  resolve({ content: 'late response', stats: null });
  await first;
  assert.equal(store.get({ folder: '/origin', id: thread.id }).messages[1].content, 'late response');
});

test('cancelled and failed sends persist status and do not replay', async () => {
  for (const cancelled of [true, false]) {
    const thread = store.create({ folder: '/fail', kind: 'line', context });
    let calls = 0;
    const service = createChatService({ store, callAI: async () => { calls++; throw Object.assign(new Error('failure'), { cancelled }); } });
    const payload = { folder: '/fail', threadId: thread.id, requestId: 'r', question: 'q', runId: 'run' };
    const result = await service.send(payload);
    assert.equal(result.thread.messages[1].status, cancelled ? 'cancelled' : 'failed');
    await service.send(payload);
    assert.equal(calls, 1);
  }
});

test('only latest 10 completed exchanges are sent, all stored exchanges remain', async () => {
  const thread = store.create({ folder: '/window', kind: 'line', context });
  for (let i = 0; i < 12; i++) {
    store.beginExchange('/window', thread.id, { question: `q${i}`, requestId: `r${i}` });
    store.finishExchange('/window', thread.id, { requestId: `r${i}`, status: i === 5 ? 'failed' : 'complete', content: `a${i}`, stats: null });
  }
  const service = createChatService({ store, callAI: async (messages) => {
    assert.equal(messages.length, 24);
    assert.equal(messages[3].content, 'q1');
    assert.equal(messages.some((m) => m.content === 'q5'), false);
    assert.equal(messages[2].content, 'initial');
    return { content: 'new', stats: null };
  } });
  const result = await service.send({ folder: '/window', threadId: thread.id, question: 'new-q', requestId: 'new', runId: 'run' });
  assert.equal(result.thread.messages.length, 26);
});

test('lazy report and section threads use frozen history inputs after live files change', () => {
  const original = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return { app: { getPath: () => root } };
    return original.call(this, request, ...rest);
  };
  try {
    const { completeReview } = require('../../main/reviewLifecycle');
    const runContext = { parent: true, folder: '/frozen', reviewId: 'frozen', kind: 'full', files: [],
      batches: [['captured-before-run']], rules: { text: 'rules-before-run' }, planContext: 'plan-before-run' };
    completeReview({ markdown: 'initial-report', stats: null }, runContext);
    runContext.batches[0][0] = 'live-diff';
    runContext.rules.text = 'live-rules';
    runContext.planContext = 'live-plan';
    const service = createChatService({ store });
    const thread = service.create({ folder: '/frozen', reviewId: 'frozen' });
    assert.equal(thread.kind, 'full');
    assert.equal(thread.context.codeContext, 'captured-before-run');
    assert.equal(thread.context.projectRulesText, 'rules-before-run');
    assert.equal(thread.context.planContext, 'plan-before-run');
    assert.equal(service.create({ folder: '/frozen', reviewId: 'frozen' }).id, thread.id);
    const section = service.create({ folder: '/frozen', reviewId: 'frozen', sectionTitle: '安全' });
    assert.equal(section.kind, 'review-section');
    assert.equal(section.context.initialMarkdown, 'initial-report');
    assert.notEqual(section.id, thread.id);
  } finally { Module._load = original; }
});

test('real AI plumbing preserves runId, cancellation and creates line thread after explanation', async () => {
  const filename = require.resolve('../../main/ai');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const control = require('../../main/ai/runControl');
  let cancel = false;
  const replacements = {
    './settings': { getSettings: async () => ({ backend: 'api', model: 'fake', baseUrl: 'https://example.test', apiKey: 'secret' }) },
    './chatStore': store,
    './ai/backends': { chatViaApi: async (cfg, messages, options) => {
      assert.equal(control.getRuns().some((run) => run.runId === options.runId), true);
      if (cancel) control.cancelRun(options.runId);
      return { content: 'initial-explanation', usage: {}, appliedEffort: '' };
    } },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: (id) => replacements[id] || localRequire(id), module, Date, AbortSignal, fetch, structuredClone }, { filename });
  const ai = module.exports;
  const hunk = { header: '@@', lines: [{ type: 'add', newLine: 1, content: 'value' }] };
  const response = await ai.explainChange({ folder: '/line-ai', filePath: 'a.js', hunk, line: hunk.lines[0], runId: 'initial-run' });
  const thread = store.get({ folder: '/line-ai', id: response.threadId });
  assert.equal(thread.context.initialMarkdown, response.markdown);
  assert.deepEqual(thread.context.selection[0].selectedLineIndexes, [0]);
  cancel = true;
  const service = createChatService({ store, callAI: (messages, options) => ai.chatWithStats(null, messages, { ...options, stream: true }) });
  const result = await service.send({ folder: '/line-ai', threadId: thread.id, question: 'q', requestId: 'cancel', runId: 'cancel-run' });
  assert.equal(result.thread.messages[1].status, 'cancelled');
  assert.equal(control.getRuns().some((run) => run.runId === 'cancel-run'), false);
});

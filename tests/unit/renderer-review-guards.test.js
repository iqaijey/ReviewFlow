const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const url = (source) => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const source = (name) => fs.readFileSync(path.join(__dirname, '../../renderer/', name), 'utf8');
let guards;
before(async () => { guards = await import(url(source('lib/reviewGuards.js'))); });

test('显式解析先挂载可见 tab，再且仅派发一次请求，不回放旧选区', () => {
  for (const mounted of [false, true]) {
    const detail = { segments: [{ lines: ['selected'] }] };
    const state = { selectedLine: detail };
    let active = false;
    let requests = 0;
    guards.routeExplainRequest(state, () => {
      active = true;
      if (!mounted && state.selectedLine) requests++;
    }, (selected) => {
      assert.equal(active, true);
      assert.equal(selected, detail);
      requests++;
    }, detail);
    assert.equal(requests, 1);
    assert.equal(state.selectedLine, detail);
  }
});

test('上次整体评审按 createdAt 取最新可用正文，忽略置顶和完整讲解', () => {
  const pinned = { kind: 'review', createdAt: 10, pinned: true, markdown: 'old' };
  const latest = { kind: 'review', createdAt: 30, markdown: 'new' };
  const entries = [pinned, { kind: 'full', createdAt: 90, markdown: 'full' },
    { kind: 'review', createdAt: 80, markdown: '  ' }, latest,
    { kind: 'file', createdAt: 70, markdown: 'file' }];
  assert.equal(guards.newestOverallReview(entries), latest);
  assert.equal(entries[0], pinned);
  assert.equal(guards.newestOverallReview([]), null);
});

function el(tag, attrs = {}, children = []) {
  const node = new EventTarget();
  Object.assign(node, {
    tagName: tag.toUpperCase(), style: {}, dataset: attrs.dataset || {}, hidden: false,
    children: [], parentNode: null, disabled: false, value: '', _text: '',
    setAttribute(key, value) { this[key] = value; },
    removeAttribute(key) { delete this[key]; },
    appendChild(child) { child.remove?.(); this.children.push(child); child.parentNode = this; return child; },
    append(...items) { items.forEach((item) => this.appendChild(item)); },
    remove() {
      if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
      this.parentNode = null;
    },
    contains(child) { return this === child || this.children.some((item) => item.contains?.(child)); },
     querySelectorAll() { return []; }, focus() { if (globalThis.document) globalThis.document.activeElement = this; },
  });
  const classes = new Set((attrs.class || '').split(' '));
  node.classList = { add: (c) => classes.add(c), remove: (c) => classes.delete(c),
    contains: (c) => classes.has(c), toggle: (c, on) => on ? classes.add(c) : classes.delete(c) };
  Object.defineProperties(node, {
    textContent: { get() { return this._text + this.children.map((c) => c.textContent || '').join(''); },
      set(value) { this._text = value; this.children.forEach((c) => { c.parentNode = null; }); this.children = []; } },
    firstChild: { get() { return this.children[0] || null; } },
    innerHTML: { set(value) { this.textContent = value; }, get() { return this.textContent; } },
  });
  if (attrs.onClick) node.addEventListener('click', attrs.onClick);
  node._text = typeof children === 'string' ? children : '';
  return node;
}

const event = (name, detail) => new CustomEvent(name, { detail });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test('解析失效立即清理订阅，旧请求 finally 不清理新请求', async () => {
  const resources = { statuses: 0, streams: 0 };
  globalThis.__rendererResources = resources;
  const statusStub = url(`export function createRunStatus({el}) {
    globalThis.__rendererResources.statuses++;
    let done = false;
    return {root: el('div'), dispose() { if (!done) { done = true; globalThis.__rendererResources.statuses--; } }};
  }`);
  const streamStub = url(`export function createStreamPreview({el}) {
    globalThis.__rendererResources.streams++;
    let done = false;
    return {streamBox: el('div'), unsubscribe() { if (!done) { done = true; globalThis.__rendererResources.streams--; } }};
  }`);
  const sharedStub = url('export const formatStats = () => ""; export const loadPlanContext = async () => null; export const copyMarkdown = () => {};');
  const code = source('tabs/explain.js')
    .replace('../lib/aiShared.js', sharedStub)
    .replace('../lib/statusBox.js', url('export function setStatusBox(box, node) { box.textContent = ""; if (node) box.appendChild(node); }'))
    .replace('../markdown.js', url('export const renderMarkdown = (text) => text;'))
    .replace('../lib/chatView.js', url('export const createChatView = () => ({});'))
    .replace('../lib/runStatus.js', statusStub).replace('../lib/streamPreview.js', streamStub);
  const { default: tab } = await import(url(code));
  const requests = [];
  const bus = new EventTarget();
  const state = { folder: '/A', selectedLine: null };
  const ctx = { el, bus, state, api: {
    cancelRun: async () => {},
    explainChange: () => { const request = deferred(); requests.push(request); return request.promise; },
  }, errText: String, notify() {}, toast() {}, emptyState: (text) => el('div', {}, text) };
  tab.mount(el('div'), ctx);
  const hunk = { header: '@@', lines: [{ content: 'line', newLine: 1, type: 'add' }] };
  const detail = { file: { path: 'file.js', hunks: [hunk] }, hunkIndex: 0, line: hunk.lines[0] };
  bus.dispatchEvent(event('line:select', detail));
  await tick();
  assert.deepEqual(resources, { statuses: 1, streams: 1 });
  bus.dispatchEvent(event('explain:invalidate'));
  assert.deepEqual(resources, { statuses: 0, streams: 0 });
  bus.dispatchEvent(event('line:select', detail));
  await tick();
  requests[0].resolve({ markdown: 'stale' });
  await tick();
  assert.deepEqual(resources, { statuses: 1, streams: 1 });
  state.folder = '/B';
  bus.dispatchEvent(event('project:changed'));
  assert.deepEqual(resources, { statuses: 0, streams: 0 });
  requests[1].resolve({ markdown: 'stale too' });
  await tick();
  assert.deepEqual(resources, { statuses: 0, streams: 0 });
  delete globalThis.__rendererResources;
});

test('coverageNotices 作为结果上方的内联 notice 保留', () => {
  const host = el('div');
  guards.renderCoverageNotices(el, host, ['文件被截断', '部分模型未完成']);
  assert.equal(host.hidden, false);
  assert.match(host.textContent, /文件被截断.*部分模型未完成/);
  guards.renderCoverageNotices(el, host, []);
  assert.equal(host.hidden, true);
});

function descendants(node) {
  return [node, ...node.children.flatMap(descendants)];
}

test('聊天重新生成使用同一问题和新 ID，保留旧回答且拒绝跨项目发送', async () => {
  const code = source('lib/chatView.js')
    .replace('./aiShared.js', url('export const formatStoredStats = () => ""; export const copyMarkdown = () => {};'))
    .replace('../markdown.js', url('export const renderMarkdown = (text) => text;'))
    .replace('./runStatus.js', url('export const createRunStatus = ({el}) => ({root: el("div"), dispose() {}});'))
    .replace('./streamPreview.js', url('export const createStreamPreview = ({el}) => ({streamBox: el("div"), unsubscribe() {}});'));
  const { createChatView } = await import(url(code));
  const oldDocument = globalThis.document;
  globalThis.document = { contains: () => false };
  let folder = '/A';
  const bus = new EventTarget();
  const requests = [];
  const thread = { id: 'thread-A', context: {}, messages: [
    { id: 'q1', requestId: 'old', role: 'user', content: '同一个问题', status: 'complete' },
    { id: 'a1', requestId: 'old', role: 'assistant', content: '旧回答', status: 'complete' },
  ] };
  try {
    const view = createChatView({ el, bus, getFolder: () => folder, originFolder: '/A', thread,
      api: { sendChatMessage: async (payload) => {
        requests.push(payload);
        return { thread: { ...thread, messages: [...thread.messages,
          { id: 'q2', requestId: payload.requestId, role: 'user', content: payload.question, status: 'complete' },
          { id: 'a2', requestId: payload.requestId, role: 'assistant', content: '新回答', status: 'complete' },
        ] } };
      } } });
    const regen = descendants(view.root).find((node) => node.classList.contains('chat-regenerate-btn'));
    assert.ok(regen);
    regen.dispatchEvent(new Event('click'));
    await tick();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].question, '同一个问题');
    assert.equal(requests[0].folder, '/A');
    assert.notEqual(requests[0].requestId, 'old');
    assert.ok(requests[0].runId);
    assert.match(view.root.textContent, /旧回答.*新回答/);
    assert.equal(descendants(view.root).filter((node) => node.classList.contains('chat-regenerate-btn')).length, 1);
    assert.equal(findClass(view.root, 'chat-regenerate-btn').disabled, false);
    folder = '/B';
    bus.dispatchEvent(event('project:changed'));
    assert.equal(view.root.hidden, true);
    const latestRegen = descendants(view.root).find((node) => node.classList.contains('chat-regenerate-btn'));
    latestRegen.dispatchEvent(new Event('click'));
    await tick();
    assert.equal(requests.length, 1);
  } finally {
    globalThis.document = oldDocument;
  }
});

test('confirmDialog 危险操作默认聚焦取消按钮，普通确认默认聚焦确定按钮', async () => {
  const { confirmDialog, restoreDialogFocus } = await import(url(source('lib/dialog.js')));
  const oldDoc = globalThis.document;
  const oldHTMLElement = globalThis.HTMLElement;
  class FakeElement extends EventTarget {
    constructor(tag) {
      super();
      this.tagName = tag.toUpperCase();
      this.className = '';
      this.id = '';
      this.textContent = '';
      this.type = '';
      this.tabIndex = 0;
      this.children = [];
      this.parentNode = null;
      this.attrs = {};
      this.offsetParent = {};
    }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    hasAttribute(k) { return Object.hasOwn(this.attrs, k); }
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
    remove() {
      if (this.parentNode) {
        this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
        this.parentNode = null;
      }
    }
    contains(n) { return this === n || this.children.some((c) => c.contains?.(n)); }
    focus() { globalThis.document.activeElement = this; }
    querySelectorAll() { return []; }
  }
  const body = new FakeElement('body');
  globalThis.HTMLElement = FakeElement;
  globalThis.document = {
    body,
    activeElement: body,
    createElement: (tag) => new FakeElement(tag),
    contains: (n) => body.contains(n),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  try {
    const pDanger = confirmDialog({ message: '删除？', danger: true });
    assert.equal(globalThis.document.activeElement.textContent, '取消');
    globalThis.document.activeElement.dispatchEvent(new Event('click'));
    assert.equal(await pDanger, false);

    const pSafe = confirmDialog({ message: '继续？', danger: false });
    assert.equal(globalThis.document.activeElement.textContent, '确定');
    globalThis.document.activeElement.dispatchEvent(new Event('click'));
    assert.equal(await pSafe, true);

    const detached = new FakeElement('button');
    const replacement = new FakeElement('button');
    body.appendChild(replacement);
    restoreDialogFocus(detached, () => replacement);
    assert.equal(globalThis.document.activeElement, replacement);
  } finally {
    globalThis.document = oldDoc;
    globalThis.HTMLElement = oldHTMLElement;
  }
});

test('无位置问题渲染为纯文本 span 而非可点击跳转按钮', async () => {
  const sharedUrl = url(source('lib/findingsView/shared.js'));
  const listCode = source('lib/findingsView/list.js').replace('./shared.js', sharedUrl);
  const { createList } = await import(url(listCode));
  const container = el('div');
  const jumps = [];
  const bus = new EventTarget();
  bus.addEventListener('diff:jump', (ev) => jumps.push(ev.detail));
  const list = createList({
    container,
    el,
    bus,
    getFolder: () => '/repo',
    findings: [
      { id: 'f1', status: 'pending', category: '安全', severity: '高', text: '无位置问题', location: null },
      { id: 'f2', status: 'pending', category: '正确性', severity: '中', text: '有位置问题', location: { path: 'a.js', startLine: 10 } },
      ...['pending', 'partial'].map((status) => ({ id: status, status, text: '已撤销',
        verification: { verdict: '已修复', note: '补丁已撤销，需重新复核' } })),
    ],
    suggestions: [],
    selectedIds: new Set(),
    savingIds: new Set(),
    runningOps: new Map(),
    appliedPatches: new Map(),
    findingErrors: new Map(),
    severityFilter: 'all',
    categoryFilter: 'all',
    statusFilter: 'all',
    openHandoffDialog: () => {},
    runGenerateFixPatch: () => {},
    runVerifyFinding: () => {},
    runRevertFixPatch: () => {},
    mutateStatus: () => {},
    openDismissDialog: () => {},
    openRuleAppendDialog: () => {},
  });
  list.render();
  assert.equal(descendants(container).filter((node) => node.classList.contains('finding-verdict-badge')
    && node.textContent === '复核结论已作废：补丁已撤销，需重新复核').length, 2);
  assert.doesNotMatch(container.textContent, /复核：已修复/);
  const allNodes = descendants(container);
  const unknownLoc = allNodes.find((n) => n.classList?.contains('finding-location-unknown'));
  assert.ok(unknownLoc);
  assert.equal(unknownLoc.tagName, 'SPAN');
  assert.equal(unknownLoc.textContent, '位置未知');
  unknownLoc.dispatchEvent(new Event('click'));
  assert.equal(jumps.length, 0);

  const knownLoc = allNodes.find((n) => n.classList?.contains('finding-location') && !n.classList?.contains('finding-location-unknown'));
  assert.ok(knownLoc);
  assert.equal(knownLoc.tagName, 'BUTTON');
  knownLoc.dispatchEvent(new Event('click'));
  assert.equal(jumps.length, 1);
});

test('键盘取消最后一行时先清理 DOM 再同步操作条，Escape 清除残留高亮', async () => {
  const code = source('tabs/overview/lineInteraction.js')
    .replace('../../lib/overviewPerf.js', url('export const computeFileFingerprint = () => "";'));
  const { createLineInteraction } = await import(url(code));
  const oldDocument = globalThis.document;
  const oldWindow = globalThis.window;
  const doc = new EventTarget();
  doc.querySelector = () => null;
  globalThis.document = doc;
  globalThis.window = new EventTarget();
  const selected = el('div', { class: 'line-selected' });
  selected.setAttribute('aria-selected', 'true');
  const calls = [];
  const context = { lastDiffFile: {}, classSel: new Set(), currentSelectedCpos: new Set(),
    pendingSelection: null, diffView: el('div'), searchInput: el('input'), container: el('div'),
    clearLineSelectionDOM() {
      selected.classList.remove('line-selected');
      selected.setAttribute('aria-selected', 'false');
      calls.push('clear');
    }, syncSelectionBar() { calls.push('sync'); },
    clearAllSelection() { this.clearLineSelectionDOM(); this.syncSelectionBar(); },
  };
  context.diffView.querySelector = () => selected.classList.contains('line-selected') ? selected : null;
  try {
    const helper = createLineInteraction(context);
    helper.syncPendingFromSelectedSet();
    assert.deepEqual(calls, ['clear', 'sync']);
    assert.equal(selected.classList.contains('line-selected'), false);
    assert.equal(selected['aria-selected'], 'false');
    selected.classList.add('line-selected');
    const escape = new Event('keydown', { cancelable: true });
    Object.assign(escape, { key: 'Escape' });
    doc.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(selected.classList.contains('line-selected'), false);
  } finally {
    globalThis.document = oldDocument;
    globalThis.window = oldWindow;
  }
});

test('请求 guard 丢弃 A→B 和同项目较旧请求，包括 A→B→A', async () => {
  const { createRequestGuard } = await import(url(source('lib/requestGuard.js')));
  let folder = '/A';
  const guard = createRequestGuard(() => folder);
  const state = { changes: 'B changes' };
  const delayed = deferred();
  const request = guard.begin();
  const apply = delayed.promise.then((value) => { if (request.isCurrent()) state.changes = value; });
  folder = '/B';
  guard.invalidate();
  delayed.resolve('A changes');
  await apply;
  assert.equal(state.changes, 'B changes');
  folder = '/A';
  assert.equal(request.isCurrent(), false);
  const older = guard.begin();
  const newer = guard.begin();
  assert.equal(older.isCurrent(), false);
  assert.equal(newer.isCurrent(), true);
});

test('来源 hold 被替换时唤醒旧等待者，旧 release 不释放新 hold', async () => {
  const { createRequestGuard } = await import(url(source('lib/requestGuard.js')));
  let folder = '/A';
  const guard = createRequestGuard(() => folder);
  const releaseOld = guard.holdSource();
  let awakened = false;
  const waiting = guard.waitForSource().then(() => { awakened = true; });
  folder = '/B';
  const releaseNew = guard.holdSource();
  folder = '/C';
  await tick();
  assert.equal(awakened, true, '不应继续等待已被替换的旧 hold');
  await waiting;
  folder = '/B';
  awakened = false;
  const waitingNew = guard.waitForSource().then(() => { awakened = true; });
  releaseOld();
  await tick();
  assert.equal(awakened, false);
  releaseNew();
  await tick();
  assert.equal(awakened, true);
  await waitingNew;
});

test('旧项目的来源等待在切换后立即退出，不会挂到新项目的未决来源上', async () => {
  const { createRequestGuard } = await import(url(source('lib/requestGuard.js')));
  let folder = '/A';
  const guard = createRequestGuard(() => folder);
  guard.holdSource();
  let awakened = false;
  const waiting = guard.waitForSource().then(() => { awakened = true; });
  folder = '/B';
  guard.holdSource();
  await tick();
  assert.equal(awakened, true, 'B 的来源请求一直未返回时，A 的等待也必须退出');
  await waiting;
});

test('来源切换的迟到结果及 finally 不改写 B 项目状态', async () => {
  const code = source('tabs/overview/sourceSelector.js')
    .replace('../../lib/overviewPerf.js', url('export const computeFileFingerprint = () => "";'))
    .replace('../../lib/dialog.js', url('export const trapDialogFocus = () => {}; export const restoreDialogFocus = () => {};'))
    .replace('../../lib/requestGuard.js', url(source('lib/requestGuard.js')));
  const { createSourceSelector } = await import(url(code));
  const delayed = deferred();
  const bus = new EventTarget();
  const state = { folder: '/A', sourceMode: 'uncommitted', changes: 'A', base: null };
  const context = { state, bus, el, baseSelect: el('select'), customBaseInput: el('input'),
    branchInfo: { branches: [], current: '' }, api: { getChanges: () => delayed.promise },
    toast() { assert.fail('不应提示过期请求'); }, ctx: { changesFingerprint: () => 'fp' },
    clearAllSelection() { assert.fail('不应清理 B 选区'); }, persistProjectPatch() { assert.fail('不应保存 A 结果到 B'); } };
  const selector = createSourceSelector(context);
  const pending = selector.applyBase('main');
  state.folder = '/B';
  state.changes = 'B';
  bus.dispatchEvent(event('project:changed'));
  context.baseSelect.disabled = true;
  delayed.resolve({ files: [], source: { mode: 'branch' } });
  await pending;
  assert.equal(state.changes, 'B');
  assert.equal(state.base, null);
  assert.equal(context.baseSelect.disabled, true);
});

test('旧弹窗 close 不关闭新弹窗，项目切换释放当前弹窗操作', async () => {
  const code = source('lib/findingsView/dialogs.js')
    .replace('../dialog.js', url('export const trapDialogFocus = () => {}; export const restoreDialogFocus = () => {};'));
  const { createDialogs } = await import(url(code));
  const oldDocument = globalThis.document;
  const doc = new EventTarget();
  doc.body = el('body');
  globalThis.document = doc;
  const bus = new EventTarget();
  let oldClose;
  let oldLifecycle;
  let disposed = 0;
  try {
    const dialogs = createDialogs({ el, bus });
    dialogs.openAccessibleDialog({ title: '旧', opener: null, build: (_body, _footer, close, lifecycle) => {
      oldClose = close; oldLifecycle = lifecycle; lifecycle.onDispose(() => disposed++); return null;
    } });
    dialogs.openAccessibleDialog({ title: '新', opener: null, build: (_body, _footer, _close, lifecycle) => {
      lifecycle.onDispose(() => disposed++); return null;
    } });
    assert.equal(disposed, 1);
    assert.equal(oldLifecycle.isActive(), false);
    oldClose();
    assert.equal(doc.body.children.length, 1);
    bus.dispatchEvent(event('project:changed'));
    assert.equal(doc.body.children.length, 0);
    assert.equal(disposed, 2);
  } finally { globalThis.document = oldDocument; }
});

test('历史七条折叠结果不渲染 Markdown，展开后按正文缓存且搜索保持防抖', async (t) => {
  let markdownCalls = 0;
  globalThis.__historyMarkdown = (text) => { markdownCalls++; return text; };
  const code = source('lib/historyView.js')
    .replace('./aiShared.js', url('export const BACKEND_LABELS = {}; export const formatStoredStats = () => ""; export const exportReview = () => {}; export const defaultExportName = () => "";'))
    .replace('../markdown.js', url('export const renderMarkdown = (text) => globalThis.__historyMarkdown(text);'))
    .replace('./chatView.js', url('export const createChatView = () => ({});'))
    .replace('./reviewGuards.js', url(source('lib/reviewGuards.js')))
    .replace('./dialog.js', url('export const trapDialogFocus = () => {}; export const restoreDialogFocus = () => {};'));
  const { createHistoryView } = await import(url(code));
  const container = el('div');
  const entries = Array.from({ length: 7 }, (_, i) => ({ id: String(i), title: `记录 ${i}`,
    createdAt: i, kind: 'review', markdown: '# 长正文\n'.repeat(10000), perModel: [] }));
  let loads = 0;
  const view = createHistoryView({ container, el, api: { listReviews: async () => { loads++; return entries; } },
    getFolder: () => '/A', emptyState: () => el('div'), toast() {}, errText: String });
  try {
    await view.load();
    assert.equal(markdownCalls, 0);
    const search = descendants(container).find((node) => node.classList.contains('history-search-input'));
    search.value = '记录';
    const start = performance.now();
    search.dispatchEvent(new Event('input'));
    search.dispatchEvent(new Event('input'));
    assert.equal(loads, 1);
    await new Promise((resolve) => setTimeout(resolve, 210));
    const elapsed = performance.now() - start;
    assert.equal(loads, 2);
    assert.equal(markdownCalls, 0);
    assert.ok(elapsed < 300, `七条搜索耗时 ${elapsed.toFixed(1)}ms`);
    t.diagnostic(`七条搜索含 180ms 防抖：${elapsed.toFixed(1)}ms；Markdown 调用 0 次`);
    const expand = () => descendants(container).find((node) => node.classList.contains('history-expand-btn'));
    expand().dispatchEvent(new Event('click'));
    assert.equal(markdownCalls, 1);
    expand().dispatchEvent(new Event('click'));
    expand().dispatchEvent(new Event('click'));
    assert.equal(markdownCalls, 1);
  } finally { delete globalThis.__historyMarkdown; }
});

test('展开多模型历史搜索重建仅在 details 打开时解析且按内容缓存', async () => {
  const calls = [];
  globalThis.__historyMarkdown = (text) => { calls.push(text); return text; };
  const { createHistoryView } = await import(url(historyCode(url('export const createChatView = () => ({});'))));
  const container = el('div');
  const entry = { id: 'multi', title: '多模型', markdown: '汇总', createdAt: 1,
    perModel: [{ markdown: '模型一' }, { markdown: '模型二' }] };
  const view = createHistoryView({ container, el, api: { listReviews: async () => [entry] },
    getFolder: () => '/A', emptyState: () => el('div'), toast() {}, errText: String });
  try {
    await view.load();
    findClass(container, 'history-expand-btn').dispatchEvent(new Event('click'));
    assert.deepEqual(calls, ['汇总']);
    const details = findClass(container, 'history-per-model');
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    assert.deepEqual(calls, ['汇总', '模型一', '模型二']);
    const search = findClass(container, 'history-search-input');
    search.value = '模型';
    search.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 210));
    const rebuilt = findClass(container, 'history-per-model');
    assert.equal(rebuilt.open, true);
    rebuilt.dispatchEvent(new Event('toggle'));
    assert.deepEqual(calls, ['汇总', '模型一', '模型二']);
    entry.perModel[0].markdown = '模型一更新';
    await view.load();
    assert.deepEqual(calls, ['汇总', '模型一', '模型二', '模型一更新']);
  } finally { delete globalThis.__historyMarkdown; }
});

function findClass(root, name) { return descendants(root).find((node) => node.classList.contains(name)); }
function historyCode(chatUrl) {
  return source('lib/historyView.js')
    .replace('./aiShared.js', url('export const BACKEND_LABELS = {}; export const formatStoredStats = () => ""; export const exportReview = () => {}; export const defaultExportName = () => "";'))
    .replace('../markdown.js', url('export const renderMarkdown = (text) => globalThis.__historyMarkdown(text);'))
    .replace('./chatView.js', chatUrl)
    .replace('./reviewGuards.js', url(source('lib/reviewGuards.js')))
    .replace('./dialog.js', url('export const trapDialogFocus = () => {}; export const restoreDialogFocus = () => {};'));
}

test('历史 pending sendChatMessage 跨展开、对比和搜索重建保留同一视图并只完成一次', async (t) => {
  const chatCode = source('lib/chatView.js')
    .replace('./aiShared.js', url('export const formatStoredStats = () => ""; export const copyMarkdown = () => {};'))
    .replace('../markdown.js', url('export const renderMarkdown = (text) => text;'))
    .replace('./runStatus.js', url('export const createRunStatus = ({el}) => ({root: el("div"), dispose() {}});'))
    .replace('./streamPreview.js', url('export const createStreamPreview = ({el}) => ({streamBox: el("div"), unsubscribe() {}});'));
  globalThis.__historyMarkdown = (text) => text;
  const { createHistoryView } = await import(url(historyCode(url(chatCode))));
  const oldDocument = globalThis.document;
  const container = el('div');
  globalThis.document = { contains: (node) => container.contains(node) };
  let pending = deferred();
  let payload;
  let sends = 0;
  const cancelled = [];
  let filteredOut = false;
  const thread = { id: 'thread', context: {}, messages: [] };
  const entries = ['one', 'two'].map((id) => ({ id, title: id, createdAt: 1, markdown: '正文' }));
  const view = createHistoryView({ container, el, api: { listReviews: async () => filteredOut ? [] : entries,
     createChatThread: async () => thread, cancelRun: async (id) => { cancelled.push(id); },
     sendChatMessage: (request) => { sends++; payload = request; return pending.promise; } },
    getFolder: () => '/A', emptyState: () => el('div'), toast() {}, errText: String });
  try {
    await view.load();
    findClass(container, 'history-expand-btn').dispatchEvent(new Event('click'));
    findClass(container, 'history-followup-btn').dispatchEvent(new Event('click'));
    await tick();
    const root = findClass(container, 'chat-view');
    const input = findClass(root, 'chat-composer-textarea');
    input.value = '问题';
    findClass(root, 'chat-send-btn').dispatchEvent(new Event('click'));
    assert.equal(input.disabled, true);
    descendants(container).filter((node) => node.classList.contains('history-expand-btn'))[1].dispatchEvent(new Event('click'));
    const cb = findClass(container, 'history-check-input');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    const search = findClass(container, 'history-search-input');
    search.value = 'one';
    search.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 210));
    assert.equal(findClass(container, 'chat-view'), root);
    assert.equal(findClass(container, 'chat-composer-textarea'), input);
    assert.equal(input.disabled, true);
    filteredOut = true;
    await view.load();
    assert.equal(findClass(container, 'chat-view'), undefined);
    filteredOut = false;
    await view.load();
    const replacement = findClass(container, 'chat-view');
    const replacementInput = findClass(replacement, 'chat-composer-textarea');
    assert.notEqual(replacement, root);
    assert.equal(replacementInput.disabled, true);
    assert.match(replacement.textContent, /问题/);
    findClass(replacement, 'chat-stop-btn').dispatchEvent(new Event('click'));
    await tick();
    assert.deepEqual(cancelled, [payload.runId]);
    search.focus();
    pending.resolve({ thread: { ...thread, messages: [
      { id: 'q', requestId: payload.requestId, role: 'user', content: '问题', status: 'complete' },
      { id: 'a', requestId: payload.requestId, role: 'assistant', content: '完成回答', status: 'complete' },
    ] } });
    await tick();
    assert.equal(sends, 1);
    assert.equal(replacementInput.disabled, false);
    assert.equal(findClass(replacement, 'chat-regenerate-btn').disabled, false);
    assert.equal(globalThis.document.activeElement, search);
    assert.equal(descendants(replacement).filter((node) => node.textContent === '完成回答').length, 1);
    await view.load();
    assert.equal(findClass(container, 'chat-view'), replacement);
    assert.match(container.textContent, /完成回答/);
    pending = deferred();
    replacementInput.value = '失败问题';
    findClass(replacement, 'chat-send-btn').dispatchEvent(new Event('click'));
    const firstAnswer = { id: 'a', requestId: 'first', role: 'assistant', content: '完成回答', status: 'complete' };
    pending.resolve({ thread: { ...thread, messages: [
      { id: 'q', requestId: 'first', role: 'user', content: '问题', status: 'complete' }, firstAnswer,
      { id: 'q2', requestId: payload.requestId, role: 'user', content: '失败问题', status: 'complete' },
      { id: 'a2', requestId: payload.requestId, role: 'assistant', content: '', status: 'cancelled' },
    ] } });
    await tick();
    assert.equal(findClass(replacement, 'chat-regenerate-btn').disabled, false);
    assert.equal(findClass(replacement, 'chat-retry-btn').disabled, false);
    assert.equal(globalThis.document.activeElement, search);
    t.diagnostic('恢复视图保留问题、停止使用原 runId，完成后重新生成/重试可用，搜索焦点不变');
  } finally { globalThis.document = oldDocument; delete globalThis.__historyMarkdown; }
});

test('聊天 dispose 移除项目监听和流订阅，迟到建线程结果不再发送', async () => {
  let statuses = 0;
  let streams = 0;
  globalThis.__chatResources = { status: (delta) => { statuses += delta; }, stream: (delta) => { streams += delta; } };
  const code = source('lib/chatView.js')
    .replace('./aiShared.js', url('export const formatStoredStats = () => ""; export const copyMarkdown = () => {};'))
    .replace('../markdown.js', url('export const renderMarkdown = (text) => text;'))
    .replace('./runStatus.js', url('export const createRunStatus = ({el}) => { globalThis.__chatResources.status(1); let done = false; return {root: el("div"), dispose() { if (!done) { done = true; globalThis.__chatResources.status(-1); } }}; };'))
    .replace('./streamPreview.js', url('export const createStreamPreview = ({el}) => { globalThis.__chatResources.stream(1); let done = false; return {streamBox: el("div"), unsubscribe() { if (!done) { done = true; globalThis.__chatResources.stream(-1); } }}; };'));
  const { createChatView } = await import(url(code));
  const delayed = deferred();
  const bus = new EventTarget();
  let listeners = 0;
  const add = bus.addEventListener.bind(bus);
  const remove = bus.removeEventListener.bind(bus);
  bus.addEventListener = (...args) => { listeners++; add(...args); };
  bus.removeEventListener = (...args) => { listeners--; remove(...args); };
  let sends = 0;
  const view = createChatView({ el, bus, getFolder: () => '/A', ensureThread: () => delayed.promise,
    api: { sendChatMessage: async () => { sends++; } } });
  const input = descendants(view.root).find((node) => node.classList.contains('chat-composer-textarea'));
  input.value = '问题';
  descendants(view.root).find((node) => node.classList.contains('chat-send-btn')).dispatchEvent(new Event('click'));
  assert.equal(statuses, 1);
  assert.equal(streams, 1);
  view.dispose();
  view.dispose();
  assert.equal(listeners, 0);
  assert.equal(statuses, 0);
  assert.equal(streams, 0);
  delayed.resolve({ id: 'late', messages: [] });
  await tick();
  assert.equal(sends, 0);
  assert.equal(input.disabled, true);
  delete globalThis.__chatResources;
});

test('diff 收起焦点所在 hunk 后仅可见改动行留在 Tab 顺序', async () => {
  const code = source('tabs/overview/diffView.js')
    .replace('../../lib/overviewPerf.js', url(source('lib/overviewPerf.js')));
  const { createDiffView } = await import(url(code));
  const diffView = el('div');
  const rowA = el('div');
  const rowB = el('div');
  let collapsed = false;
  rowA.closest = () => collapsed ? {} : null;
  rowB.closest = () => null;
  diffView.append(rowA, rowB);
  const context = { diffView, lastDiffRows: [{ row: rowA }, { row: rowB }] };
  const controller = createDiffView(context);
  assert.equal(controller.setFocusedCpos(0), rowA);
  collapsed = true;
  assert.equal(controller.setFocusedCpos(0), rowB);
  assert.equal(rowA.tabindex, '-1');
  assert.equal(rowB.tabindex, '0');
  collapsed = false;
  controller.setFocusedCpos(0);
  assert.equal(rowA.tabindex, '0');
  assert.equal(rowB.tabindex, '-1');
});

test('焦点捕获排除无布局、hidden、aria-hidden 和已收起 details 的控件', async () => {
  const { isDialogControlVisible } = await import(url(source('lib/dialog.js')));
  const oldDetails = globalThis.HTMLDetailsElement;
  const oldStyle = globalThis.getComputedStyle;
  class Details { open = false; querySelector() { return { contains: () => false }; } }
  globalThis.HTMLDetailsElement = Details;
  globalThis.getComputedStyle = () => ({ visibility: 'visible' });
  const node = { getClientRects: () => [{}], closest: () => null, parentElement: null };
  try {
    assert.equal(isDialogControlVisible(node), true);
    assert.equal(isDialogControlVisible({ ...node, getClientRects: () => [] }), false);
    assert.equal(isDialogControlVisible({ ...node, closest: () => ({}) }), false);
    assert.equal(isDialogControlVisible({ ...node, parentElement: new Details() }), false);
    const open = new Details();
    open.open = true;
    assert.equal(isDialogControlVisible({ ...node, parentElement: open }), true);
  } finally {
    globalThis.HTMLDetailsElement = oldDetails;
    globalThis.getComputedStyle = oldStyle;
  }
});

test('新项目发布 changed 前清空快照状态，加载失败不派发 loaded', async () => {
  const app = source('app.js');
  const loadProjectCode = app.slice(app.indexOf('async function loadProject('), app.indexOf('async function selectFolder('));
  const state = { folder: '/A', changes: { files: ['old'] }, changesFp: 'old', selectedFile: {},
    selectedLine: {}, pendingAnalyzeFile: {}, selAnchor: {} };
  const bus = new EventTarget();
  let changed = 0;
  let toasts = 0;
  bus.addEventListener('project:changed', () => {
    changed++;
    assert.equal(state.folder, '/B');
    for (const key of ['changes', 'changesFp', 'selectedFile', 'selectedLine', 'pendingAnalyzeFile', 'selAnchor']) {
      assert.equal(state[key], null, key);
    }
  });
  const { createRequestGuard } = await import(url(source('lib/requestGuard.js')));
   const factory = new Function('state', 'bus', 'workspaceState', 'updateProjectDisplay', 'setLoading', 'loadChanges', 'toast', 'errText', 'changesGuard', 'projectGuard',
      `let projectLoadPending = null; let projectLifecyclePending = null; let watchRescanPending = false; ${loadProjectCode}; return loadProject;`);
  const loadProject = factory(state, bus, { getProject: () => ({}) }, () => {}, () => {},
     async () => { throw new Error('failed'); }, () => { toasts++; }, String, createRequestGuard(() => state.folder), createRequestGuard(() => state.folder));
  assert.equal(await loadProject('/B'), false);
  assert.equal(changed, 1);
  assert.equal(toasts, 1);
  assert.equal(state.changes, null);
});

async function appRequests(savedSource = null) {
  const { createRequestGuard } = await import(url(source('lib/requestGuard.js')));
  const app = source('app.js');
  const state = { folder: null };
  const bus = new EventTarget();
  const requests = [];
  const toasts = [];
  const loading = [];
  const lifecycle = [];
  let fsChanged;
  const api = { getChanges: (folder, options) => {
    let reject;
    const request = deferred();
    const promise = new Promise((resolve, fail) => { request.promise.then(resolve); reject = fail; });
    requests.push({ ...request, reject, folder, options });
    return promise;
   }, stopWatch: async () => { lifecycle.push('stop'); }, startWatch: async (folder) => { lifecycle.push(`watch:${folder}`); },
   addRecentProject: async (folder) => { lifecycle.push(`recent:${folder}`); }, onFsChanged: (callback) => { fsChanged = callback; } };
  const changesGuard = createRequestGuard(() => state.folder);
  const code = app.slice(app.indexOf('async function loadChanges('), app.indexOf('// 右下角浮层提示'))
    + app.slice(app.indexOf('function completeProjectLifecycle('), app.indexOf('async function selectFolder('))
     + app.slice(app.indexOf('async function rescan('), app.indexOf('// Electron IPC 异常'))
     + app.slice(app.indexOf('// 文件监听：'), app.indexOf('const ctx ='));
   const factory = new Function('state', 'bus', 'api', 'workspaceState', 'changesGuard', 'projectGuard', 'changesFingerprint',
      'updateProjectDisplay', 'setLoading', 'toast', 'errText', `let projectLoadPending = null; let projectLifecyclePending = null; let watchRescanPending = false; ${code}; return {loadProject, loadChanges, rescan};`);
   return { state, bus, api, changesGuard, requests, toasts, loading, lifecycle, fsChanged: () => fsChanged(), ...factory(state, bus, api,
     { getProject: () => ({ source: savedSource }), updateProject() {}, touchProject(folder) { lifecycle.push(`touch:${folder}`); } }, changesGuard, createRequestGuard(() => state.folder),
    (result) => result.snapshotId, () => {}, (value) => loading.push(value), (text) => toasts.push(text), String) };
}

test('app 项目 A→B→A 首次 A 最后返回也保留最新快照和 loading', async () => {
  const app = await appRequests();
  const first = app.loadProject('/A');
  const middle = app.loadProject('/B');
  const newest = app.loadProject('/A');
  app.requests[2].resolve({ snapshotId: 'new-A', files: [] });
  assert.equal(await newest, true);
  const loadingCount = app.loading.length;
  app.requests[1].reject(new Error('过期 B'));
  app.requests[0].resolve({ snapshotId: 'old-A', files: [] });
  assert.equal(await first, false);
  assert.equal(await middle, false);
  assert.equal(app.state.changes.snapshotId, 'new-A');
  assert.equal(app.loading.length, loadingCount);
  assert.deepEqual(app.toasts, []);
  assert.deepEqual(app.lifecycle, ['touch:/A', 'stop', 'watch:/A', 'recent:/A']);
});

test('app 项目加载中的来源选择优先，旧失败不回退或提示', async () => {
  const app = await appRequests({ mode: 'branch', base: 'old' });
  const code = source('tabs/overview/sourceSelector.js')
    .replace('../../lib/overviewPerf.js', url('export const computeFileFingerprint = () => "";'))
    .replace('../../lib/dialog.js', url('export const trapDialogFocus = () => {}; export const restoreDialogFocus = () => {};'))
    .replace('../../lib/requestGuard.js', url(source('lib/requestGuard.js')));
  const { createSourceSelector } = await import(url(code));
  const selector = createSourceSelector({ state: app.state, bus: app.bus, api: app.api, el,
    baseSelect: el('select'), customBaseInput: el('input'), branchInfo: { branches: [], current: '' },
    ctx: { changesGuard: app.changesGuard, changesFingerprint: (result) => result.snapshotId },
    clearAllSelection() {}, persistProjectPatch() {}, toast: (text) => app.toasts.push(text), errText: String });
  const project = app.loadProject('/A');
  const selected = selector.applyBase('staged');
  app.requests[1].resolve({ snapshotId: 'selected', files: [], source: { mode: 'staged' } });
  await selected;
  app.requests[0].reject(new Error('旧来源失效'));
   assert.equal(await project, true);
  assert.equal(app.state.changes.snapshotId, 'selected');
  assert.equal(app.state.sourceMode, 'staged');
  assert.equal(app.requests.length, 2);
  assert.deepEqual(app.toasts, []);
  assert.ok(app.lifecycle.includes('watch:/A'));
});

test('B→A 加载中重新扫描不剥夺 A 的项目生命周期', async () => {
  const app = await appRequests();
  const b = app.loadProject('/B');
  app.requests[0].resolve({ snapshotId: 'B', files: [] });
  await b;
  const a = app.loadProject('/A');
  const refresh = app.rescan();
  await tick();
  app.requests[2].resolve({ snapshotId: 'refresh-A', files: [] });
  await refresh;
  app.requests[1].resolve({ snapshotId: 'old-A', files: [] });
  assert.equal(await a, true);
  assert.equal(app.state.changes.snapshotId, 'refresh-A');
  assert.deepEqual(app.lifecycle.slice(-4), ['touch:/A', 'stop', 'watch:/A', 'recent:/A']);
});

test('B 首次加载失败后手动、自动或来源恢复均仅补齐一次生命周期', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const code = source('tabs/overview/sourceSelector.js')
    .replace('../../lib/overviewPerf.js', url('export const computeFileFingerprint = () => "";'))
    .replace('../../lib/dialog.js', url('export const trapDialogFocus = () => {}; export const restoreDialogFocus = () => {};'))
    .replace('../../lib/requestGuard.js', url(source('lib/requestGuard.js')));
  const { createSourceSelector } = await import(url(code));
  for (const mode of ['manual', 'auto', 'source']) {
    const app = await appRequests();
    const a = app.loadProject('/A');
    app.requests[0].resolve({ snapshotId: 'A', files: [] });
    await a;
    app.lifecycle.length = 0;
    const b = app.loadProject('/B');
    app.requests[1].reject(new Error('首次加载失败'));
    assert.equal(await b, false);
    assert.deepEqual(app.lifecycle, []);
    let recovery;
    if (mode === 'source') {
      const selector = createSourceSelector({ state: app.state, bus: app.bus, api: app.api, el,
        baseSelect: el('select'), customBaseInput: el('input'), branchInfo: { branches: [], current: '' },
        ctx: { changesGuard: app.changesGuard, changesFingerprint: (result) => result.snapshotId },
        clearAllSelection() {}, persistProjectPatch() {}, toast() {}, errText: String });
      recovery = selector.applyBase('staged');
    } else if (mode === 'auto') {
      app.fsChanged();
      t.mock.timers.tick(2000);
    } else recovery = app.rescan();
    await tick();
    app.requests[2].resolve({ snapshotId: 'B', files: [], source: { mode: mode === 'source' ? 'staged' : 'uncommitted' } });
    await recovery;
    await tick();
    const expected = ['touch:/B', 'stop', 'watch:/B', 'recent:/B'];
    assert.deepEqual(app.lifecycle, expected, mode);
    const refresh = app.rescan();
    await tick();
    app.requests[3].resolve({ snapshotId: 'B-again', files: [] });
    await refresh;
    assert.deepEqual(app.lifecycle, expected, '重复扫描不重启监听');
  }
});

test('恢复 B 的快照迟到时不补齐已被 C 取消的生命周期', async () => {
  const app = await appRequests();
  const b = app.loadProject('/B');
  app.requests[0].reject(new Error('首次加载失败'));
  await b;
  const recovery = app.rescan();
  await tick();
  const c = app.loadProject('/C');
  app.requests[2].resolve({ snapshotId: 'C', files: [] });
  await c;
  app.requests[1].resolve({ snapshotId: '过期 B', files: [] });
  await recovery;
  assert.equal(app.state.changes.snapshotId, 'C');
  assert.deepEqual(app.lifecycle, ['touch:/C', 'stop', 'watch:/C', 'recent:/C']);
});

test('项目切换立即唤醒等待旧来源的扫描，不等待旧来源请求返回', async () => {
  const app = await appRequests();
  const a = app.loadProject('/A');
  app.requests[0].resolve({ snapshotId: 'A', files: [] });
  await a;
  const sourceRequest = app.changesGuard.begin();
  const release = app.changesGuard.holdSource();
  const unresolved = deferred();
  const selected = unresolved.promise.then((result) => {
    if (sourceRequest.isCurrent()) app.state.changes = result;
  }).finally(release);
  let finished = false;
  const refresh = app.rescan().then(() => { finished = true; });
  await tick();
  assert.equal(finished, false);
  const b = app.loadProject('/B');
  app.requests[1].resolve({ snapshotId: 'B', files: [] });
  await b;
  const loadingCount = app.loading.length;
  await tick();
  assert.equal(finished, true, '旧来源尚未返回也应退出等待扫描');
  await refresh;
  assert.equal(app.requests.length, 2);
  assert.equal(app.state.changes.snapshotId, 'B');
  assert.equal(app.loading.length, loadingCount);
  unresolved.resolve({ snapshotId: '过期来源', files: [] });
  await selected;
  assert.equal(app.state.changes.snapshotId, 'B');
});

test('切换时旧 watcher 事件不抢占新项目加载，结束后补扫一次', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = await appRequests();
  const a = app.loadProject('/A');
  app.fsChanged();
  t.mock.timers.tick(2000);
  await tick();
  assert.equal(app.requests.length, 1);
  app.requests[0].resolve({ snapshotId: 'A', files: [] });
  assert.equal(await a, true);
  assert.ok(app.lifecycle.includes('watch:/A'));
  t.mock.timers.tick(2000);
  await tick();
  assert.equal(app.requests.length, 2);
  app.requests[1].resolve({ snapshotId: 'rescan-A', files: [] });
  await tick();
});

test('来源 staged 尚未完成时手动和自动重新扫描等待意图提交，失败明确回滚', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const code = source('tabs/overview/sourceSelector.js')
    .replace('../../lib/overviewPerf.js', url('export const computeFileFingerprint = () => "";'))
    .replace('../../lib/dialog.js', url('export const trapDialogFocus = () => {}; export const restoreDialogFocus = () => {};'))
    .replace('../../lib/requestGuard.js', url(source('lib/requestGuard.js')));
  const { createSourceSelector } = await import(url(code));
  for (const mode of ['manual', 'auto', 'failure']) {
    const fail = mode === 'failure';
    const app = await appRequests();
    const project = app.loadProject('/A');
    app.requests[0].resolve({ snapshotId: 'initial', files: [] });
    await project;
    const selector = createSourceSelector({ state: app.state, bus: app.bus, api: app.api, el,
      baseSelect: el('select'), customBaseInput: el('input'), branchInfo: { branches: [], current: '' },
      ctx: { changesGuard: app.changesGuard, changesFingerprint: (result) => result.snapshotId },
      clearAllSelection() {}, persistProjectPatch() {}, toast: (text) => app.toasts.push(text), errText: String });
    const selected = selector.applyBase('staged');
    let refresh;
    if (mode === 'auto') { app.fsChanged(); t.mock.timers.tick(2000); }
    else refresh = app.rescan();
    await tick();
    assert.equal(app.requests.length, 2);
    if (fail) app.requests[1].reject(new Error('来源失败'));
    else app.requests[1].resolve({ snapshotId: 'selected', files: [], source: { mode: 'staged' } });
    await selected;
    await tick();
    assert.equal(app.requests[2].options.mode, fail ? 'uncommitted' : 'staged');
    app.requests[2].resolve({ snapshotId: 'refreshed', files: [], source: { mode: fail ? 'uncommitted' : 'staged' } });
    await refresh;
    await tick();
    assert.equal(app.state.sourceMode, fail ? 'uncommitted' : 'staged');
    assert.equal(app.state.changes.snapshotId, 'refreshed');
    assert.equal(app.toasts.length, mode === 'manual' ? 0 : 1);
    if (fail) assert.match(app.toasts[0], /切换基准失败/);
  }
});

test('逐文件新分析与缓存恢复都保留 coverage notice', async () => {
  const shared = url('export const formatRunEstimate = () => ({}); export const planReviewEnabled = () => false; export const loadPlanContext = async () => null; export const countChanges = () => ({add: 1, del: 0});');
  const code = source('tabs/review/fileCards.js')
    .replace('../../lib/aiShared.js', shared)
    .replace('../../markdown.js', url('export const renderMarkdown = (text) => text;'))
    .replace('../../lib/streamPreview.js', url('export const createStreamPreview = ({el}) => ({streamBox: el("div"), unsubscribe() {}});'))
    .replace('../../lib/runStatus.js', url('export const createRunStatus = ({el}) => ({root: el("div"), dispose() {}});'))
    .replace('../../lib/reviewGuards.js', url(source('lib/reviewGuards.js')));
  const { createFileCards } = await import(url(code));
  const file = { path: 'a.js', hunks: [] };
  const filesPanel = el('div');
  const result = { markdown: '结果', stats: {}, coverageNotices: ['文件被截断'] };
  const cards = createFileCards({ el, state: { folder: '/A', changes: { files: [file] } }, filesPanel,
    api: { analyzeFile: async () => result }, bus: new EventTarget(), ctx: {},
    activePreset: () => null, selectedNoiseOverride: () => null, statsLine: () => el('div'),
    toast() {}, errText: String, emptyState: () => el('div') });
  cards.renderFilesPanel();
  const analyze = descendants(filesPanel).find((node) => node.tagName === 'BUTTON');
  analyze.dispatchEvent(new Event('click'));
  await tick();
  assert.match(filesPanel.textContent, /文件被截断.*结果/);
  cards.fileCardControllers.get(file.path).syncCache({ ...result, cacheHit: true, cachedAt: 1 });
  assert.match(filesPanel.textContent, /缓存.*文件被截断.*结果/);
});

test('撤销补丁采用返回 finding 的恢复状态与复核备注', async () => {
  const code = source('lib/findingsView/fixOperations.js')
    .replace('../runStatus.js', url('export const createRunStatus = () => ({});'))
    .replace('../dialog.js', url('export const confirmDialog = async () => true;'));
  const { createFixOperations } = await import(url(code));
  const oldElement = globalThis.HTMLElement;
  globalThis.HTMLElement = class {};
  const item = { id: 'f1', status: 'fixed' };
  const restored = { ...item, status: 'pending', verification: { note: '补丁已撤销，需重新复核' } };
  const context = { getFolder: () => '/A', appliedPatches: new Map([['f1', 'patch']]), savingIds: new Set(),
    findingErrors: new Map(), findings: [item], render() {}, toast() {}, bus: new EventTarget(),
    api: { revertFixPatch: async () => ({ reverted: true, finding: restored }) }, container: { querySelectorAll: () => [], querySelector: () => null } };
  try {
    await createFixOperations(context).runRevertFixPatch(item);
    assert.equal(context.findings[0], restored);
    assert.equal(context.findings[0].verification.note, '补丁已撤销，需重新复核');
    assert.equal(context.appliedPatches.has('f1'), false);
  } finally { globalThis.HTMLElement = oldElement; }
});

test('运行详情把子调用放入父卡片且隐藏子控制，最后卡片消失仍聚焦关闭按钮', async () => {
  const code = source('runDetails.js')
    .replace('./lib/aiShared.js', url('export const BACKEND_LABELS = {};'))
    .replace('./lib/dialog.js', url('export const trapDialogFocus = () => {};'))
    .replace('./lib/runStatus.js', url('export const formatRunKind = () => "评审";'));
  const { createRunDetails } = await import(url(code));
  const oldDocument = globalThis.document;
  const oldElement = globalThis.HTMLElement;
  const doc = new EventTarget();
  doc.body = el('body');
  doc.activeElement = doc.body;
  doc.contains = (node) => doc.body.contains(node);
  globalThis.document = doc;
  globalThis.HTMLElement = class {};
  const createEl = (...args) => {
    const node = el(...args);
    node.focus = () => { doc.activeElement = node; };
    const remove = node.remove.bind(node);
    node.remove = () => { if (node.contains(doc.activeElement)) doc.activeElement = doc.body; remove(); };
    const append = node.appendChild.bind(node);
    node.appendChild = (child) => { if (child.parentNode) child.remove(); return append(child); };
    return node;
  };
  const bus = new EventTarget();
  const parent = { runId: 'parent', startedAt: Date.now(), kind: 'review' };
  const child = { runId: 'child', parentRunId: 'parent', startedAt: Date.now(), kind: 'review' };
  let cancels = 0;
  const show = createRunDetails({ el: createEl, bus, api: { listRuns: async () => [child, parent],
    cancelRun: async () => { cancels++; } }, toast() {}, errText: String });
  try {
    show();
    await tick();
    const cards = descendants(doc.body).filter((node) => node.classList.contains('run-card'));
    assert.equal(cards.length, 2);
    const childCard = cards.find((node) => node.parentNode.classList.contains('run-children'));
    assert.ok(childCard);
    assert.equal(childCard.children[0].children[1].hidden, true);
    const parentCard = cards.find((node) => node !== childCard);
    const cancel = descendants(parentCard).find((node) => node.classList.contains('run-cancel'));
    let disabled = false;
    Object.defineProperty(cancel, 'disabled', { get: () => disabled, set: (value) => {
      if (value) assert.equal(doc.activeElement.classList.contains('run-close'), true, '禁用前必须移交焦点');
      disabled = value;
    } });
    for (const activation of ['mouse', 'Enter']) {
      cancel.focus();
      if (activation === 'Enter') {
        const key = new Event('keydown');
        Object.assign(key, { key: 'Enter' });
        cancel.dispatchEvent(key);
      }
      cancel.dispatchEvent(new Event('click'));
      assert.equal(doc.activeElement.classList.contains('run-close'), true);
      await tick();
      cancel.disabled = false;
    }
    assert.equal(cancels, 2);
    cancel.focus();
    bus.dispatchEvent(event('runs:changed', []));
    assert.equal(doc.activeElement.classList.contains('run-close'), true);
    bus.dispatchEvent(event('runs:changed', [parent]));
    doc.activeElement = doc.body;
    bus.dispatchEvent(event('runs:changed', []));
    assert.equal(doc.activeElement.classList.contains('run-close'), true);
  } finally {
    show();
    globalThis.document = oldDocument;
    globalThis.HTMLElement = oldElement;
  }
});

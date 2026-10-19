const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

let closeUnclosedFence;
let createStreamPreview;
let STREAM_PLAIN_FALLBACK_CHARS;
let formatElapsedMmSs;
let formatRunStage;
let formatRunKind;
let createRunStatus;

before(async () => {
  const mdSrc = fs.readFileSync(path.join(__dirname, '../../renderer/markdown.js'), 'utf8');
  const mdUrl = 'data:text/javascript;base64,' + Buffer.from(mdSrc, 'utf8').toString('base64');
  const spSrc = fs
    .readFileSync(path.join(__dirname, '../../renderer/lib/streamPreview.js'), 'utf8')
    .replace('../markdown.js', () => mdUrl);
  const spUrl = 'data:text/javascript;base64,' + Buffer.from(spSrc, 'utf8').toString('base64');
  const mod = await import(spUrl);
  closeUnclosedFence = mod.closeUnclosedFence;
  createStreamPreview = mod.createStreamPreview;
  STREAM_PLAIN_FALLBACK_CHARS = mod.STREAM_PLAIN_FALLBACK_CHARS;

  const sharedSrc = fs.readFileSync(path.join(__dirname, '../../renderer/lib/aiShared.js'), 'utf8');
  const sharedUrl = 'data:text/javascript;base64,' + Buffer.from(sharedSrc, 'utf8').toString('base64');
  const rsSrc = fs.readFileSync(path.join(__dirname, '../../renderer/lib/runStatus.js'), 'utf8')
    .replace('./aiShared.js', () => sharedUrl);
  const rsUrl = 'data:text/javascript;base64,' + Buffer.from(rsSrc, 'utf8').toString('base64');
  const rsMod = await import(rsUrl);
  formatElapsedMmSs = rsMod.formatElapsedMmSs;
  formatRunStage = rsMod.formatRunStage;
  formatRunKind = rsMod.formatRunKind;
  createRunStatus = rsMod.createRunStatus;
});

function makeEl(tag, attrs = {}) {
  const classes = new Set(String(attrs.class || '').split(/\s+/).filter(Boolean));
  const node = {
    tagName: tag.toUpperCase(),
    textContent: '',
    innerHTML: '',
    parentNode: null,
    parentElement: null,
    children: [],
    style: {},
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    appendChild(child) {
      child.parentNode = this;
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    remove() {
      if (this.parentNode) {
        this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
        this.parentNode = null;
        this.parentElement = null;
      }
    },
  };
  return node;
}

test('closeUnclosedFence 自动闭合未结束的 ``` 代码块', () => {
  assert.strictEqual(closeUnclosedFence(''), '');
  assert.strictEqual(closeUnclosedFence('## 标题\n正文'), '## 标题\n正文');
  assert.strictEqual(
    closeUnclosedFence('```js\nconst a = 1;'),
    '```js\nconst a = 1;\n```',
  );
  assert.strictEqual(
    closeUnclosedFence('```js\nconst a = 1;\n```'),
    '```js\nconst a = 1;\n```',
  );
});

test('createStreamPreview 渐进式渲染 Markdown 并在 unsubscribe 后彻底取消挂起帧', async () => {
  let chunkHandler = null;
  const api = {
    onAiChunk: (cb) => {
      chunkHandler = cb;
      return () => { chunkHandler = null; };
    },
  };
  const parent = makeEl('div');
  const { streamBox, unsubscribe } = createStreamPreview({
    el: makeEl,
    api,
    runId: 'run-1',
    parent,
    throttleMs: 20,
  });

  chunkHandler({ runId: 'run-1', text: '## 概述\n```js\nconst x = 1;' });
  await new Promise((r) => setTimeout(r, 35));
  assert.strictEqual(streamBox.parentNode, parent);
  assert.ok(streamBox.innerHTML.includes('<h2>概述</h2>'));
  assert.ok(streamBox.innerHTML.includes('<pre><code>const x = 1;</code></pre>'));

  // 发送新 chunk 后立即 unsubscribe，确保残留定时器不会把旧预览写回 DOM
  chunkHandler({ runId: 'run-1', text: '## 概述\n残留内容' });
  unsubscribe();
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(streamBox.parentNode, null);
});

test('createStreamPreview 超过 200KB 自动回退纯文本渲染', async () => {
  let chunkHandler = null;
  const api = {
    onAiChunk: (cb) => {
      chunkHandler = cb;
      return () => { chunkHandler = null; };
    },
  };
  const parent = makeEl('div');
  const { streamBox, unsubscribe } = createStreamPreview({
    el: makeEl,
    api,
    runId: 'run-big',
    parent,
    throttleMs: 10,
  });

  const huge = 'a'.repeat(STREAM_PLAIN_FALLBACK_CHARS + 10);
  chunkHandler({ runId: 'run-big', text: huge });
  await new Promise((r) => setTimeout(r, 25));
  assert.ok(streamBox.classList.contains('stream-preview-plain'));
  assert.strictEqual(streamBox.textContent.length, huge.length);
  unsubscribe();
});

test('formatElapsedMmSs 与 formatRunStage 格式化运行阶段和耗时', () => {
  assert.strictEqual(formatElapsedMmSs(0), '00:00');
  assert.strictEqual(formatElapsedMmSs(83_400), '01:23');
  assert.strictEqual(
    formatRunStage({ batchIndex: 2, batchTotal: 5, backend: 'opencode', model: 'gpt-4o' }),
    '第 2/5 批 · OpenCode · gpt-4o',
  );
  assert.strictEqual(
    formatRunStage({ paused: true, batchIndex: 1, batchTotal: 3, backend: 'api' }),
    '已暂停 · 第 1/3 批 · API',
  );
});

test('formatRunKind 映射内部标识为中文标签且不透出英文 id', () => {
  assert.strictEqual(formatRunKind('overview'), '整体分析');
  assert.strictEqual(formatRunKind('full'), '完整讲解');
  assert.strictEqual(formatRunKind('file'), '逐文件分析');
  assert.strictEqual(formatRunKind('explain'), '逐句解析');
  assert.strictEqual(formatRunKind('followup'), '追问');
  assert.strictEqual(formatRunKind('plan'), '方案生成');
  assert.strictEqual(formatRunKind('multi'), '多模型汇总');
  assert.strictEqual(formatRunKind('patch'), '修复补丁');
  assert.strictEqual(formatRunKind('verify'), '问题复核');
  assert.strictEqual(formatRunKind('testConnection'), '测试连接');
  assert.strictEqual(formatRunKind('unknown-internal-id'), 'AI 调用');
  assert.strictEqual(formatRunKind(''), 'AI 调用');
});

test('createRunStatus 暂停时显示已暂停 · 已用 mm:ss 且冻结计时', async () => {
  function domEl(tag, attrs = {}, children = '') {
    const node = makeEl(tag, attrs);
    node.textContent = typeof children === 'string' ? children : '';
    node.addEventListener = () => {};
    return node;
  }
  const bus = new EventTarget();
  const status = createRunStatus({
    el: domEl,
    api: { cancelRun: async () => {} },
    bus,
    runId: 'r-pause',
  });
  try {
    const started = Date.now() - 65_000;
    const pausedTime = started + 65_000;
    status.applyRunItem({ runId: 'r-pause', startedAt: started, paused: false });
    status.applyRunItem({ runId: 'r-pause', startedAt: pausedTime, pausedAt: pausedTime, paused: true });
    const head = status.root.children[0];
    const elapsedEl = head.children[2];
    assert.strictEqual(elapsedEl.textContent, '已暂停 · 已用 01:05');
  } finally {
    status.dispose();
  }
});

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewflow-store-'));

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return { app: { getPath: () => tmpDir } };
  }
  return originalLoad.call(this, request, ...rest);
};

const store = require('../../main/store');

after(() => {
  Module._load = originalLoad;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('saveReview / listReviews 往返与默认值', () => {
  const entry = store.saveReview({ folder: '/r/a', markdown: '# 评审' });
  assert.ok(entry.id);
  assert.strictEqual(entry.title, '未命名评审');
  assert.strictEqual(entry.kind, 'review');
  assert.strictEqual(entry.stats, null);
  assert.strictEqual(entry.markdown, '# 评审');
  assert.ok(entry.createdAt > 0);

  const entry2 = store.saveReview({
    folder: '/r/a',
    title: '第二次',
    kind: 'plan',
    stats: { total: 1 },
    markdown: 'm2',
  });
  const list = store.listReviews('/r/a');
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].id, entry2.id); // 最新在前
  assert.strictEqual(list[0].kind, 'plan');
  assert.deepStrictEqual(list[0].stats, { total: 1 });
  assert.strictEqual(list[1].id, entry.id);
});

test('listReviews 未知 folder 返回空数组，且各 folder 隔离', () => {
  assert.deepStrictEqual(store.listReviews('/r/unknown'), []);
  store.saveReview({ folder: '/r/b', markdown: 'b' });
  assert.strictEqual(store.listReviews('/r/b').length, 1);
  assert.strictEqual(store.listReviews('/r/unknown').length, 0);
});

test('saveReview 缺少 folder 报错', () => {
  for (const bad of ['', null, undefined, 42]) {
    assert.throws(() => store.saveReview({ folder: bad, markdown: 'x' }), /缺少项目路径/);
  }
});

test('saveReview 每个 folder 最多保留 20 条', () => {
  for (let i = 0; i < 22; i++) {
    store.saveReview({ folder: '/r/cap', title: `T${i}`, markdown: '' });
  }
  const list = store.listReviews('/r/cap');
  assert.strictEqual(list.length, 20);
  assert.strictEqual(list[0].title, 'T21'); // 最新在前
  assert.strictEqual(list[19].title, 'T2'); // 最旧两条被淘汰
});

test('addRecentProject 去重、置顶、上限 10 个', () => {
  let list = store.addRecentProject('/p/1');
  assert.deepStrictEqual(list, ['/p/1']);

  list = store.addRecentProject('/p/2');
  list = store.addRecentProject('/p/1'); // 重复，应置顶且不重复
  assert.deepStrictEqual(list, ['/p/1', '/p/2']);
  assert.deepStrictEqual(store.getRecentProjects(), ['/p/1', '/p/2']);

  for (let i = 3; i <= 12; i++) store.addRecentProject(`/p/${i}`);
  list = store.getRecentProjects();
  assert.strictEqual(list.length, 10);
  assert.strictEqual(list[0], '/p/12');
  assert.strictEqual(list[9], '/p/3'); // /p/1 /p/2 被淘汰
});

test('addRecentProject 非法输入返回当前列表且不写入', () => {
  const before = store.getRecentProjects();
  assert.deepStrictEqual(store.addRecentProject(''), before);
  assert.deepStrictEqual(store.addRecentProject(null), before);
  assert.deepStrictEqual(store.addRecentProject(123), before);
  assert.deepStrictEqual(store.getRecentProjects(), before);
});

test('getRecentProjects 过滤非字符串项', () => {
  fs.writeFileSync(
    path.join(tmpDir, 'recent-projects.json'),
    JSON.stringify(['/p/ok', 123, null, {}, '/p/ok2']),
    'utf8',
  );
  assert.deepStrictEqual(store.getRecentProjects(), ['/p/ok', '/p/ok2']);
});

test('存储文件损坏时回退默认值', () => {
  fs.writeFileSync(path.join(tmpDir, 'recent-projects.json'), '{bad json', 'utf8');
  assert.deepStrictEqual(store.getRecentProjects(), []);
  fs.writeFileSync(path.join(tmpDir, 'review-history.json'), 'not json', 'utf8');
  assert.deepStrictEqual(store.listReviews('/r/a'), []);
});

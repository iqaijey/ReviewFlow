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
  fs.writeFileSync(path.join(tmpDir, 'review-checklist.json'), '{broken checklist', 'utf8');
  assert.deepStrictEqual(store.listChecklist('/r/a'), []);
  store.addRecentProject('/recovered');
  store.saveReview({ folder: '/recovered', markdown: 'new' });
  store.saveChecklist('/recovered', []);
  for (const [file, content] of [
    ['recent-projects.json', '{bad json'],
    ['review-history.json', 'not json'],
    ['review-checklist.json', '{broken checklist'],
  ]) {
    const backups = fs.readdirSync(tmpDir).filter((name) => name.startsWith(`${file}.corrupt-`));
    assert.strictEqual(backups.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(tmpDir, backups[0]), 'utf8'), content);
  }
});

test('v1 惰性迁移保留字段，缺 ID 稳定，不立即改写文件', () => {
  const file = path.join(tmpDir, 'review-checklist.json');
  const raw = JSON.stringify({ '/legacy': [{ text: 'src/a.js:12 空数组', status: 'wontfix', createdAt: 123 }] });
  fs.writeFileSync(file, raw);
  const item = store.listChecklist('/legacy')[0];
  assert.strictEqual(item.schemaVersion, 2);
  assert.strictEqual(item.updatedAt, 123);
  assert.strictEqual(item.category, '其他');
  assert.strictEqual(item.severity, null);
  assert.strictEqual(item.dismissal, null);
  assert.strictEqual(item.location.path, 'src/a.js');
  assert.strictEqual(store.listChecklist('/legacy')[0].id, item.id);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), raw);
});

test('兼容保存不丢 v2 字段，状态乐观锁拒绝旧版本', () => {
  const item = { id: 'v2', text: '问题', severity: '高', category: '安全', createdAt: 1, updatedAt: 2, lastSeenReviewId: 'r' };
  store.saveChecklist('/v2', [item]);
  const saved = store.saveChecklist('/v2', [{ id: 'v2', text: '问题', status: 'fixed' }])[0];
  assert.strictEqual(saved.severity, '高');
  assert.strictEqual(saved.lastSeenReviewId, 'r');
  assert.throws(() => store.setChecklistStatus({ folder: '/v2', id: 'v2', status: 'pending', expectedUpdatedAt: 1 }), /已更新/);
  assert.strictEqual(store.setChecklistStatus({ folder: '/v2', id: 'v2', status: 'pending', expectedUpdatedAt: 2 })[0].status, 'pending');
});

test('清单容量不静默丢弃活动问题，优先移除最旧终态', () => {
  const items = Array.from({ length: 201 }, (_, i) => ({ id: `cap${i}`, text: `问题${i}`, status: 'pending', createdAt: i }));
  assert.throws(() => store.saveChecklist('/active-cap', items), /200/);
  items[0].status = 'fixed';
  const result = store.saveChecklist('/active-cap', items);
  assert.strictEqual(result.length, 200);
  assert.strictEqual(result.some((f) => f.id === 'cap0'), false);
});

test('明确 dismissal 事件独立保存，旧式不处理不追溯计数，事件和建议有上限', () => {
  store.saveChecklist('/events', ['a', 'b', 'c'].map((id) => ({ id, text: '空账户列表访问首项导致崩溃', createdAt: 1, category: '正确性' })));
  store.setChecklistStatus({ folder: '/events', id: 'a', status: 'wontfix' });
  assert.strictEqual(store.getDismissals('/events').events.length, 0);
  for (const id of ['a', 'b', 'c']) store.setChecklistStatus({ folder: '/events', id, status: 'wontfix', dismissal: { reason: 'intentional', note: '' } });
  assert.strictEqual(store.getDismissals('/events').events.length, 3);
  assert.strictEqual(store.getDismissals('/events').suggestions.length, 1);
  store.saveChecklist('/events', []);
  assert.strictEqual(store.getDismissals('/events').events.length, 3);
  store.saveDismissals('/caps', { events: Array.from({ length: 501 }, (_, i) => ({ id: i })), suggestions: Array.from({ length: 101 }, (_, i) => ({ id: i })) });
  assert.strictEqual(store.getDismissals('/caps').events.length, 500);
  assert.strictEqual(store.getDismissals('/caps').suggestions.length, 100);
});

test('有效 JSON 的非法容器不被覆盖', () => {
  const file = path.join(tmpDir, 'review-checklist.json');
  fs.writeFileSync(file, '[]');
  assert.throws(() => store.saveChecklist('/invalid', []), /结构无效/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '[]');
});

test('历史 v1 默认值和稳定逻辑 ID upsert', () => {
  fs.writeFileSync(path.join(tmpDir, 'review-history.json'), JSON.stringify({ '/old': [{ id: 'old', kind: 'unknown-kind', createdAt: 7, markdown: '原文', stats: { sectionFeedback: { 安全: 1 } } }] }));
  const old = store.listReviews('/old')[0];
  assert.strictEqual(old.updatedAt, 7);
  assert.strictEqual(old.pinned, false);
  assert.strictEqual(old.provenance, null);
  assert.deepStrictEqual(old.findings, []);
  assert.strictEqual(old.kind, 'unknown-kind');
  store.saveReview({ folder: '/upsert', id: 'logical', markdown: '一' });
  store.saveReview({ folder: '/upsert', id: 'logical', markdown: '二' });
  assert.strictEqual(store.listReviews('/upsert').length, 1);
  assert.strictEqual(store.listReviews('/upsert')[0].markdown, '二');
});

test('固定记录豁免20条限制，取消固定重新应用保留策略', () => {
  const folder = '/pins';
  const first = store.saveReview({ folder, markdown: '最早' });
  store.setReviewPinned({ folder, id: first.id, pinned: true });
  for (let i = 0; i < 22; i++) store.saveReview({ folder, title: `新${i}` });
  assert.strictEqual(store.listReviews(folder).length, 21);
  assert.strictEqual(store.listReviews(folder)[0].id, first.id);
  store.setReviewPinned({ folder, id: first.id, pinned: false });
  assert.strictEqual(store.listReviews(folder).length, 20);
  assert.strictEqual(store.getReview({ folder, id: first.id }), null);
});
test('重命名保留来源日期，字面搜索包含路径和模型，删除幂等', () => {
  const folder = '/manage';
  const provenance = { files: [{ path: 'Src/[a].js' }], backends: [{ backend: 'codex', resolvedModel: 'GPT-test' }] };
  const perModel = [{ slotId: 'syn', role: 'synthesizer', backend: 'codex', model: 'GPT-test', effort: 'high', outcome: 'partial', markdown: '原始', error: '故障', stats: { sectionFeedback: 1 } }];
  const entry = store.saveReview({ folder, markdown: '报告', provenance, perModel });
  const renamed = store.renameReview({ folder, id: entry.id, title: ' 新标题 ' });
  assert.strictEqual(renamed.title, '新标题');
  assert.strictEqual(renamed.createdAt, entry.createdAt);
  assert.ok(renamed.updatedAt > entry.updatedAt);
  assert.deepStrictEqual(renamed.provenance, provenance);
  assert.deepStrictEqual(store.getReview({ folder, id: entry.id }).perModel, perModel);
  for (const query of ['新标题', '报告', '[A].JS', 'gpt-TEST', 'CODEX']) assert.strictEqual(store.listReviews(folder, { query }).length, 1);
  assert.strictEqual(store.listReviews(folder, { query: '.*' }).length, 0);
  assert.strictEqual(store.listReviews(folder, { kind: 'full' }).length, 0);
  for (const title of ['', ' ', 'x'.repeat(201), null]) assert.throws(() => store.renameReview({ folder, id: entry.id, title }), /标题/);
  assert.deepStrictEqual(store.deleteReview({ folder, id: entry.id }), { deleted: true });
  assert.deepStrictEqual(store.deleteReview({ folder, id: entry.id }), { deleted: false });
});

test('清空问题清单需要确认，只清当前项目，不影响其他项目和评审历史', () => {
  fs.rmSync(path.join(tmpDir, 'review-checklist.json'), { force: true });
  store.saveChecklist('/r/clear-a', [{ text: 'A 的问题一' }, { text: 'A 的问题二', status: 'fixed' }]);
  store.saveChecklist('/r/clear-b', [{ text: 'B 的问题' }]);
  store.saveReview({ folder: '/r/clear-a', markdown: '历史保留' });
  assert.throws(() => store.clearChecklist({ folder: '/r/clear-a' }), /需要确认/);
  assert.throws(() => store.clearChecklist({ folder: '', confirmed: true }), /缺少项目路径/);
  assert.strictEqual(store.listChecklist('/r/clear-a').length, 2);
  assert.deepStrictEqual(store.clearChecklist({ folder: '/r/clear-a', confirmed: true }), []);
  assert.deepStrictEqual(store.listChecklist('/r/clear-a'), []);
  assert.strictEqual(store.listChecklist('/r/clear-b').length, 1);
  assert.strictEqual(store.listReviews('/r/clear-a').length, 1);
  assert.deepStrictEqual(store.clearChecklist({ folder: '/r/clear-a', confirmed: true }), []);
});

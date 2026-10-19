const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-rules-'));
const originalLoad = Module._load;
Module._load = function (id, ...args) {
  return id === 'electron' ? { app: { getPath: () => root } } : originalLoad.call(this, id, ...args);
};
const rules = require('../../main/projectRules');
const store = require('../../main/store');
after(() => { Module._load = originalLoad; fs.rmSync(root, { recursive: true, force: true }); });
function event(id, overrides = {}) {
  return { schemaVersion: 2, id, findingId: id, category: '正确性', scope: 'src/accounts/', text: '空账户列表访问首项导致崩溃', reason: 'handled_elsewhere', note: '入口已检查', createdAt: 1, ...overrides };
}
function project(name, content = '') {
  const folder = path.join(root, name);
  fs.mkdirSync(folder);
  if (content) fs.writeFileSync(path.join(folder, '.reviewflow.md'), content);
  const data = rules.suggestRules({ events: ['a', 'b', 'c'].map((id) => event(id)), suggestions: [] });
  store.saveDismissals(folder, data);
  return { folder, suggestion: data.suggestions[0], file: path.join(folder, '.reviewflow.md') };
}
test('三个不同 finding 才建议，重复事件不计数且建议固定', () => {
  assert.equal(rules.suggestRules({ events: [event('a'), event('a'), event('b')], suggestions: [] }).suggestions.length, 0);
  const data = rules.suggestRules({ events: ['a', 'b', 'c'].map((id) => event(id)), suggestions: [] });
  assert.equal(data.suggestions.length, 1);
  assert.deepEqual(data.suggestions[0].memberFindingIds, ['a', 'b', 'c']);
  data.suggestions[0].state = 'dismissed';
  const again = rules.suggestRules(data);
  assert.equal(again.suggestions.length, 1);
  assert.equal(again.suggestions[0].state, 'dismissed');
  assert.equal(again.suggestions[0].snippet, rules.suggestRules({ ...data, suggestions: [] }).suggestions[0].snippet);
});
test('原因、目录、类别和 other 说明隔离分组', () => {
  for (const overrides of [{ category: '性能' }, { scope: 'other/' }, { reason: 'false_positive' }, { text: '完全不同的内存资源问题' }]) {
    assert.equal(rules.suggestRules({ events: [event('a'), event('b'), event('c', overrides)], suggestions: [] }).suggestions.length, 0);
  }
  assert.equal(rules.suggestRules({ events: [event('a', { reason: 'other' }), event('b', { reason: 'other' }), event('c', { reason: 'other', note: '不同说明' })], suggestions: [] }).suggestions.length, 0);
  assert.throws(() => rules.validateDismissal({ reason: 'other', note: '  ' }), /说明/);
  assert.throws(() => rules.validateDismissal({ reason: 'intentional', note: 'x'.repeat(501) }), /500/);
});
test('预览不写盘，确认保留原始字节，重复确认幂等', () => {
  const p = project('append', '\uFEFF# 原约定\r\n');
  const before = fs.readFileSync(p.file);
  const preview = rules.previewAppend({ folder: p.folder, suggestionId: p.suggestion.id, snippet: '### 编辑后的规则\n- 说明' });
  assert.deepEqual(fs.readFileSync(p.file), before);
  assert.throws(() => rules.appendRule({ folder: p.folder, previewId: preview.previewId, confirmed: false }), /确认/);
  const result = rules.appendRule({ folder: p.folder, previewId: preview.previewId, confirmed: true });
  assert.equal(result.suggestion.state, 'applied');
  const bytes = fs.readFileSync(p.file);
  assert.deepEqual(bytes.subarray(0, before.length), before);
  assert.equal(bytes.toString(), preview.resultingText);
  rules.appendRule({ folder: p.folder, previewId: preview.previewId, confirmed: true });
  assert.deepEqual(fs.readFileSync(p.file), bytes);
});
test('预览 hash 冲突和跨项目 preview 拒绝', () => {
  const p = project('conflict', '旧规则');
  const preview = rules.previewAppend({ folder: p.folder, suggestionId: p.suggestion.id, snippet: '新规则' });
  fs.writeFileSync(p.file, '人工修改');
  assert.throws(() => rules.appendRule({ folder: p.folder, previewId: preview.previewId, confirmed: true }), /变化/);
  assert.throws(() => rules.appendRule({ folder: root, previewId: preview.previewId, confirmed: true }), /预览/);
  assert.equal(fs.readFileSync(p.file, 'utf8'), '人工修改');
});
test('拒绝符号链接、目录和预览后替换成 symlink', () => {
  const p = project('symlink');
  const outside = path.join(root, 'outside');
  fs.writeFileSync(outside, '不可修改');
  fs.symlinkSync(outside, p.file);
  assert.throws(() => rules.previewAppend({ folder: p.folder, suggestionId: p.suggestion.id, snippet: '规则' }), /普通文件/);
  fs.unlinkSync(p.file);
  fs.mkdirSync(p.file);
  assert.throws(() => rules.previewAppend({ folder: p.folder, suggestionId: p.suggestion.id, snippet: '规则' }), /普通文件/);
  fs.rmdirSync(p.file);
  const preview = rules.previewAppend({ folder: p.folder, suggestionId: p.suggestion.id, snippet: '规则' });
  fs.symlinkSync(outside, p.file);
  assert.throws(() => rules.appendRule({ folder: p.folder, previewId: preview.previewId, confirmed: true }), /普通文件/);
  assert.equal(fs.readFileSync(outside, 'utf8'), '不可修改');
});
test('超过注入限制时预览和追加都可见警告', () => {
  const p = project('truncated', 'x'.repeat(4001));
  const preview = rules.previewAppend({ folder: p.folder, suggestionId: p.suggestion.id, snippet: '新规则' });
  assert.equal(preview.truncatedByPromptLimit, true);
  const result = rules.appendRule({ folder: p.folder, previewId: preview.previewId, confirmed: true });
  assert.equal(result.persistenceWarnings.length, 1);
});
test('dismissed 建议状态可持久化，applied 不会撤销文件', () => {
  const p = project('dismiss');
  assert.equal(rules.dismissSuggestion({ folder: p.folder, id: p.suggestion.id }).state, 'dismissed');
  assert.equal(rules.listSuggestions({ folder: p.folder })[0].state, 'dismissed');
});

test('注入预算剔除 ignore 块并计入来源标题，根规则警告为 4000 字', () => {
  const p = project('ignore-budget', '```reviewflow-ignore\n' + '# 注释\n'.repeat(1000) + '```\n短规则');
  const preview = rules.previewAppend({ folder: p.folder, suggestionId: p.suggestion.id, snippet: '新规则' });
  assert.equal(preview.truncatedByPromptLimit, false);
  const header = project('header-budget', 'x'.repeat(3950));
  const next = rules.previewAppend({ folder: header.folder, suggestionId: header.suggestion.id, snippet: '新规则' });
  assert.equal(next.truncatedByPromptLimit, true);
  assert.match(rules.appendRule({ folder: header.folder, previewId: next.previewId, confirmed: true }).persistenceWarnings[0], /4000 字/);
});

test('4200 字根规则即使存在无关嵌套规则仍按 4000 字预警', () => {
  const p = project('nested-budget', 'x'.repeat(4200));
  require('child_process').execFileSync('git', ['-C', p.folder, 'init', '-q'], { env: { ...process.env, GIT_MASTER: '1' } });
  fs.mkdirSync(path.join(p.folder, 'src'));
  fs.writeFileSync(path.join(p.folder, 'src', '.reviewflow.md'), 'nested');
  const preview = rules.previewAppend({ folder: p.folder, suggestionId: p.suggestion.id, snippet: '新规则' });
  assert.equal(preview.truncatedByPromptLimit, true);
  const warning = rules.appendRule({ folder: p.folder, previewId: preview.previewId, confirmed: true }).persistenceWarnings[0];
  assert.match(warning, /4000 字/);
  assert.match(warning, /有自己的.*\.reviewflow\.md.*8000 字/);
});

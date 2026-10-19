const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const rules = require('../../main/effectiveRules');

function fixture(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-layered-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  execFileSync('git', ['-C', folder, 'init', '-q'], { env: { ...process.env, GIT_MASTER: '1' } });
  const write = (name, content) => { fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true }); fs.writeFileSync(path.join(folder, name), content); };
  return { folder, write };
}

test('分层规则按根至深层排序，兄弟目录不注入，ignore 块剥离', (t) => {
  const r = fixture(t);
  r.write('.reviewflow.md', 'root\n```reviewflow-ignore\n*.map\n```\nend');
  r.write('src/.reviewflow.md', 'src'); r.write('src/deep/.reviewflow.md', 'deep'); r.write('other/.reviewflow.md', 'other');
  const result = rules.getEffectiveRules({ folder: r.folder, paths: ['src/deep/a.js'] });
  assert.deepEqual(result.files.map((f) => f.path), ['.reviewflow.md', 'src/.reviewflow.md', 'src/deep/.reviewflow.md']);
  assert.equal(result.text, '### 规则来源：.reviewflow.md\nroot\nend\n\n### 规则来源：src/.reviewflow.md\nsrc\n\n### 规则来源：src/deep/.reviewflow.md\ndeep');
  assert.deepEqual(rules.rootIgnorePatterns(r.folder), ['*.map']); assert.equal(result.truncated, false);
});

test('root-only 注入 4000、嵌套 8000，较深规则先截断且显式标记', (t) => {
  const r = fixture(t); r.write('.reviewflow.md', 'r'.repeat(3900)); r.write('src/.reviewflow.md', 's'.repeat(5000)); r.write('src/deep/.reviewflow.md', 'd'.repeat(100));
  const result = rules.getEffectiveRules({ folder: r.folder, paths: ['src/deep/a'] });
  assert.equal(result.text.length, 8000); assert.equal(result.truncated, true); assert.equal(result.totalChars, 9000);
  assert.deepEqual(result.files.map((f) => [f.included, f.truncated]), [[true, false], [true, true], [false, true]]);
  r.write('.reviewflow.md', 'r'.repeat(5000));
  const root = rules.getEffectiveRules({ folder: r.folder, paths: [] });
  assert.equal(root.text.length, 4000); assert.equal(root.files[0].truncated, true);
});

test('缓存发现新增文件、mtime 变化和删除，冻结规则可按批次筛选', (t) => {
  const r = fixture(t); r.write('.reviewflow.md', 'root'); r.write('a/.reviewflow.md', 'a');
  const captured = rules.captureRules(r.folder, ['a/x', 'b/x']);
  r.write('b/.reviewflow.md', 'b'); r.write('a/.reviewflow.md', 'changed');
  const fresh = rules.captureRules(r.folder, ['a/x', 'b/x']);
  assert.notEqual(fresh.fileHash, captured.fileHash);
  assert.deepEqual(fresh.files.map((f) => f.path), ['.reviewflow.md', 'a/.reviewflow.md', 'b/.reviewflow.md']);
  const frozen = require('../../main/ai/planContext').rulesForPaths(captured, ['a/x']);
  assert.equal(frozen.text.endsWith('\na'), true);
  fs.unlinkSync(path.join(r.folder, 'a/.reviewflow.md'));
  assert.deepEqual(rules.getEffectiveRules({ folder: r.folder, paths: ['a/x'] }).files.map((f) => f.path), ['.reviewflow.md']);
});

test('规则文件最多 50 且拒绝越界查询路径与符号链接', (t) => {
  const r = fixture(t); r.write('.reviewflow.md', 'root');
  for (let i = 0; i < 60; i++) r.write(`d${i}/.reviewflow.md`, 'rule');
  assert.equal(rules.discoverRules(r.folder).length, 50);
  assert.throws(() => rules.getEffectiveRules({ folder: r.folder, paths: ['../secret'] }), /相对路径/);
  r.write('link/target', 'secret'); fs.symlinkSync('target', path.join(r.folder, 'link/.reviewflow.md'));
  assert.equal(rules.getEffectiveRules({ folder: r.folder, paths: ['link/a'] }).text.includes('secret'), false);
});

test('反引号和波浪围栏移除，不移除普通代码块', () => {
  const parsed = rules.parseRules('before\n~~~~reviewflow-ignore\na/\n~~~~\n```js\nconst x = 1\n```\n```reviewflow-ignore\nb\n```\nafter');
  assert.deepEqual(parsed.patterns, ['a/', 'b']); assert.equal(parsed.text.includes('const x = 1'), true);
  assert.equal(parsed.text.includes('reviewflow-ignore'), false);
});

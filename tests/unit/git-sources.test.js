const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getChanges } = require('../../main/git');
const snapshots = require('../../main/reviewSnapshot');

function repo(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-sources-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8', env: { ...process.env, GIT_MASTER: '1' } }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test');
  const write = (name, text) => { fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true }); fs.writeFileSync(path.join(folder, name), text); };
  const commit = (name, text) => { write(name, text); git('add', '--', name); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  return { folder, git, write, commit };
}

test('staged 在 unborn HEAD 读取索引且不含未跟踪文件', async (t) => {
  const r = repo(t); r.write('index.js', 'index\n'); r.git('add', 'index.js'); r.write('new.js', 'new\n');
  const result = await getChanges(r.folder, { mode: 'staged' });
  assert.equal(result.source.headSha, null);
  assert.equal(result.source.semantics, 'head-to-index');
  assert.deepEqual(result.files.map((f) => f.path), ['index.js']);
});

test('staged / unstaged / untracked 隔离，旧 uncommitted 仍为净改动', async (t) => {
  const r = repo(t); r.commit('a.js', 'head\n'); r.write('a.js', 'index\n'); r.git('add', 'a.js'); r.write('a.js', 'work\n'); r.write('new.js', 'new\n');
  const lines = (result) => result.files.flatMap((f) => f.hunks.flatMap((h) => h.lines.map((l) => l.content)));
  const staged = await getChanges(r.folder, { mode: 'staged' });
  assert.deepEqual(lines(staged), ['head', 'index']);
  const unstaged = await getChanges(r.folder, { mode: 'unstaged' });
  assert.equal(unstaged.source.semantics, 'index-to-worktree'); assert.deepEqual(lines(unstaged), ['index', 'work']);
  const untracked = await getChanges(r.folder, { mode: 'untracked' });
  assert.equal(untracked.source.semantics, 'untracked-only'); assert.deepEqual(untracked.files.map((f) => f.path), ['new.js']);
  const legacy = await getChanges(r.folder);
  assert.deepEqual(lines(legacy), ['head', 'work', 'new']);
  await assert.rejects(getChanges(r.folder, { mode: 'staged', base: 'HEAD' }), /不一致/);
});

test('连续提交按首父链输出一个净 diff，与传入顺序无关', async (t) => {
  const r = repo(t); const parent = r.commit('a.js', 'base\n'); const oldest = r.commit('a.js', 'intermediate\n'); const newest = r.commit('a.js', 'final\n');
  const result = await getChanges(r.folder, { mode: 'commits', commits: [oldest, newest] });
  assert.equal(result.source.semantics, 'commit-range'); assert.equal(result.source.nonContiguous, undefined);
  assert.equal(result.source.baseSha, parent);
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.files[0].hunks[0].lines.map((l) => l.content), ['base', 'final']);
});

test('非连续提交保留逐提交 show 并显式标记', async (t) => {
  const r = repo(t); const first = r.commit('a.js', 'one\n'); r.commit('a.js', 'two\n'); const last = r.commit('a.js', 'three\n');
  const result = await getChanges(r.folder, { commits: [last, first] });
  assert.equal(result.source.semantics, 'concatenated-show'); assert.equal(result.source.nonContiguous, true);
  assert.equal(result.files.length, 2);
});

test('根提交范围从仓库空树开始', async (t) => {
  const r = repo(t); const root = r.commit('root.js', 'root\n'); const next = r.commit('root.js', 'next\n');
  const result = await getChanges(r.folder, { commits: [next, root] });
  assert.equal(result.source.semantics, 'commit-range');
  assert.equal(result.source.baseSha, r.git('hash-object', '-t', 'tree', '/dev/null'));
  assert.equal(result.files[0].status, 'added'); assert.deepEqual(result.files[0].hunks[0].lines.map((l) => l.content), ['next']);
});

test('合并提交连续性只使用第一父提交', async (t) => {
  const r = repo(t); r.commit('base.js', 'base\n'); r.git('checkout', '-qb', 'side'); const side = r.commit('side.js', 'side\n');
  r.git('checkout', '-q', 'main'); const firstParent = r.commit('main.js', 'main\n'); r.git('merge', '--no-ff', '-qm', 'merge', 'side');
  const merge = r.git('rev-parse', 'HEAD');
  const chain = await getChanges(r.folder, { commits: [merge, firstParent] });
  assert.equal(chain.source.semantics, 'commit-range'); assert.equal(chain.source.commits[0].parentShas[0], firstParent);
  assert.deepEqual(chain.files.map((f) => f.path), ['main.js', 'side.js']);
  assert.equal((await getChanges(r.folder, { commits: [merge, side] })).source.nonContiguous, true);
});

test('默认与根 ignore 规则叠加，排除文件仍保留且快照冻结标记', async (t) => {
  const r = repo(t); r.commit('a.js', 'a\n'); r.write('package-lock.json', '{}'); r.write('nested/yarn.lock', 'lock'); r.write('generated.js', 'gen');
  r.write('.reviewflow.md', 'rules\n```reviewflow-ignore\ngenerated.js\n!nested/yarn.lock\n```\n');
  const result = await getChanges(r.folder);
  assert.equal(result.files.find((f) => f.path === 'package-lock.json').excludedBy, '**/package-lock.json');
  assert.equal(result.files.find((f) => f.path === 'generated.js').excludedBy, 'generated.js');
  assert.equal(result.files.find((f) => f.path === 'nested/yarn.lock').excluded, undefined);
  const frozen = snapshots.getSnapshotFiles(result.snapshotId, r.folder);
  assert.equal(frozen.find((f) => f.path === 'generated.js').excluded, true);
  assert.equal(snapshots.getSnapshot(result.snapshotId, r.folder).files.find((f) => f.path === 'generated.js').excluded, true);
});

test('限制元数据覆盖文件上限、行截断及未跟踪跳过原因', async (t) => {
  const r = repo(t); r.commit('base.js', 'base\n');
  for (let i = 0; i < 255; i++) r.write(`f${String(i).padStart(3, '0')}.txt`, i === 0 ? 'line\n'.repeat(3001) : 'x');
  r.write('binary', Buffer.from([0, 1])); r.write('large', 'x'.repeat(500 * 1024 + 1));
  fs.symlinkSync('absent', path.join(r.folder, 'unreadable'));
  const result = await getChanges(r.folder, { mode: 'untracked' });
  assert.equal(result.files.length, 200); assert.equal(result.limits.totalFiles, 255); assert.equal(result.limits.maxFiles, 200);
  assert.equal(result.limits.omittedFiles.length, 50); assert.equal(result.limits.omittedFiles[0], 'f200.txt');
  assert.deepEqual(result.limits.truncatedFiles, [{ path: 'f000.txt', shownLines: 3000 }]);
  assert.deepEqual(result.limits.skippedUntracked, [{ path: 'binary', reason: 'binary' }, { path: 'large', reason: 'too-large' }, { path: 'unreadable', reason: 'unreadable' }]);
});

test('未跟踪符号链接不读取仓库外内容并记录 unreadable', async (t) => {
  const r = repo(t); r.commit('base.js', 'base\n');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'secret'), 'private-secret');
  fs.symlinkSync(path.join(outside, 'secret'), path.join(r.folder, 'leak'));
  const result = await getChanges(r.folder, { mode: 'untracked' });
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.limits.skippedUntracked, [{ path: 'leak', reason: 'unreadable' }]);
  assert.equal(JSON.stringify(result).includes('private-secret'), false);
});

test('两点范围比较两个端点，三点范围比较合并基点到右端，忽略工作区改动', async (t) => {
  const r = repo(t); const common = r.commit('a.js', 'common\n');
  const left = r.commit('left.js', 'left\n');
  r.git('checkout', '-qb', 'side', common);
  const right = r.commit('right.js', 'right\n');
  r.write('right.js', 'worktree-only\n');
  for (const mode of ['branch', 'ref']) {
    const two = await getChanges(r.folder, { mode, base: 'main..side' });
    assert.deepEqual(two.files.map((f) => [f.path, f.status]), [['left.js', 'deleted'], ['right.js', 'added']]);
    assert.equal(two.source.baseSha, left);
    assert.deepEqual(two.source.revisionRange, { fromSha: left, toSha: right, operator: '..' });
    const three = await getChanges(r.folder, { mode, base: 'main...side' });
    assert.deepEqual(three.files.map((f) => f.path), ['right.js']);
    assert.equal(three.source.baseSha, common);
    assert.deepEqual(three.source.revisionRange, { fromSha: left, toSha: right, operator: '...' });
    assert.equal(JSON.stringify(three.files).includes('worktree-only'), false);
  }
  for (const base of ['-x..HEAD', 'HEAD..--output=x']) await assert.rejects(getChanges(r.folder, { mode: 'ref', base }), /不是有效/);
});

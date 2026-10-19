const { test } = require('node:test');
const assert = require('node:assert/strict');
const snapshots = require('../../main/reviewSnapshot');

const file = { path: 'src/账户.js', status: 'modified', hunks: [{ header: '@@ -1 +1 @@', lines: [
  { type: 'del', oldLine: 1, newLine: null, content: 'old' },
  { type: 'add', oldLine: null, newLine: 1, content: 'new' },
] }] };
test('指纹只取有序 diff 字段，保持稳定且不保存凭据', () => {
  const a = snapshots.captureSnapshot('/r', [file], null);
  const b = snapshots.captureSnapshot('/r', [{ ...file, apiKey: 'secret', classes: ['ignored'] }], null);
  assert.equal(a.diffFingerprint, b.diffFingerprint);
  assert.match(a.diffFingerprint, /^[a-f0-9]{64}$/);
  assert.notEqual(a.snapshotId, b.snapshotId);
  assert.equal(JSON.stringify(b).includes('secret'), false);
  assert.notEqual(a.diffFingerprint, snapshots.captureSnapshot('/r', [{ ...file, oldPath: 'old.js' }], null).diffFingerprint);
});
test('提交顺序影响整体指纹，文件内容顺序也不能交换', () => {
  const source = { mode: 'commits', requestedBase: null, branch: 'main', headSha: 'a', baseSha: null,
    commits: [{ sha: 'a', parentShas: ['b'] }, { sha: 'b', parentShas: [] }], semantics: 'concatenated-show' };
  const a = snapshots.captureSnapshot('/r', [file], source);
  const b = snapshots.captureSnapshot('/r', [file], { ...source, commits: [...source.commits].reverse() });
  assert.notEqual(a.diffFingerprint, b.diffFingerprint);
  assert.notEqual(a.diffFingerprint, snapshots.captureSnapshot('/r', [{ ...file, hunks: [{ ...file.hunks[0], lines: [...file.hunks[0].lines].reverse() }] }], source).diffFingerprint);
});
test('新增删除重命名与资源文件记录完整边界标志', () => {
  const snapshot = snapshots.captureSnapshot('/r', [
    { ...file, status: 'added' }, { ...file, path: 'gone.js', status: 'deleted', truncated: true },
    { ...file, path: 'new.js', oldPath: 'old.js', status: 'renamed' },
    { ...file, path: 'image.png', resource: true },
  ], null);
  assert.deepEqual(snapshot.files.map((f) => [f.status, f.oldPath, f.reviewed, f.truncated]), [
    ['added', null, false, false], ['deleted', null, false, true], ['renamed', 'old.js', false, false], ['modified', null, false, false],
  ]);
  assert.equal(snapshot.files[3].resource, true);
});
test('快照注册表保留最近20项和活跃引用，读取隔离且项目隔离', () => {
  const a = snapshots.captureSnapshot('/bounded', [file], null);
  require('../../main/ai/runControl').ensureLane('active').batchRunActive = true;
  snapshots.retainSnapshot(a.snapshotId, 'active');
  for (let i = 0; i < 25; i++) snapshots.captureSnapshot('/bounded', [], null);
  assert.ok(snapshots.getSnapshot(a.snapshotId, '/bounded'));
  assert.equal(snapshots.getSnapshot(a.snapshotId, '/other'), null);
  snapshots.getSnapshot(a.snapshotId, '/bounded').files[0].path = 'mutated';
  assert.equal(snapshots.getSnapshot(a.snapshotId, '/bounded').files[0].path, file.path);
  snapshots.releaseSnapshot(a.snapshotId, 'active');
  require('../../main/ai/state').lanes.delete('active');
  assert.equal(snapshots.getSnapshot(a.snapshotId, '/bounded'), null);
});

function fakeGit({ unborn = false } = {}) {
  const fs = require('node:fs'), vm = require('node:vm');
  const { createRequire } = require('node:module');
  const filename = require.resolve('../../main/git'), localRequire = createRequire(filename);
  const calls = [], module = { exports: {} };
  const execFile = (cmd, args, options, done) => {
    args = args.slice(2); calls.push(args);
    let stdout = '';
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') stdout = 'true';
    else if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') stdout = 'main';
    else if (args[0] === 'symbolic-ref') stdout = 'main';
    else if (args[0] === 'rev-parse') {
      if (unborn && args.at(-1).startsWith('HEAD')) return done(new Error('unborn'));
      stdout = args.at(-1) === 'HEAD^{commit}' || args.at(-1) === 'HEAD' ? 'a'.repeat(40) : 'b'.repeat(40);
    } else if (args[0] === 'show-ref') {
      if (args.at(-1) !== 'refs/heads/main') return done(new Error('not a local branch'));
      stdout = 'b'.repeat(40);
    } else if (args[0] === 'show' && args.includes('-s')) stdout = 'c'.repeat(40);
    else if (args[0] === 'diff' || args[0] === 'show') stdout = 'diff --git a/gone.js b/gone.js\ndeleted file mode 100644\n--- a/gone.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone';
    done(null, stdout, '');
  };
  execFile[require('node:util').promisify.custom] = (...args) => new Promise((resolve, reject) => execFile(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: (id) => id === 'child_process' ? { execFile } : localRequire(id), module }, { filename });
  return { git: module.exports, calls };
}
test('unborn HEAD 来源为 null，仍读取暂存 diff', async () => {
  const { git, calls } = fakeGit({ unborn: true });
  const result = await git.getChanges('/virtual');
  assert.equal(result.source.headSha, null);
  assert.equal(result.source.branch, 'main');
  assert.equal(result.source.mode, 'uncommitted');
  assert.ok(calls.some((args) => args[0] === 'diff' && args.includes('--cached')));
  assert.equal(result.files[0].diffFingerprint, snapshots.fileDiffFingerprint(result.files[0]));
});
test('分支与自定义 ref 区分来源但保持 base-to-worktree，不允许选项注入', async () => {
  const { git, calls } = fakeGit();
  const branch = await git.getChanges('/virtual', { base: 'main' });
  const ref = await git.getChanges('/virtual', { base: 'HEAD~1' });
  const explicit = await git.getChanges('/virtual', { base: 'main', mode: 'ref' });
  assert.equal(branch.source.mode, 'branch');
  assert.equal(ref.source.mode, 'ref');
  assert.equal(explicit.source.mode, 'ref');
  assert.equal(branch.source.semantics, 'base-to-worktree');
  assert.ok(calls.filter((args) => args[0] === 'diff').every((args) => args[1] === 'b'.repeat(40)));
  await assert.rejects(git.getChanges('/virtual', { base: '--output=/tmp/injected' }), /有效/);
  await assert.rejects(git.getChanges('/virtual', { commits: ['--output=/tmp/injected'] }), /无效/);
  assert.equal(calls.some((args) => args.some((arg) => arg.includes('/tmp/injected'))), false);
});

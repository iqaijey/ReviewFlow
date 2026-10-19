const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { createRequire } = require('module');
const { execFileSync } = require('child_process');
const safety = require('../../main/patchSafety');
const { normalizeFinding } = require('../../main/findings');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-fix-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
let sequence = 0;
function repo() {
  const folder = path.join(root, String(sequence++)); fs.mkdirSync(folder);
  const git = (...args) => execFileSync('git', ['-C', folder, ...args], { env: { ...process.env, GIT_MASTER: '1' }, encoding: 'utf8' });
  git('init', '-q'); fs.writeFileSync(path.join(folder, 'a.js'), 'old\n');
  git('add', 'a.js'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial');
  return { folder, git };
}
const diff = (file = 'a.js', prefix = true) => `diff --git ${prefix ? 'a/' : ''}${file} ${prefix ? 'b/' : ''}${file}\n--- ${prefix ? 'a/' : ''}${file}\n+++ ${prefix ? 'b/' : ''}${file}\n@@ -1 +1 @@\n-old\n+new\n`;
function harness(folder, reply = () => '```diff\n' + diff() + '```', backend = 'api') {
  let checklist = [normalizeFinding({ id: 'one', text: '空值错误', severity: '高', category: '正确性', updatedAt: 1,
    location: { path: 'a.js', side: 'new', startLine: 1, endLine: 1, anchor: { target: ['old'], before: [], after: [] } } })];
  let now = 100, saves = 0;
  const calls = [];
  const filename = require.resolve('../../main/fixLoop'), local = createRequire(filename), module = { exports: {} };
  const overrides = {
    './store': { listChecklist: () => structuredClone(checklist), saveChecklist: (_folder, list) => { saves++; checklist = list; return list; } },
    './settings': { getSettings: async () => ({ backend }) },
    './ai': { chatWithStats: async (cfg, messages, options) => { calls.push({ cfg, messages, options }); return { content: await reply(), stats: { backend } }; } },
  };
  class Clock extends Date { static now() { return now; } }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: (id) => overrides[id] || local(id), module, Date: Clock, Buffer, structuredClone }, { filename });
  return { api: module.exports, payload: { folder, findingId: 'one', runId: 'fix-run' }, calls,
    get checklist() { return checklist; }, get saves() { return saves; }, edit() { checklist[0].updatedAt++; checklist[0].status = 'wontfix'; }, tick(ms) { now += ms; } };
}
test('提取首个 diff 围栏，拒绝空值、危险路径、模式及不一致文件头', () => {
  assert.equal(safety.extractDiff('解释\n```diff\n' + diff() + '```\n```diff\nother\n```'), diff());
  for (const text of ['', '```diff\n\n```']) assert.throws(() => safety.extractDiff(text), /非空/);
  for (const file of ['../a.js', '.git/config', '.GIT/config', '/tmp/a', 'C:/a', 'a/../../b', 'a\\b']) assert.throws(() => safety.inspectDiff(diff(file)), /路径/);
  assert.throws(() => safety.inspectDiff(diff().replace('+++ b/a.js', '+++ b/other')), /重命名/);
  assert.throws(() => safety.inspectDiff(diff().replace('--- a/a.js', 'new file mode 120000\n--- a/a.js')), /模式/);
  assert.throws(() => safety.inspectDiff(diff().replace('diff --git a/a.js', 'diff --git a/other')), /不一致/);
  assert.equal(safety.inspectDiff(diff()).files[0].additions, 1);
});
test('生成只预览，确认后应用及撤销且不改 index，支持明确的无前缀回退', async () => {
  for (const prefix of [true, false]) {
    const { folder, git } = repo(), h = harness(folder, () => '```diff\n' + diff('a.js', prefix) + '```');
    const generated = await h.api.generatePatch(h.payload);
    assert.equal(generated.check.ok, true, generated.check.error);
    assert.equal(fs.readFileSync(path.join(folder, 'a.js'), 'utf8'), 'old\n');
    assert.match(h.calls[0].messages[1].content, /old/);
    assert.equal(h.calls[0].options.runId, 'fix-run');
    await assert.rejects(h.api.applyPatch({ folder, patchId: generated.patchId }), /confirmed/);
    assert.equal((await h.api.applyPatch({ folder, patchId: generated.patchId, confirmed: true })).applied, true);
    assert.equal(fs.readFileSync(path.join(folder, 'a.js'), 'utf8'), 'new\n');
    assert.equal(git('diff', '--cached'), '');
    for (const confirmed of [undefined, false, 'true', 1]) await assert.rejects(h.api.revertPatch({ folder, patchId: generated.patchId, confirmed }), /撤销补丁需要明确确认/);
    assert.equal((await h.api.revertPatch({ folder, patchId: generated.patchId, confirmed: true })).reverted, true);
    assert.equal(fs.readFileSync(path.join(folder, 'a.js'), 'utf8'), 'old\n');
    await assert.rejects(h.api.revertPatch({ folder, patchId: generated.patchId, confirmed: true }), /尚未应用/);
  }
});
test('拒绝生成后或应用后编辑，不能覆盖用户工作', async () => {
  const { folder } = repo(), h = harness(folder);
  const generated = await h.api.generatePatch(h.payload);
  fs.writeFileSync(path.join(folder, 'a.js'), 'user\n');
  await assert.rejects(h.api.applyPatch({ folder, patchId: generated.patchId, confirmed: true }), /文件已变化，请重新生成补丁/);
  fs.writeFileSync(path.join(folder, 'a.js'), 'old\n');
  await h.api.applyPatch({ folder, patchId: generated.patchId, confirmed: true });
  fs.writeFileSync(path.join(folder, 'a.js'), 'user-after\n');
  await assert.rejects(h.api.revertPatch({ folder, patchId: generated.patchId, confirmed: true }), /文件已变化/);
});
test('其他文件、排除项、资源和符号链接失败，失败预览无法应用', async () => {
  const { folder } = repo();
  fs.writeFileSync(path.join(folder, 'other.js'), 'old\n');
  const h = harness(folder, () => '```diff\n' + diff('other.js') + '```');
  const result = await h.api.generatePatch(h.payload);
  assert.match(result.check.error, /其他文件/);
  await assert.rejects(h.api.applyPatch({ folder, patchId: result.patchId, confirmed: true }), /其他文件/);
  for (const name of ['package-lock.json', 'image.png']) {
    fs.writeFileSync(path.join(folder, name), 'old\n');
    await assert.rejects(safety.validateTargets(folder, [{ path: name }], name), /排除|资源/);
  }
  fs.symlinkSync('a.js', path.join(folder, 'link.js'));
  await assert.rejects(safety.validateTargets(folder, [{ path: 'link.js' }], 'link.js'), /符号链接/);
  fs.symlinkSync(folder, path.join(folder, 'linked'));
  assert.throws(() => safety.readTarget(folder, 'linked/a.js'), /符号链接/);
  fs.writeFileSync(path.join(folder, 'binary.js'), Buffer.from([0, 1]));
  assert.throws(() => safety.readTarget(folder, 'binary.js'), /二进制/);
});
test('补丁缓存最多 20 份且 30 分钟过期，跨项目 ID 无效', async () => {
  const { folder } = repo(), h = harness(folder);
  const first = await h.api.generatePatch(h.payload);
  for (let i = 0; i < 20; i++) await h.api.generatePatch(h.payload);
  await assert.rejects(h.api.applyPatch({ folder, patchId: first.patchId, confirmed: true }), /过期/);
  const last = await h.api.generatePatch(h.payload);
  await assert.rejects(h.api.applyPatch({ folder: root, patchId: last.patchId, confirmed: true }), /过期/);
  h.tick(30 * 60 * 1000);
  await assert.rejects(h.api.applyPatch({ folder, patchId: last.patchId, confirmed: true }), /过期/);
});
test('单问题复核使用现有解析和冲突规则，无法解析不写入', async () => {
  const { folder } = repo();
  for (const [verdict, status] of Object.entries({ 已修复: 'fixed', 仍存在: 'pending', 部分修复: 'partial', 已过时: 'outdated' })) {
    const h = harness(folder, () => `[id=one] => ${verdict} | 有证据`);
    const result = await h.api.verifyFinding(h.payload);
    assert.equal(result.verdict, verdict); assert.equal(result.finding.status, status);
  }
  const invalid = harness(folder, () => '看起来好了');
  assert.equal((await invalid.api.verifyFinding(invalid.payload)).verdict, null);
  assert.equal(invalid.saves, 0);
  const edited = harness(folder, () => { edited.edit(); return '[id=one] => 已修复 | 完成'; });
  const result = await edited.api.verifyFinding(edited.payload);
  assert.equal(result.finding.status, 'wontfix'); assert.equal(result.finding.verification.applied, false);
});

test('补丁应用后复核再确认撤销恢复复核前状态及需重新复核提示', async () => {
  const { folder } = repo();
  let verify = false;
  const h = harness(folder, () => verify ? '[id=one] => 已修复 | 补丁有效' : '```diff\n' + diff() + '```');
  h.checklist[0].status = 'partial';
  h.checklist[0].lastVerifiedAt = 10;
  h.checklist[0].verification = { reviewId: 'before-patch', verdict: '部分修复', note: '原证据', applied: true, conflict: null };
  const generated = await h.api.generatePatch(h.payload);
  const mutation = { folder, patchId: generated.patchId, confirmed: true };
  await h.api.applyPatch(mutation);
  verify = true;
  assert.equal((await h.api.verifyFinding(h.payload)).finding.status, 'fixed');
  await assert.rejects(h.api.revertPatch({ ...mutation, confirmed: false }), /明确确认/);
  assert.equal(h.checklist[0].status, 'fixed');
  const reverted = await h.api.revertPatch(mutation);
  assert.equal(reverted.finding.status, 'partial');
  assert.equal(reverted.finding.lastVerifiedAt, 10);
  assert.equal(reverted.finding.verification.reviewId, 'before-patch');
  assert.equal(reverted.finding.verification.verdict, '部分修复');
  assert.equal(reverted.finding.verification.note, '补丁已撤销，需重新复核');
  assert.ok(reverted.finding.updatedAt > 1);
  assert.equal(h.checklist[0], reverted.finding);
});

test('多次补丁复核撤销仍回到最初状态，无旧验证也返回重新复核提示', async () => {
  const { folder } = repo();
  let verdict = '';
  const h = harness(folder, () => verdict ? `[id=one] => ${verdict} | 证据` : '```diff\n' + diff() + '```');
  const generated = await h.api.generatePatch(h.payload);
  const mutation = { folder, patchId: generated.patchId, confirmed: true };
  await h.api.applyPatch(mutation);
  verdict = '部分修复';
  await h.api.verifyFinding(h.payload);
  verdict = '已修复';
  await h.api.verifyFinding(h.payload);
  const reverted = await h.api.revertPatch(mutation);
  assert.equal(reverted.finding.status, 'pending');
  assert.equal(reverted.finding.lastVerifiedAt, null);
  assert.equal(reverted.finding.verification.note, '补丁已撤销，需重新复核');
  assert.equal(reverted.finding.verification.applied, false);
});

for (const userEdit of [false, true]) {
  test(`已修复后再次复核${userEdit ? '并人工编辑仍禁止恢复' : '仅更新验证记录不阻断撤销恢复'}`, async () => {
    const { folder } = repo();
    let verify = false;
    const h = harness(folder, () => verify ? '[id=one] => 已修复 | 再次确认' : '```diff\n' + diff() + '```');
    h.checklist[0].status = 'partial';
    const generated = await h.api.generatePatch(h.payload);
    const mutation = { folder, patchId: generated.patchId, confirmed: true };
    await h.api.applyPatch(mutation);
    verify = true;
    await h.api.verifyFinding(h.payload);
    const second = await h.api.verifyFinding(h.payload);
    assert.equal(second.finding.status, 'fixed');
    assert.equal(second.finding.verification.applied, false);
    if (userEdit) h.edit();
    const before = structuredClone(h.checklist[0]);
    const reverted = await h.api.revertPatch(mutation);
    if (userEdit) {
      assert.equal(reverted.finding, undefined);
      assert.deepEqual(h.checklist[0], before);
    } else {
      assert.equal(reverted.finding.status, 'partial');
      assert.equal(reverted.finding.verification.note, '补丁已撤销，需重新复核');
    }
  });
}

for (const order of [[0, 1], [1, 0]]) {
  for (const editAt of ['none', 'between', 'after']) {
    test(`重叠复核按 ${order.join('→')} 完成，人工编辑时机 ${editAt} 时撤销保护正确`, async () => {
      const { folder } = repo();
      /** @type {Array<(value:string)=>void>} */
      const complete = [];
      /** @type {Array<()=>void>} */
      const started = [];
      const ready = [0, 1].map((i) => new Promise((resolve) => { started[i] = () => resolve(); }));
      let verify = false, next = 0;
      const h = harness(folder, () => {
        if (!verify) return '```diff\n' + diff() + '```';
        const i = next++;
        return new Promise((resolve) => { complete[i] = resolve; started[i](); });
      });
      h.checklist[0].status = 'partial';
      h.checklist[0].lastVerifiedAt = 10;
      const generated = await h.api.generatePatch(h.payload);
      const mutation = { folder, patchId: generated.patchId, confirmed: true };
      await h.api.applyPatch(mutation);
      verify = true;
      const first = h.api.verifyFinding({ ...h.payload, runId: 'overlap-0' });
      await ready[0];
      const second = h.api.verifyFinding({ ...h.payload, runId: 'overlap-1' });
      await ready[1];
      const pending = [first, second];
      complete[order[0]]('[id=one] => 已修复 | 首个完成');
      assert.equal((await pending[order[0]]).finding.verification.applied, true);
      if (editAt === 'between') h.edit();
      const beforeSecond = structuredClone(h.checklist[0]);
      complete[order[1]]('[id=one] => 仍存在 | 后续完成');
      const last = await pending[order[1]];
      assert.equal(last.finding.verification.applied, false);
      assert.equal(last.finding.status, beforeSecond.status);
      assert.equal(last.finding.updatedAt, beforeSecond.updatedAt);
      if (editAt === 'after') h.edit();
      const beforeRevert = structuredClone(h.checklist[0]);
      const reverted = await h.api.revertPatch(mutation);
      assert.equal(reverted.reverted, true);
      assert.equal(fs.readFileSync(path.join(folder, 'a.js'), 'utf8'), 'old\n');
      if (editAt === 'none') {
        assert.equal(reverted.finding?.status, 'partial', '撤销必须恢复重叠复核前状态');
        assert.equal(reverted.finding.lastVerifiedAt, 10);
        assert.equal(reverted.finding.verification.note, '补丁已撤销，需重新复核');
      } else {
        assert.equal(reverted.finding, undefined);
        assert.equal(h.checklist[0].status, 'wontfix');
        assert.deepEqual(h.checklist[0], beforeRevert);
      }
    });
  }
}

test('复核后用户修改或撤销文件冲突时不覆盖问题状态', async () => {
  for (const conflict of ['finding', 'file']) {
    const { folder } = repo();
    let verify = false;
    const h = harness(folder, () => verify ? '[id=one] => 已修复 | 证据' : '```diff\n' + diff() + '```');
    const generated = await h.api.generatePatch(h.payload);
    const mutation = { folder, patchId: generated.patchId, confirmed: true };
    await h.api.applyPatch(mutation);
    verify = true;
    await h.api.verifyFinding(h.payload);
    if (conflict === 'finding') {
      h.edit();
      const before = structuredClone(h.checklist[0]);
      const result = await h.api.revertPatch(mutation);
      assert.equal(result.reverted, true);
      assert.deepEqual(h.checklist[0], before);
      assert.equal(result.finding, undefined);
    } else {
      fs.writeFileSync(path.join(folder, 'a.js'), 'user-change\n');
      await assert.rejects(h.api.revertPatch(mutation), /文件已变化/);
      assert.equal(h.checklist[0].status, 'fixed');
    }
  }
});
test('交接包含问题、锚点、规范和只展示命令，不调用 AI 或执行 agent', async () => {
  const { folder } = repo(), h = harness(folder);
  fs.writeFileSync(path.join(folder, '.reviewflow.md'), '保持公共协议');
  const result = h.api.handoffPrompt({ folder, findingIds: ['one'] });
  for (const text of ['one', '高', '正确性', 'a.js:1-1', 'old', '保持公共协议', '不要暂存或提交', '测试', '预期验证']) assert.ok(result.markdown.includes(text), text);
  assert.match(result.commands[0].command, /opencode run --dir/);
  assert.match(result.commands[1].command, /codex exec --cd .* - < reviewflow-fix-prompt.md/);
  assert.equal(h.calls.length, 0);
  const unsafe = harness(folder, undefined, 'opencode');
  await assert.rejects(unsafe.api.generatePatch(unsafe.payload), /只读/);
  assert.equal(unsafe.calls.length, 0);
});
test('生成捕获 AI 调用前的哈希，生成期间用户修改不能被应用覆盖', async () => {
  const { folder } = repo();
  const h = harness(folder, () => { fs.writeFileSync(path.join(folder, 'a.js'), 'during-generation\n'); return '```diff\n' + diff() + '```'; });
  const result = await h.api.generatePatch(h.payload);
  await assert.rejects(h.api.applyPatch({ folder, patchId: result.patchId, confirmed: true }), /文件已变化，请重新生成补丁/);
});
test('60 KB 以上按当前锚点窗口提供带行号内容', async () => {
  const { folder } = repo(), h = harness(folder);
  fs.writeFileSync(path.join(folder, 'a.js'), Array.from({ length: 1000 }, (_, i) => i === 500 ? 'old' : `${i} ${'x'.repeat(100)}`).join('\n'));
  await h.api.generatePatch(h.payload);
  const user = h.calls[0].messages[1].content;
  assert.ok(user.includes('501: old')); assert.ok(user.includes('301: 300 '));
  assert.ok(!user.includes('300: 299 ')); assert.ok(!user.includes('999 '));
});
test('复核刷新最新比较而非使用旧 snapshot diff', async () => {
  const { folder, git } = repo(), h = harness(folder, () => '[id=one] => 仍存在 | 当前证据');
  fs.writeFileSync(path.join(folder, 'a.js'), 'first-change\n');
  await require('../../main/git').getChanges(folder, { mode: 'unstaged' });
  fs.writeFileSync(path.join(folder, 'a.js'), 'latest-change\n');
  await h.api.verifyFinding(h.payload);
  assert.ok(h.calls[0].messages[1].content.includes('+latest-change'));
  assert.ok(!h.calls[0].messages[1].content.includes('+first-change'));
  assert.equal(git('diff', '--cached'), '');
});

test('staged 评审后复核使用当前工作区补丁及内容，未跟踪内容也作为证据', async () => {
  const { folder, git } = repo(), h = harness(folder, () => '[id=one] => 仍存在 | 证据');
  fs.writeFileSync(path.join(folder, 'a.js'), 'staged-version\n'); git('add', 'a.js');
  await require('../../main/git').getChanges(folder, { mode: 'staged' });
  fs.writeFileSync(path.join(folder, 'a.js'), 'patched-working-tree\n');
  await h.api.verifyFinding(h.payload);
  assert.match(h.calls[0].messages[1].content, /当前工作区 diff.*\n[\s\S]*\+patched-working-tree/);
  assert.match(h.calls[0].messages[1].content, /当前工作区文件内容.*\npatched-working-tree/);
  git('rm', '--cached', '-f', 'a.js');
  await h.api.verifyFinding(h.payload);
  assert.match(h.calls[1].messages[1].content, /未跟踪文件 a.js：\npatched-working-tree/);
});

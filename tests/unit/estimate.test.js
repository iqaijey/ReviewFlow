const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), Module = require('module');
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-estimate-'));
const load = Module._load;
Module._load = function (id, ...args) { return id === 'electron' ? { app: { getPath: () => folder } } : load.call(this, id, ...args); };
after(() => { Module._load = load; fs.rmSync(folder, { recursive: true, force: true }); });
const settings = require('../../main/settings');
const { estimateTokens, priceCalls, estimateRun } = require('../../main/estimate');
const { splitIntoBatches } = require('../../main/ai/prompts');
const files = (count, size = 26000) => Array.from({ length: count }, (_, i) => ({ path: `f${i}.js`, status: 'modified', hunks: [{ header: '@@ -1 +1 @@', lines: [{ type: 'add', content: 'x'.repeat(size) }] }] }));
test('CJK 与其他字符 token 启发式为纯函数', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('中文日本語한글'), 7);
  assert.equal(estimateTokens('中文abcd'), 3);
});
test('批数与真实 split 一致，full 无综合，overview 含综合及多模型流水线', async () => {
  await settings.saveSettings({ backend: 'api', model: 'fixture', pricing: {} });
  for (const count of [1, 2, 8]) {
    const input = files(count), n = splitIntoBatches(folder, input).batches.length;
    const full = await estimateRun({ folder, kind: 'full', files: input });
    const overview = await estimateRun({ folder, kind: 'overview', files: input });
    assert.equal(full.calls, n); assert.equal(full.maxOutputTokens, n * 8192);
    assert.equal(overview.calls, n + (count === 8 ? 3 : n > 1 ? 1 : 0));
    const multi = await estimateRun({ folder, kind: 'overview', files: input, multiModels: { models: [{ backend: 'api', model: 'a' }, { backend: 'api', model: 'b' }], synthesizer: { backend: 'api', model: 's' } } });
    assert.equal(multi.calls, overview.calls * 2 + 1);
    assert.deepEqual(multi.perBackend.map((b) => b.model), ['a', 'b', 's']);
    assert.equal(multi.perBackend.reduce((n, b) => n + b.inputTokens, 0), multi.inputTokens);
  }
});
test('跳过资源与排除文件，单文件 2048 输出预算，snapshot 绑定项目', async () => {
  const input = [...files(1, 100), { ...files(1)[0], path: 'image.png' }, { ...files(1)[0], path: 'package-lock.json' }];
  const result = await estimateRun({ folder, kind: 'full', files: input });
  assert.equal(result.calls, 1); assert.match(result.notes.join(' '), /跳过 2/);
  const file = await estimateRun({ folder, kind: 'file', filePath: 'f0.js', files: input, planEnabled: false });
  assert.equal(file.calls, 1); assert.equal(file.maxOutputTokens, 2048);
  assert.equal((await estimateRun({ folder, kind: 'file', filePath: 'image.png', files: input })).calls, 0);
  const snapshot = require('../../main/reviewSnapshot').captureSnapshot(folder, files(2), null);
  assert.equal((await estimateRun({ folder, kind: 'full', snapshotId: snapshot.snapshotId })).calls, 2);
  await assert.rejects(estimateRun({ folder: os.tmpdir(), kind: 'full', snapshotId: snapshot.snapshotId }), /快照/);
});
test('复用逐文件提示词准确统计输入，规则和噪声覆盖生效', async () => {
  const input = files(1, 100);
  fs.writeFileSync(path.join(folder, '.reviewflow.md'), '不得改变公共 API');
  const payload = { folder, kind: 'file', filePath: 'f0.js', files: input, noiseLevelOverride: 'quiet', planEnabled: false };
  const result = await estimateRun(payload);
  const prepared = await require('../../main/ai').prepareFileAnalysis({ ...payload, file: input[0] });
  const text = `${prepared.system}\n\n${prepared.user}`;
  assert.equal(result.inputChars, text.length); assert.equal(result.inputTokens, estimateTokens(text));
  await assert.rejects(estimateRun({ ...payload, noiseLevelOverride: 'bad' }), /噪声/);
});
test('价格优先模型再后端，min 仅输入，max 包含输出，币种不混加', async () => {
  const calls = [{ backend: 'api', model: 'a', inputTokens: 1000000, maxOutputTokens: 2000000 }];
  assert.deepEqual(priceCalls(calls, { 'api:a': { inputPerMTokens: 2, outputPerMTokens: 3, currency: 'USD' }, api: { inputPerMTokens: 99, outputPerMTokens: 99, currency: 'USD' } }, []), { currency: 'USD', min: 2, max: 8 });
  const notes = [];
  assert.equal(priceCalls([...calls, { ...calls[0], backend: 'codex' }], { api: { inputPerMTokens: 1, outputPerMTokens: 1, currency: 'USD' }, codex: { inputPerMTokens: 1, outputPerMTokens: 1, currency: 'CNY' } }, notes), null);
  assert.match(notes.join(' '), /币种/);
  await settings.saveSettings({ pricing: { api: { inputPerMTokens: 2, outputPerMTokens: 3, currency: 'CNY' } } });
  const result = await estimateRun({ folder, kind: 'full', files: files(1, 100) });
  assert.equal(result.cost.min, result.inputTokens * 2 / 1000000);
  assert.equal(result.cost.max, result.cost.min + result.maxOutputTokens * 3 / 1000000);
});
test('CLI 无定价仍估算 token 并显示订阅说明，绝不执行后端', async () => {
  await settings.saveSettings({ backend: 'codex', codexModel: 'fixture-cli', pricing: {} });
  const result = await estimateRun({ folder, kind: 'overview', files: files(1, 100) });
  assert.equal(result.cost, null); assert.ok(result.inputTokens > 0);
  assert.ok(result.notes.includes('订阅制 CLI 按其套餐计费，金额仅供参考'));
});

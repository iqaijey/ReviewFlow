const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewflow-settings-'));
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { getPath: () => tmpDir } };
  return originalLoad.call(this, request, ...rest);
};
after(() => {
  Module._load = originalLoad;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const { mergeImportedPresets, getSettings, saveSettings } = require('../../main/settings');

test('导入：合法文件规范化合并到现有预设', () => {
  const existing = [{ id: 'p1', name: '安全审查', dimensions: ['安全'], customPrompt: '', backend: 'api', model: '', effort: '' }];
  const data = {
    app: 'reviewflow', kind: 'presets', version: 1,
    presets: [
      { id: 'p9', name: '性能审查', dimensions: ['性能', ' 日志 '], customPrompt: '关注内存', backend: 'opencode', model: 'm1', effort: 'high' },
    ],
  };
  const { imported, presets } = mergeImportedPresets(data, existing);
  assert.strictEqual(imported.length, 1);
  assert.strictEqual(presets.length, 2);
  assert.strictEqual(imported[0].name, '性能审查');
  assert.deepStrictEqual(imported[0].dimensions, ['性能', '日志']);
  assert.strictEqual(imported[0].backend, 'opencode');
});

test('导入：重名加（导入）后缀，id 冲突重新生成', () => {
  const existing = [{ id: 'p1', name: '安全审查', dimensions: [], customPrompt: '', backend: 'api', model: '', effort: '' }];
  const data = { presets: [{ id: 'p1', name: '安全审查', dimensions: [], backend: 'api' }] };
  const { imported } = mergeImportedPresets(data, existing);
  assert.strictEqual(imported[0].name, '安全审查（导入）');
  assert.notStrictEqual(imported[0].id, 'p1');
});

test('导入：非法 backend 回退 api，空名条目跳过', () => {
  const data = {
    presets: [
      { name: 'X', backend: 'evil' },
      { name: '   ' },
      'not-an-object',
      {},
    ],
  };
  const { imported } = mergeImportedPresets(data, []);
  assert.strictEqual(imported.length, 1);
  assert.strictEqual(imported[0].backend, 'api');
});

test('导入：非预设文件与空文件抛错', () => {
  assert.throws(() => mergeImportedPresets({ hello: 1 }, []), /不是 ReviewFlow 预设文件/);
  assert.throws(() => mergeImportedPresets(null, []), /不是 ReviewFlow 预设文件/);
  assert.throws(() => mergeImportedPresets({ presets: [] }, []), /没有有效的预设/);
});

test('设置缺失或损坏时回退，保存后仍保留损坏副本和部分更新语义', async () => {
  const file = path.join(tmpDir, 'settings.json');
  const defaults = await getSettings();
  assert.strictEqual(defaults.model, 'gpt-4o-mini');
  fs.writeFileSync(file, '{broken settings');
  assert.deepStrictEqual(await getSettings(), defaults);
  assert.strictEqual(fs.existsSync(file), false);
  await saveSettings({ model: 'test-model', customPrompt: '保留提示词' });
  await saveSettings({ timeoutMin: 5 });
  const settings = await getSettings();
  assert.strictEqual(settings.model, 'test-model');
  assert.strictEqual(settings.customPrompt, '保留提示词');
  assert.strictEqual(settings.timeoutMin, 5);
  const backups = fs.readdirSync(tmpDir).filter((name) => name.startsWith('settings.json.corrupt-'));
  assert.strictEqual(backups.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(tmpDir, backups[0]), 'utf8'), '{broken settings');
  assert.strictEqual(fs.readdirSync(tmpDir).some((name) => name.endsWith('.tmp')), false);
});

test('设置损坏但无法隔离时拒绝保存，不覆盖原文件', async (t) => {
  const file = path.join(tmpDir, 'settings.json');
  fs.rmSync(file);
  await getSettings();
  fs.writeFileSync(file, '{unmovable settings');
  const failure = new Error('模拟重命名失败');
  t.mock.method(fs, 'renameSync', () => { throw failure; });
  await assert.rejects(saveSettings({ model: 'must-not-save' }), (error) => error === failure);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{unmovable settings');
});

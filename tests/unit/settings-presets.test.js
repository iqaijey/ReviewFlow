const { test } = require('node:test');
const assert = require('node:assert');

const { mergeImportedPresets } = require('../../main/settings');

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

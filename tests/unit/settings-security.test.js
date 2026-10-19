const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewflow-key-'));
const load = Module._load;
Module._load = function (request, ...args) {
  return request === 'electron' ? { app: { getPath: () => dir } } : load.call(this, request, ...args);
};
const settings = require('../../main/settings');
after(() => { Module._load = load; fs.rmSync(dir, { recursive: true, force: true }); });

test('价格配置校验有限非负单价、币种、key 和 50 项上限，部分保存保留价格', async () => {
  const price = { inputPerMTokens: 0, outputPerMTokens: 2.5, currency: 'USD' };
  for (const value of [-1, Infinity, NaN, '1']) assert.throws(() => settings.validatePricing({ api: { ...price, inputPerMTokens: value } }), /价格配置/);
  for (const invalid of [null, [], { bad: price }, { api: { ...price, currency: 'EUR' } }, Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`api:m${i}`, price]))]) assert.throws(() => settings.validatePricing(invalid), /价格配置/);
  await assert.rejects(settings.saveSettings({ pricing: { api: { ...price, outputPerMTokens: -1 } } }), /价格配置/);
  await settings.saveSettings({ pricing: { 'api:model': price } });
  await settings.saveSettings({ model: 'pricing-check' });
  assert.deepEqual((await settings.getSettings()).pricing, { 'api:model': price });
  assert.deepEqual((await settings.getPublicSettings()).pricing, { 'api:model': price });
});

test('设置 IPC 遮蔽密钥、空值保留、替换和显式清除，权限保持 0600', async () => {
  await settings.saveSettings({ baseUrl: 'http://local/v1', apiKey: 'secret-abcd' });
  const publicSettings = await settings.getPublicSettings();
  assert.equal(publicSettings.apiKey, '');
  assert.equal(publicSettings.apiKeySet, true);
  assert.equal(publicSettings.apiKeyHint, '••••abcd');
  assert.ok(!JSON.stringify(publicSettings).includes('secret-'));
  await settings.saveSettings({ apiKey: '' });
  await settings.saveSettings({ model: 'other' });
  assert.equal((await settings.getSettings()).apiKey, 'secret-abcd');
  const file = path.join(dir, 'settings.json');
  fs.chmodSync(file, 0o644);
  await settings.getSettings();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal((await settings.resolveConnectionSettings({ backend: 'api', baseUrl: 'http://local/v1' })).apiKey, 'secret-abcd');
  await assert.rejects(settings.resolveConnectionSettings({ backend: 'api', baseUrl: 'http://other/v1' }), /更换了接口地址，请重新填写 API Key/);
  assert.equal((await settings.resolveConnectionSettings({ baseUrl: 'http://other', apiKey: 'new' })).apiKey, 'new');
  await settings.saveSettings({ apiKey: 'replacement' });
  assert.equal((await settings.getSettings()).apiKey, 'replacement');
  await settings.saveSettings({ clearApiKey: true, apiKey: 'ignored' });
  assert.equal((await settings.getSettings()).apiKey, '');
  assert.equal((await settings.getPublicSettings()).apiKeyHint, '');
  assert.equal((await settings.getPublicSettings()).apiKeySet, false);
});

test('预设导入、保存及导出字段白名单不含密钥', async () => {
  const raw = { id: 'p1', name: 'test', apiKey: 'leak', nested: { apiKey: 'leak' }, baseUrl: 'private' };
  const { presets } = settings.mergeImportedPresets({ presets: [raw] }, [raw]);
  assert.ok(!JSON.stringify(presets).includes('leak'));
  await settings.saveSettings({ presets: [raw] });
  const exported = settings.sanitizePresets((await settings.getSettings()).presets);
  assert.ok(!JSON.stringify(exported).includes('leak'));
  assert.equal('apiKey' in exported[0], false);
});

test('保存新接口且未提供新密钥时清除旧密钥，连接解析不复用', async () => {
  for (const patch of [{ apiKey: '' }, {}]) {
    await settings.saveSettings({ baseUrl: 'https://old.test/v1', apiKey: 'old-secret' });
    await settings.saveSettings({ baseUrl: 'https://new.test/v1', ...patch });
    assert.equal((await settings.getSettings()).apiKey, '');
    assert.equal((await settings.resolveConnectionSettings({ backend: 'api', baseUrl: 'https://new.test/v1' })).apiKey, '');
  }
});

test('损坏字段逐项回退且告警不含值，新输入仍拒绝', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ pricing: 'sensitive-invalid', excludePatterns: {}, presets: {}, apiKey: 42, noiseLevel: 'bad', model: 'kept' }));
  delete require.cache[require.resolve('../../main/settings')];
  const fresh = require('../../main/settings');
  const value = await fresh.getSettings();
  assert.deepEqual(value.pricing, {});
  assert.ok(Array.isArray(value.excludePatterns));
  assert.deepEqual(value.presets, []);
  assert.equal(value.apiKey, '');
  assert.equal(value.noiseLevel, 'balanced');
  assert.equal(value.model, 'kept');
  assert.equal(warn.mock.calls.length, 5);
  assert.ok(warn.mock.calls.every((call) => !call.arguments.join('').includes('sensitive-invalid')));
  await assert.rejects(fresh.saveSettings({ excludePatterns: {} }), /排除规则/);
});

test('隔离 profile 不读取或迁移真实旧设置', async (t) => {
  const previous = process.env.REVIEWFLOW_USER_DATA_DIR;
  process.env.REVIEWFLOW_USER_DATA_DIR = dir;
  t.after(() => { if (previous === undefined) delete process.env.REVIEWFLOW_USER_DATA_DIR; else process.env.REVIEWFLOW_USER_DATA_DIR = previous; });
  fs.rmSync(path.join(dir, 'settings.json'), { force: true });
  const exists = t.mock.method(fs, 'existsSync', () => { throw new Error('不得探测旧设置'); });
  delete require.cache[require.resolve('../../main/settings')];
  assert.equal((await require('../../main/settings').getSettings()).apiKey, '');
  assert.equal(exists.mock.calls.length, 0);
});

test('listModels 与 testConnection 在接口变更时不会发送存储密钥', async (t) => {
  await settings.saveSettings({ baseUrl: 'http://saved/v1', apiKey: 'stored-secret' });
  const ai = require('../../main/ai');
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push([url, options.headers.Authorization]);
    return new Response(JSON.stringify({ data: [{ id: 'model' }], choices: [{ message: { content: 'pong' } }] }), { headers: { 'content-type': 'application/json' } });
  });
  await assert.rejects(ai.listModels({ backend: 'api', baseUrl: 'http://changed/v1' }), /更换了接口地址/);
  assert.match((await ai.testConnection({ backend: 'api', baseUrl: 'http://changed/v1' })).message, /更换了接口地址/);
  assert.equal(calls.length, 0);
  assert.deepEqual(await ai.listModels({ backend: 'api', baseUrl: 'http://saved/v1' }), ['model']);
  assert.equal((await ai.testConnection({ backend: 'api', baseUrl: 'http://saved/v1', model: 'model' })).ok, true);
  assert.ok(calls.every((call) => call[1] === 'Bearer stored-secret'));
});

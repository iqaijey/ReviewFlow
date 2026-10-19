const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-file-cache-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const { createFileAnalysisCache, buildIdentity } = require('../../main/fileAnalysisCache');
const cache = createFileAnalysisCache({ root: () => root });
const input = { path: 'a.js', diffFingerprint: 'diff', system: 'system', user: 'user', execution: { backend: 'api', endpoint: 'https://example.test/v1', requestedModel: 'm', resolvedModel: 'm', effort: '', cliConfigFingerprint: null, maxTokens: 2048, temperature: 0.2, promptVersion: 'file-v2' } };
const identity = buildIdentity(input);

test('effective prompt and execution matrix invalidate cache keys', () => {
  for (const field of ['system', 'user', 'diffFingerprint']) assert.notEqual(buildIdentity({ ...input, [field]: `${input[field]}-new` }).key, identity.key);
  for (const field of ['backend', 'endpoint', 'requestedModel', 'resolvedModel', 'effort', 'cliConfigFingerprint', 'maxTokens', 'temperature', 'promptVersion']) {
    assert.notEqual(buildIdentity({ ...input, execution: { ...input.execution, [field]: 'changed' } }).key, identity.key);
  }
  assert.equal(buildIdentity({ ...input, execution: Object.fromEntries(Object.entries(input.execution).reverse()) }).key, identity.key);
});

test('hit returns original stats, force overwrites and failures never cache', async () => {
  let calls = 0;
  const call = async () => ({ markdown: `answer${++calls}`, stats: { durationMs: 123 } });
  assert.equal((await cache.run('/hit', identity, call)).cacheHit, false);
  const hit = await cache.run('/hit', identity, call);
  assert.equal(hit.cacheHit, true);
  assert.deepEqual(hit.stats, { durationMs: 123 });
  assert.equal(calls, 1);
  assert.equal((await cache.run('/hit', identity, call, true)).markdown, 'answer2');
  await assert.rejects(cache.run('/failure', identity, async () => { throw new Error('failed'); }));
  assert.equal(cache.lookup('/failure', identity.key), null);
});

test('in-flight identical keys call AI once and folders stay isolated', async () => {
  let finish, calls = 0;
  const deferred = new Promise((resolve) => { finish = resolve; });
  const call = () => { calls++; return deferred; };
  const a = cache.run('/concurrent', identity, call);
  const b = cache.run('/concurrent', identity, call);
  finish({ markdown: 'done', stats: null });
  assert.deepEqual(await a, await b);
  assert.equal(calls, 1);
  assert.equal(cache.lookup('/elsewhere', identity.key), null);
});

test('LRU entry and serialized byte limits evict oldest', async () => {
  const small = createFileAnalysisCache({ root: () => root, maxEntries: 2, maxBytes: 1800 });
  const ids = ['a', 'b', 'c'].map((user) => buildIdentity({ ...input, user }));
  for (const id of ids.slice(0, 2)) await small.run('/lru', id, async () => ({ markdown: 'ok', stats: null }));
  small.lookup('/lru', ids[0].key);
  await small.run('/lru', ids[2], async () => ({ markdown: 'ok', stats: null }));
  assert.equal(small.lookup('/lru', ids[1].key), null);
  assert.ok(small.lookup('/lru', ids[0].key));
  await small.run('/bytes', ids[0], async () => ({ markdown: '中'.repeat(2000), stats: null }));
  assert.equal(small.lookup('/bytes', ids[0].key), null);
});

test('corrupt JSON quarantined before cache reuse', () => {
  const { hash } = require('../../main/reviewSnapshot');
  const dir = path.join(root, 'review-file-cache');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${hash('/corrupt')}.json`;
  fs.writeFileSync(path.join(dir, name), '{bad');
  assert.equal(cache.lookup('/corrupt', identity.key), null);
  assert.equal(fs.readdirSync(dir).some((file) => file.startsWith(`${name}.corrupt-`)), true);
});

test('real prompt builder invalidates diff/context/model/endpoint/effort/rules/plan/noise and rehydrates snapshot', async () => {
  const filename = require.resolve('../../main/ai');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const project = fs.mkdtempSync(path.join(root, 'project-'));
  const file = { path: 'a.js', status: 'modified', hunks: [{ header: '@@ -1 +1 @@', newStart: 1, newLines: 1,
    lines: [{ type: 'add', content: 'new', newLine: 1 }] }] };
  const cfg = { backend: 'api', model: 'm', baseUrl: 'https://example.test/v1', apiKey: 'secret' };
  let calls = 0;
  const replacements = {
    './settings': { getSettings: async () => ({ ...cfg }) },
    './fileAnalysisCache': { ...cache, buildIdentity },
    electron: { app: { getVersion: () => 'test' } },
    './ai/backends': { chatViaApi: async () => { calls++; return { content: 'ok', usage: {}, appliedEffort: '' }; } },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: (id) => replacements[id] || localRequire(id), module, Date, AbortSignal, fetch, structuredClone }, { filename });
  const ai = module.exports;
  const base = { folder: project, file, planContext: 'plan', noiseLevelOverride: 'quiet' };
  const first = await ai.analyzeFile(base);
  assert.deepEqual(Array.from(first.coverageNotices), []);
  assert.equal((await ai.analyzeFile(base)).cacheHit, true);
  assert.equal(calls, 1);
  const variants = [
    { ...base, file: { ...file, hunks: [{ ...file.hunks[0], lines: [{ type: 'add', content: 'other', newLine: 1 }] }] } },
    { ...base, planContext: 'new-plan' }, { ...base, noiseLevelOverride: 'detailed' }, { ...base, customPromptOverride: 'custom' },
  ];
  for (const payload of variants) assert.notEqual((await ai.analyzeFile(payload)).cacheKey, first.cacheKey);
  for (const [field, value] of [['model', 'new-model'], ['baseUrl', 'https://new.test/v1'], ['reasoningEffort', 'high']]) {
    const before = cfg[field]; cfg[field] = value;
    assert.notEqual((await ai.analyzeFile(base)).cacheKey, first.cacheKey);
    cfg[field] = before;
  }
  fs.writeFileSync(path.join(project, '.reviewflow.md'), 'rules');
  const withRules = await ai.analyzeFile(base);
  assert.notEqual(withRules.cacheKey, first.cacheKey);
  fs.writeFileSync(path.join(project, 'a.js'), 'surrounding context');
  assert.notEqual((await ai.analyzeFile(base)).cacheKey, withRules.cacheKey);
  const { captureSnapshot } = require('../../main/reviewSnapshot');
  const snapshot = captureSnapshot(project, [file], null);
  await ai.analyzeFile({ folder: project, file, snapshotId: snapshot.snapshotId });
  const before = calls;
  const restored = await ai.listFileAnalyses({ folder: project, snapshotId: snapshot.snapshotId });
  assert.equal(restored.length, 1);
  assert.equal(restored[0].path, 'a.js');
  assert.equal(restored[0].cacheHit, true);
  assert.deepEqual(Array.from(restored[0].coverageNotices), []);
  assert.equal(calls, before);
  cfg.apiKey = 'changed-secret';
  assert.equal((await ai.analyzeFile({ folder: project, file })).cacheHit, true);
  cfg.baseUrl = 'https://example.test/v1?key=unfingerprintable';
  const notReusable = await ai.analyzeFile({ folder: project, file });
  assert.equal(notReusable.reusable, false);
  const beforeNonReusable = calls;
  assert.equal((await ai.analyzeFile({ folder: project, file })).cacheHit, false);
  assert.equal(calls, beforeNonReusable + 1);
  const nonReusableList = await ai.listFileAnalyses({ folder: project, snapshotId: snapshot.snapshotId });
  assert.equal(nonReusableList[0].reusable, false);

  cfg.baseUrl = 'https://example.test/v1';
  const longFile = { ...file, hunks: [{ ...file.hunks[0], lines: [{ type: 'add', content: 'x'.repeat(13000), newLine: 1 }] }] };
  const notice = '该文件内容超出单次分析上限（12000 字），已截断，结果可能不完整';
  const longResult = await ai.analyzeFile({ folder: project, file: longFile });
  assert.deepEqual(Array.from(longResult.coverageNotices), [notice]);
  const persisted = JSON.parse(fs.readFileSync(path.join(root, 'review-file-cache', `${require('../../main/reviewSnapshot').hash(project)}.json`), 'utf8'));
  assert.deepEqual(persisted.entries.find((entry) => entry.key === longResult.cacheKey).coverageNotices, [notice]);
  assert.deepEqual(Array.from((await ai.analyzeFile({ folder: project, file: longFile })).coverageNotices), [notice]);
  const longSnapshot = captureSnapshot(project, [longFile], null);
  const listed = await ai.listFileAnalyses({ folder: project, snapshotId: longSnapshot.snapshotId });
  assert.deepEqual(Array.from(listed[0].coverageNotices), [notice]);
});

test('旧缓存无 coverageNotices 时按空数组读取', async () => {
  const folder = '/legacy-coverage';
  await cache.run(folder, identity, async () => ({ markdown: '旧结果', stats: null }));
  const filename = path.join(root, 'review-file-cache', `${require('../../main/reviewSnapshot').hash(folder)}.json`);
  const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
  delete data.entries[0].coverageNotices;
  fs.writeFileSync(filename, JSON.stringify(data));
  assert.deepEqual(cache.lookup(folder, identity.key).coverageNotices, []);
  assert.deepEqual(cache.list(folder, [identity])[0].coverageNotices, []);
});

test('credential-bearing endpoints and unresolved CLI defaults bypass reuse', () => {
  const { fileAnalysisExecution, endpointIdentity } = require('../../main/cliConfig');
  assert.equal(endpointIdentity('https://user:password@example.test/v1'), null);
  assert.equal(endpointIdentity('https://example.test/v1?api_key=secret'), null);
  assert.equal(fileAnalysisExecution({ backend: 'opencode' }), null);
  assert.equal(fileAnalysisExecution({ backend: 'kimi' }), null);
  assert.equal(fileAnalysisExecution({ backend: 'api', baseUrl: 'https://example.test/v1?key=secret' }), null);
});

test('empty and cancelled results never enter cache', async () => {
  await assert.rejects(cache.run('/empty', identity, async () => ({ markdown: '', stats: null })), /空结果/);
  assert.equal(cache.lookup('/empty', identity.key), null);
  await assert.rejects(cache.run('/cancel', identity, async () => { throw Object.assign(new Error('cancel'), { cancelled: true }); }));
  assert.equal(cache.lookup('/cancel', identity.key), null);
});

test('不可安全复用结果仍持久化，仅相同路径和 diff 可重现但不命中缓存', async () => {
  const id = buildIdentity({ ...input, reusable: false });
  let calls = 0;
  const call = async () => ({ markdown: `result-${++calls}`, stats: null });
  await cache.run('/not-reusable', id, call);
  assert.equal((await cache.run('/not-reusable', id, call)).cacheHit, false);
  assert.equal(calls, 2);
  assert.equal(cache.lookup('/not-reusable', id.key), null);
  const restored = cache.list('/not-reusable', [id]);
  assert.equal(restored[0].markdown, 'result-2');
  assert.equal(restored[0].reusable, false);
  assert.equal(cache.list('/not-reusable', [{ ...id, diffFingerprint: 'changed' }]).length, 0);
  assert.equal(cache.list('/not-reusable', [{ ...id, path: 'other.js' }]).length, 0);
});

test('缓存读取、写入及命中 LRU 更新失败不丢失成功结果', async () => {
  const filename = require.resolve('../../main/fileAnalysisCache'), local = createRequire(filename), module = { exports: {} };
  let failRead = false, failWrite = false;
  const atomic = local('./atomicFile');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: (id) => id === './atomicFile' ? {
    readJsonFile: (...args) => { if (failRead) throw new Error('read-failure'); return atomic.readJsonFile(...args); },
    writeFileAtomic: (...args) => { if (failWrite) throw new Error('write-failure'); return atomic.writeFileAtomic(...args); },
  } : local(id), module, Date, Buffer }, { filename });
  const isolated = module.exports.createFileAnalysisCache({ root: () => root });
  const call = async () => ({ markdown: 'successful-response', stats: { durationMs: 42 }, coverageNotices: ['截断提示'] });
  failRead = true;
  const readFailed = await isolated.run('/io-fail', identity, call);
  assert.equal(readFailed.markdown, 'successful-response');
  assert.deepEqual(Array.from(readFailed.coverageNotices), ['截断提示']);
  assert.match(readFailed.persistenceWarnings[0], /逐文件结果缓存失败.*read-failure/);
  failRead = false; failWrite = true;
  const writeFailed = await isolated.run('/io-fail', identity, call);
  assert.equal(writeFailed.stats.durationMs, 42);
  assert.match(writeFailed.persistenceWarnings[0], /write-failure/);
  failWrite = false;
  await isolated.run('/io-fail', identity, call);
  failWrite = true;
  const hit = await isolated.run('/io-fail', identity, () => { throw new Error('不能调用模型'); });
  assert.equal(hit.cacheHit, true);
  assert.match(hit.persistenceWarnings[0], /write-failure/);
});

test('多文件 rehydrate 仅发现规则/捕获设置一次，缓存读取一次且写入至多一次', async () => {
  const filename = require.resolve('../../main/ai'), local = createRequire(filename), module = { exports: {} };
  const project = fs.mkdtempSync(path.join(root, 'batch-list-'));
  const files = ['a.js', 'b.js', 'c.js'].map((name) => ({ path: name, status: 'modified', hunks: [] }));
  const rules = local('./effectiveRules');
  let discovery = 0, settings = 0, reads = 0, writes = 0;
  const cacheFile = require.resolve('../../main/fileAnalysisCache'), cacheLocal = createRequire(cacheFile), cacheModule = { exports: {} };
  const atomic = cacheLocal('./atomicFile');
  vm.runInNewContext(fs.readFileSync(cacheFile, 'utf8'), { require: (id) => id === './atomicFile' ? {
    readJsonFile: (...args) => { reads++; return atomic.readJsonFile(...args); },
    writeFileAtomic: (...args) => { writes++; return atomic.writeFileAtomic(...args); },
  } : cacheLocal(id), module: cacheModule, Date, Buffer }, { filename: cacheFile });
  const isolated = cacheModule.exports.createFileAnalysisCache({ root: () => root });
  const cfg = { backend: 'api', model: 'm', baseUrl: 'https://example.test', apiKey: 'test' };
  const replacements = { './settings': { getSettings: async () => { settings++; return cfg; } },
    './fileAnalysisCache': { ...isolated, buildIdentity },
    './effectiveRules': { ...rules, discoverRules: (folder) => { discovery++; return rules.discoverRules(folder); } },
    './ai/backends': { chatViaApi: async () => ({ content: 'ok', usage: {}, appliedEffort: '' }) },
    electron: { app: { getVersion: () => 'test' } } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: (id) => replacements[id] || local(id), module, Date, AbortSignal, fetch, structuredClone }, { filename });
  for (const file of files) await module.exports.analyzeFile({ folder: project, file });
  const snapshot = local('./reviewSnapshot').captureSnapshot(project, files, null);
  discovery = settings = reads = writes = 0;
  const restored = await module.exports.listFileAnalyses({ folder: project, snapshotId: snapshot.snapshotId });
  assert.equal(restored.length, 3);
  assert.equal(discovery, 1); assert.equal(settings, 1); assert.equal(reads, 1); assert.equal(writes, 1);
});

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const state = require('../../main/ai/state');
const control = require('../../main/ai/runControl');
const { groupSynthesisResults } = require('../../main/ai/prompts');

afterEach(() => state.lanes.clear());

function loadAi(reply) {
  const filename = require.resolve('../../main/ai');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const calls = [];
  const cfg = { backend: 'api', apiKey: 'test', baseUrl: 'https://example.invalid', model: 'test' };
  const replacements = {
    './ai/cli': { ...localRequire('./ai/cli'), chatViaCli: async (backend, settings, messages, folder, runId) => {
      const options = { ...state.lanes.get(runId).currentRun, runId };
      calls.push({ settings, messages, options });
      return reply(calls.length, messages, options, settings);
    } },
    './settings': { getSettings: async () => cfg },
    './store': { listChecklist: () => [{ schemaVersion: 2, id: 'stored-id', text: '存储问题', status: 'partial', severity: '高', category: '正确性', location: null, updatedAt: 7, createdAt: 1, lastVerifiedAt: null }] },
    './cliConfig': { ...localRequire('./cliConfig'), readKimiConfig: () => ({}), readCodexConfig: () => ({}) },
    './chatStore': { create: () => ({ id: 'line-thread' }) },
    './ai/backends': { chatViaApi: async (settings, messages, options) => {
      const runOptions = { ...options, ...state.lanes.get(options.runId).currentRun };
      calls.push({ settings, messages, options: runOptions });
      const content = await reply(calls.length, messages, runOptions, settings);
      return { content, usage: { prompt_tokens: 2, completion_tokens: 3 }, appliedEffort: '' };
    } },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (id) => replacements[id] || localRequire(id), module,
    Date, AbortSignal, fetch, structuredClone,
  }, { filename });
  return { ai: module.exports, calls, cfg };
}

function files(count = 2) {
  return Array.from({ length: count }, (_, i) => ({
    path: `f${i}.js`, status: 'modified',
    hunks: [{ header: '@@ h @@', lines: [{ type: 'add', content: 'x'.repeat(26000) }] }],
  }));
}

for (const method of ['analyzeOverview', 'explainFull', 'analyzeOverviewMulti']) {
  test(`${method} 排除文件不进入 AI 或 reviewed，provenance 保留 excluded`, async () => {
    const { ai, calls } = loadAi(() => 'result');
    const input = [files(1)[0], { ...files(1)[0], path: 'excluded.js', excluded: true, excludedBy: '*.js' }];
    const result = await ai[method]({ folder: '', files: input, models: [{ backend: 'api', model: 'a' }, { backend: 'api', model: 'b' }] });
    assert.ok(calls.every((call) => !JSON.stringify(call.messages).includes('excluded.js')));
    const ctx = ai.getCompletionContext(result);
    assert.equal(ctx.files.length, 1);
    assert.equal(ctx.provenance.files.find((f) => f.path === 'excluded.js').excluded, true);
  });
}

test('逐文件排除明确拒绝，缓存列表跳过排除项', async () => {
  const { ai, calls } = loadAi(() => 'result');
  const file = { ...files(1)[0], excluded: true, excludedBy: '*.js' };
  await assert.rejects(ai.analyzeFile({ folder: '', file }), /排除.*不参与 AI 评审/);
  const snapshot = require('../../main/reviewSnapshot').captureSnapshot('/excluded', [file], null);
  assert.equal((await ai.listFileAnalyses({ folder: '/excluded', snapshotId: snapshot.snapshotId })).length, 0);
  assert.equal(calls.length, 0);
});

test('方案生成注入根规则且不包含 ignore 配置', async () => {
  const os = require('node:os'), path = require('node:path');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-plan-rules-'));
  try {
    const marker = 'ROOT_RULE_FIXTURE_22';
    fs.writeFileSync(path.join(folder, '.reviewflow.md'), `${marker}\n\x60\x60\x60reviewflow-ignore\nEXCLUDE_FIXTURE\n\x60\x60\x60`);
    for (const backend of ['api', 'opencode']) {
      const { ai, calls, cfg } = loadAi(() => 'plan'); cfg.backend = backend;
      await ai.generatePlan({ prdText: 'prd' }, cfg, { folder });
      assert.equal(calls[0].messages[0].content.includes(marker), true);
      assert.equal(calls[0].messages[0].content.includes('EXCLUDE_FIXTURE'), false);
    }
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('逐文件缓存包含自身分层规则，逐句选择可跨目录且不注入无关规则', async () => {
  const os = require('node:os'), path = require('node:path');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-scoped-rules-'));
  try {
    require('node:child_process').execFileSync('git', ['-C', folder, 'init', '-q'], { env: { ...process.env, GIT_MASTER: '1' } });
    for (const dir of ['a', 'b', 'c']) {
      fs.mkdirSync(path.join(folder, dir)); fs.writeFileSync(path.join(folder, dir, '.reviewflow.md'), `${dir}_RULE_FIXTURE`);
    }
    const { ai, calls } = loadAi(() => 'result');
    const file = { ...files(1)[0], path: 'a/file.js' };
    const first = await ai.prepareFileAnalysis({ folder, file });
    assert.equal(first.system.includes('a_RULE_FIXTURE'), true);
    assert.equal(first.system.includes('b_RULE_FIXTURE'), false);
    fs.writeFileSync(path.join(folder, 'b/.reviewflow.md'), 'unrelated-change');
    assert.equal((await ai.prepareFileAnalysis({ folder, file })).identity.key, first.identity.key);
    fs.writeFileSync(path.join(folder, 'a/.reviewflow.md'), 'a_UPDATED_FIXTURE');
    assert.notEqual((await ai.prepareFileAnalysis({ folder, file })).identity.key, first.identity.key);
    const hunk = file.hunks[0];
    await ai.explainChange({ folder, filePath: file.path, segments: ['a', 'b'].map((dir) => ({ filePath: `${dir}/file.js`, hunk, lines: hunk.lines })) });
    assert.equal(calls[0].messages[0].content.includes('a_UPDATED_FIXTURE'), true);
    assert.equal(calls[0].messages[0].content.includes('unrelated-change'), true);
    assert.equal(calls[0].messages[0].content.includes('c_RULE_FIXTURE'), false);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

for (const method of ['analyzeOverview', 'explainFull']) {
  test(`${method} 每批仅注入自身祖先规则，续跑冻结全部批次规则`, async () => {
    const os = require('node:os'), path = require('node:path');
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-batch-rules-'));
    try {
      require('node:child_process').execFileSync('git', ['-C', folder, 'init', '-q'], { env: { ...process.env, GIT_MASTER: '1' } });
      for (const dir of ['a', 'b']) {
        fs.mkdirSync(path.join(folder, dir)); fs.writeFileSync(path.join(folder, dir, '.reviewflow.md'), `${dir}_RULE_FIXTURE`);
      }
      const { ai, calls } = loadAi((n) => { if (n === 2) throw new Error('pause'); return 'result'; });
      const input = files().map((file, i) => ({ ...file, path: `${i ? 'b' : 'a'}/file.js` }));
      const result = await ai[method]({ folder, files: input, runId: `layered-${method}` });
      assert.equal(result.paused, true);
      assert.equal(calls[0].messages[0].content.includes('a_RULE_FIXTURE'), true);
      assert.equal(calls[0].messages[0].content.includes('b_RULE_FIXTURE'), false);
      assert.equal(calls[1].messages[0].content.includes('a_RULE_FIXTURE'), false);
      assert.equal(calls[1].messages[0].content.includes('b_RULE_FIXTURE'), true);
      fs.writeFileSync(path.join(folder, 'b/.reviewflow.md'), 'MUTATED_RULE_FIXTURE');
      const resumed = await ai.resumeRun(`layered-${method}`);
      assert.equal(calls[2].messages[0].content.includes('b_RULE_FIXTURE'), true);
      assert.equal(calls[2].messages[0].content.includes('MUTATED_RULE_FIXTURE'), false);
      assert.deepEqual(Array.from(ai.getCompletionContext(resumed).provenance.projectRules.files), ['a/.reviewflow.md', 'b/.reviewflow.md']);
      if (method === 'analyzeOverview') {
        assert.equal(calls[3].messages[0].content.includes('a_RULE_FIXTURE'), true);
        assert.equal(calls[3].messages[0].content.includes('b_RULE_FIXTURE'), true);
      }
    } finally { fs.rmSync(folder, { recursive: true, force: true }); }
  });
}

test('合成分组包含分隔符预算，保留顺序且不修改输入', () => {
  const inputs = ['aaa', 'bb', 'cccc', 'd'];
  assert.deepEqual(groupSynthesisResults(inputs, 7), ['aaa\n\nbb', 'cccc\n\nd']);
  assert.deepEqual(inputs, ['aaa', 'bb', 'cccc', 'd']);
  assert.deepEqual(groupSynthesisResults([], 7), []);
  assert.deepEqual(groupSynthesisResults(['', 'abc', ''], 7), ['abc']);
});

test('单份超预算拆开且末尾不丢，所有分组均在预算内', () => {
  const input = 'a'.repeat(24000) + '末尾问题';
  const groups = groupSynthesisResults([input, '下一批问题'], 24000);
  assert.equal(groups[0], 'a'.repeat(24000));
  assert.equal(groups[1], '末尾问题\n\n下一批问题');
  assert.ok(groups.every((g) => g.length <= 24000));
  for (const budget of [0, 1, -1, 2.5, NaN, Infinity]) {
    assert.throws(() => groupSynthesisResults(['abc'], budget), /预算/);
  }
});

for (const method of ['analyzeOverview', 'explainFull']) {
  test(`${method} 批次失败保留完成结果，续跑仅重试未完成批次`, async () => {
    const { ai, calls } = loadAi((n) => {
      if (n === 2) throw new Error('临时故障');
      return `结果${n}`;
    });
    const result = await ai[method]({ folder: '', files: files(), runId: 'r' });
    assert.equal(result.paused, true);
    assert.equal(result.failed.stage, 'batch');
    assert.equal(result.failed.batchIndex, 2);
    assert.equal(result.failed.batchTotal, 2);
    assert.match(result.markdown, /结果1.*\n\n.*临时故障/s);
    assert.equal(state.lanes.get('r').pausedState.nextIndex, 1);
    assert.equal(result.stats.promptTokens, 2);
    const resumed = await ai.resumeRun('r');
    assert.equal(resumed.paused, false);
    assert.equal(calls.length, method === 'analyzeOverview' ? 4 : 3);
    assert.equal(resumed.stats.promptTokens, method === 'analyzeOverview' ? 6 : 4);
    assert.equal(state.lanes.size, 0);
  });

  test(`${method} 取消保持拒绝，不生成检查点`, async () => {
    const { ai } = loadAi(() => {
      control.cancelRun('r');
      throw control.cancelledError();
    });
    await assert.rejects(ai[method]({ folder: '', files: files(), runId: 'r' }), /已被用户终止/);
    assert.equal(state.lanes.size, 0);
  });
}

test('综合失败续跑仅重试综合，最终提示词与累计统计保留', async () => {
  const { ai, calls } = loadAi((n) => {
    if (n === 3) throw new Error('综合故障');
    return `结果${n}`;
  });
  const result = await ai.analyzeOverview({ folder: '', files: files(), runId: 'r',
    pendingIssues: ['旧问题'], previousReview: '旧报告', planContext: '需求', customPromptOverride: '额外要求' });
  assert.equal(result.failed.stage, 'synthesis');
  assert.equal(state.lanes.get('r').pausedState.nextIndex, 2);
  const resumed = await ai.resumeRun('r');
  assert.equal(resumed.markdown, '结果4');
  assert.equal(resumed.stats.promptTokens, 6);
  for (const text of ['## 问题清单', '## 遗留问题核对', '## 与上次对比', '额外要求', '## 需求符合度']) {
    assert.ok(calls[3].messages[0].content.includes(text));
  }
  assert.equal(state.lanes.size, 0);
});

test('分层合成失败保留已完成合并，末尾批次进入合成且统计不重复', async () => {
  const { ai, calls } = loadAi((n, messages) => {
    if (n <= 3) return `批次${n}` + 'x'.repeat(15000) + `尾部${n}`;
    if (n === 5) throw new Error('合并故障');
    return `合并${n}`;
  });
  const result = await ai.analyzeOverview({ folder: '', files: files(3), runId: 'r' });
  assert.equal(result.failed.stage, 'synthesis');
  assert.equal(state.lanes.get('r').pausedState.synthesis.merged.length, 1);
  const resumed = await ai.resumeRun('r');
  assert.equal(calls.length, 8);
  assert.equal(resumed.stats.promptTokens, 14);
  assert.ok(calls.some((c) => c.messages[1].content.includes('尾部3')));
  assert.equal(state.lanes.size, 0);
});

test('单模型分层合成在调用之间暂停，续跑不重复已完成合并', async () => {
  const { ai, calls } = loadAi((n) => {
    if (n <= 3) return `批次${n}` + 'x'.repeat(15000);
    if (n === 4) assert.equal(control.pauseRun('synthesis-pause'), true);
    return `合并${n}`;
  });
  const paused = await ai.analyzeOverview({ folder: '', files: files(3), runId: 'synthesis-pause' });
  assert.equal(paused.paused, true);
  assert.equal(paused.failed, undefined);
  assert.equal(calls.length, 4);
  assert.equal(state.lanes.get('synthesis-pause').pausedState.synthesis.merged.length, 1);
  const resumed = await ai.resumeRun('synthesis-pause');
  assert.equal(resumed.paused, false);
  assert.equal(calls.length, 7);
  assert.equal(resumed.stats.promptTokens, 14);
  assert.equal(calls.filter((c) => c.options.batch === '（分层合并 1/3）').length, 1);
});

for (const fallback of [false, true]) {
  for (const viaChild of [false, true]) {
    test(`多模型${fallback ? '备用' : '主'}合成经${viaChild ? '子' : '父'} ID 暂停后仅补剩余调用`, async () => {
      let pausedOnce = false;
      const { ai, calls } = loadAi((n, messages, options, cfg) => {
        if (options.kind !== '多模型汇总') return `${cfg.backend}报告` + 'x'.repeat(26000);
        if (fallback && cfg.backend === 'api') throw new Error('主汇总失败');
        if (!pausedOnce) {
          pausedOnce = true;
          assert.equal(control.pauseRun(viaChild ? 'multi-syn-pause-m0' : 'multi-syn-pause'), true);
        }
        return `合并${n}`;
      });
      const paused = await ai.analyzeOverviewMulti({ folder: '', files: files(1), runId: 'multi-syn-pause',
        models: [{ backend: 'api', model: 'a' }, { backend: 'opencode', model: 'b' }] });
      assert.equal(paused.paused, true);
      assert.equal(paused.failed, undefined);
      const checkpoint = state.lanes.get('multi-syn-pause').pausedState.multi;
      const progress = (fallback ? checkpoint.fallbackState : checkpoint.synState).synthesis;
      assert.equal(progress.merged.length, 1);
      const groupCount = progress.groups.length;
      const firstBatch = `（分层合并 1/${groupCount}）`;
      const completed = calls.filter((c) => c.options.kind !== '多模型汇总').length;
      const before = calls.length;
      const resumed = await ai.resumeRun(viaChild ? 'multi-syn-pause-m0' : 'multi-syn-pause');
      assert.notEqual(resumed.paused, true);
      assert.equal(calls.filter((c) => c.options.kind !== '多模型汇总').length, completed);
      assert.equal(calls.length, before + groupCount);
      assert.equal(calls.filter((c) => c.options.kind === '多模型汇总' && c.options.batch === firstBatch && (!fallback || c.settings.backend === 'opencode')).length, 1);
      if (fallback) assert.equal(calls.filter((c) => c.options.kind === '多模型汇总' && c.settings.backend === 'api').length, 1);
      assert.equal(state.lanes.size, 0);
    });
  }
}

test('综合续跑取消仍拒绝，最终调用期间的暂停请求不残留', async () => {
  const { ai } = loadAi((n) => {
    if (n === 3) throw new Error('综合故障');
    if (n === 4) {
      control.cancelRun('r');
      throw control.cancelledError();
    }
    return '结果';
  });
  await ai.analyzeOverview({ folder: '', files: files(), runId: 'r' });
  await assert.rejects(ai.resumeRun('r'), /已被用户终止/);
  assert.equal(state.lanes.size, 0);
  let lane;
  const second = loadAi((n) => {
    if (n === 3) {
      lane = state.lanes.get('p');
      assert.equal(control.pauseRun('p'), true);
    }
    return '结果';
  });
  await second.ai.analyzeOverview({ folder: '', files: files(), runId: 'p' });
  assert.equal(lane.pauseRequested, false);
  assert.equal(state.lanes.size, 0);
});

test('多模型失败保留父子检查点，恢复只补齐缺失调用', async () => {
  let failed = false;
  const { ai, calls } = loadAi((n, messages, options, cfg) => {
    if (!failed && cfg.model === 'bad' && options.batchIndex === 2) { failed = true; throw new Error('子模型故障'); }
    return cfg.model === 'good' ? '完整报告' : '部分报告';
  });
  const result = await ai.analyzeOverviewMulti({ folder: '', files: files(), runId: 'multi',
    models: [{ backend: 'api', model: 'bad' }, { backend: 'api', model: 'good' }] });
  assert.equal(result.paused, true);
  assert.equal(result.failed.stage, 'batch');
  assert.match(result.failed.message, /bad.*子模型故障/);
  assert.equal(state.lanes.get('multi').pausedState.kind, 'multi');
  assert.ok(state.lanes.get('multi-m0').pausedState);
  assert.equal(calls.filter((c) => c.options.kind === '多模型汇总').length, 0);
  const history = [];
  require('../../main/reviewLifecycle').completeReview(result, ai.getCompletionContext(result), { saveReview: (entry) => history.push(entry) });
  assert.equal(history.length, 0);
  const before = calls.filter((c) => c.settings.model === 'good').length;
  const resumed = await ai.resumeRun('multi');
  assert.equal(resumed.paused, undefined);
  assert.equal(calls.filter((c) => c.settings.model === 'good').length, before);
  assert.equal(calls.length, 8);
  assert.equal(state.lanes.size, 0);
});

test('恢复子运行再恢复父运行只由协调器补齐 reviewer，不重复调用', async () => {
  let fail = true;
  const { ai, calls } = loadAi((n, messages, options, cfg) => {
    if (fail && cfg.model === 'a' && options.batchIndex === 2) { fail = false; throw new Error('暂停'); }
    return '报告';
  });
  await ai.analyzeOverviewMulti({ folder: '', files: files(), runId: 'child-resume',
    models: [{ backend: 'api', model: 'a' }, { backend: 'api', model: 'b' }] });
  assert.equal(ai.getRuns().find((r) => r.runId === 'child-resume-m0').parentRunId, 'child-resume');
  const result = await ai.resumeRun('child-resume-m0');
  const count = calls.length;
  assert.equal(await ai.resumeRun('child-resume'), result);
  assert.equal(calls.length, count);
  assert.equal(calls.filter((c) => c.options.kind !== '多模型汇总').length, 7);
  assert.equal(state.lanes.size, 0);
});

test('取消暂停子运行会取消整个协调器，恢复父运行不会复活', async () => {
  const { ai, calls } = loadAi((n, messages, options, cfg) => {
    if (cfg.model === 'a') throw new Error('暂停');
    return '报告';
  });
  await ai.analyzeOverviewMulti({ folder: '', files: files(1), runId: 'child-cancel',
    models: [{ backend: 'api', model: 'a' }, { backend: 'api', model: 'b' }] });
  const count = calls.length;
  assert.equal(control.cancelRun('child-cancel-m0'), true);
  assert.equal(await ai.resumeRun('child-cancel'), null);
  assert.equal(calls.length, count);
  assert.equal(state.lanes.size, 0);
});

test('一个活跃子运行取消与另一个失败交错时不留下孤立检查点', async () => {
  let fail;
  const failure = new Promise((resolve, reject) => { fail = reject; });
  const { ai } = loadAi(async (n, messages, options, cfg) => {
    if (cfg.model === 'b') return failure;
    await new Promise((resolve) => setImmediate(resolve));
    control.cancelRun('child-race-m0');
    fail(new Error('另一个模型失败'));
    return '报告';
  });
  await assert.rejects(ai.analyzeOverviewMulti({ folder: '', files: files(1), runId: 'child-race',
    models: [{ backend: 'api', model: 'a' }, { backend: 'api', model: 'b' }] }), /已被用户终止/);
  assert.equal(state.lanes.size, 0);
});

test('暂停子运行同时暂停父协调器及其他 reviewer', async () => {
  const { ai } = loadAi((n) => {
    if (n === 1) assert.equal(control.pauseRun('child-pause-m0'), true);
    return '报告';
  });
  const result = await ai.analyzeOverviewMulti({ folder: '', files: files(), runId: 'child-pause',
    models: [{ backend: 'api', model: 'a' }, { backend: 'api', model: 'b' }] });
  assert.equal(result.paused, true);
  assert.ok(state.lanes.get('child-pause-m0').pausedState);
  assert.ok(state.lanes.get('child-pause-m1').pausedState);
  control.cancelRun('child-pause');
  assert.equal(state.lanes.size, 0);
});

test('多模型汇总超长报告复用分层合成，不裁掉单模型末尾', async () => {
  const { ai, calls } = loadAi((n, messages, options, cfg) => {
    if (options.kind !== '多模型汇总') return `${cfg.model}头` + 'x'.repeat(26000) + `${cfg.model}尾`;
    return '已合并';
  });
  await ai.analyzeOverviewMulti({ folder: '', files: files(1), runId: 'multi',
    models: [{ backend: 'api', model: 'a' }, { backend: 'api', model: 'b' }] });
  for (const marker of ['a尾', 'b尾']) {
    assert.ok(calls.filter((c) => c.options.kind === '多模型汇总').some((c) => c.messages[1].content.includes(marker)));
  }
  assert.equal(state.lanes.size, 0);
});

test('主进程存储优先于 pendingIssues，恢复保留标题、噪声、ID 和捕获版本', async () => {
  const { ai, calls } = loadAi((n) => { if (n === 2) throw new Error('暂停'); return '报告'; });
  await ai.analyzeOverview({ folder: '/no-project', files: files(), runId: 'resume-metadata', title: '最初标题',
    kind: 'review', noiseLevelOverride: 'quiet', pendingIssues: ['renderer-forged'] });
  const checkpoint = state.lanes.get('resume-metadata').pausedState;
  assert.equal(checkpoint.noiseLevel, 'quiet');
  assert.equal(checkpoint.title, '最初标题');
  assert.deepEqual(JSON.parse(JSON.stringify(checkpoint.captured)), [{ id: 'stored-id', updatedAt: 7 }]);
  assert.ok(calls[0].messages[1].content.includes('[id=stored-id]'));
  assert.equal(calls[0].messages[1].content.includes('renderer-forged'), false);
  const result = await ai.resumeRun('resume-metadata');
  assert.equal(ai.getCompletionContext(result).reviewId, checkpoint.reviewId);
  assert.equal(ai.getCompletionContext(result).title, '最初标题');
  assert.equal(ai.getCompletionContext(result).noiseLevel, 'quiet');
});

test('恢复冻结规则、设置、方案和快照，完成后再次恢复只重试持久化', async () => {
  const os = require('node:os'), path = require('node:path');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-frozen-'));
  try {
    fs.writeFileSync(path.join(folder, '.reviewflow.md'), 'first-rules');
    const { ai, calls, cfg } = loadAi((n) => { if (n === 2) throw new Error('checkpoint'); return '报告'; });
    await ai.analyzeOverview({ folder, files: files(), runId: 'frozen', planId: 'plan', planTitle: '标题', planContext: 'actual-plan', presetId: 'preset', presetName: '预设' });
    const frozen = state.lanes.get('frozen').pausedState;
    const rulesHash = frozen.provenance.projectRules.fileHash;
    cfg.model = 'changed'; cfg.apiKey = 'changed-secret';
    fs.writeFileSync(path.join(folder, '.reviewflow.md'), 'changed-rules');
    const result = await ai.resumeRun('frozen');
    const provenance = ai.getCompletionContext(result).provenance;
    assert.equal(provenance.projectRules.fileHash, rulesHash);
    assert.equal(provenance.plan.contextHash, require('../../main/reviewSnapshot').hash('actual-plan'));
    assert.equal(provenance.backends[0].resolvedModel, 'test');
    assert.equal(provenance.preset.id, 'preset');
    assert.equal(JSON.stringify(provenance).includes('changed-secret'), false);
    assert.equal(calls[3].settings.model, 'test');
    assert.equal(calls[3].messages[0].content.includes('changed-rules'), false);
    assert.equal(await ai.resumeRun('frozen'), result);
    assert.equal(calls.length, 4);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('多模型历史保留部分原文与汇总器原文和身份', async () => {
  let failed = false;
  const { ai } = loadAi((n, messages, options, cfg) => {
    if (!failed && cfg.model === 'bad' && options.batchIndex === 2) { failed = true; throw new Error('失败'); }
    return options.kind === '多模型汇总' ? '汇总原文' : '子模型原文';
  });
  const result = await ai.analyzeOverviewMulti({ folder: '', files: files(), runId: 'raw',
    models: [{ slotId: 'bad-slot', backend: 'api', model: 'bad' }, { slotId: 'good-slot', backend: 'api', model: 'good' }] });
  assert.equal(result.paused, true);
  const context = ai.getCompletionContext(await ai.resumeRun('raw'));
  assert.equal(context.historyPerModel[0].outcome, 'complete');
  assert.ok(context.historyPerModel[0].markdown);
  assert.equal(context.historyPerModel[2].role, 'synthesizer');
  assert.equal(context.historyPerModel[2].markdown, '汇总原文');
  assert.deepEqual(Array.from(context.provenance.backends, (b) => b.slotId), ['bad-slot', 'good-slot', 'synthesizer']);
});

test('父运行在一个 reviewer 完成后取消，保活取消状态且不汇总或保存', async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const { ai, calls } = loadAi(async (n, messages, options, cfg) => {
    if (cfg.model === 'b') return pending;
    return '完成';
  });
  const run = ai.analyzeOverviewMulti({ folder: '', files: files(1), runId: 'cancel-parent',
    models: [{ backend: 'api', model: 'a' }, { backend: 'api', model: 'b' }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(control.cancelRun('cancel-parent'), true);
  control.maybeCleanupLane('cancel-parent');
  assert.equal(control.ensureLane('cancel-parent').cancelled, true);
  assert.equal(state.lanes.get('cancel-parent-m1').cancelled, true);
  finish('结束');
  await assert.rejects(run, /已被用户终止/);
  assert.equal(calls.length, 2);
  assert.equal(await ai.resumeRun('cancel-parent'), null);
  assert.equal(state.lanes.size, 0);
});

test('父汇总失败成为检查点，恢复仅重试汇总；取消丢弃父子检查点', async () => {
  let fail = true;
  const { ai, calls } = loadAi((n, messages, options) => {
    if (fail && options.kind === '多模型汇总') throw new Error('汇总故障');
    return '报告';
  });
  const payload = { folder: '', files: files(1), runId: 'syn-parent', models: [{ backend: 'api', model: 'a' }, { backend: 'api', model: 'b' }] };
  const paused = await ai.analyzeOverviewMulti(payload);
  assert.equal(paused.failed.stage, 'synthesis');
  fail = false;
  await ai.resumeRun('syn-parent');
  assert.equal(calls.length, 4);
  fail = true;
  await ai.analyzeOverviewMulti({ ...payload, runId: 'discard' });
  control.cancelRun('discard');
  assert.equal(await ai.resumeRun('discard'), null);
  assert.equal(state.lanes.size, 0);
});

test('AI 批次截断在完成结果与 provenance 中显式记录', async () => {
  const { ai } = loadAi(() => '## 问题清单\n无');
  const input = files(1); input[0].hunks[0].lines[0].content = 'x'.repeat(50000);
  const result = await ai.analyzeOverview({ folder: '', files: input });
  assert.match(result.coverageNotices[0], /f0.js/);
  assert.equal(ai.getCompletionContext(result).provenance.files[0].aiTruncated, true);
});

test('父检查点取消同时清理失败子跑道，恢复不再发起调用', async () => {
  const { ai, calls } = loadAi((n, messages, options, cfg) => {
    if (cfg.model === 'bad') throw new Error('子模型故障');
    return '完成';
  });
  await ai.analyzeOverviewMulti({ folder: '', files: files(1), runId: 'discard-child',
    models: [{ backend: 'api', model: 'bad' }, { backend: 'api', model: 'good' }] });
  assert.ok(state.lanes.get('discard-child-m0').pausedState);
  const count = calls.length;
  assert.equal(control.cancelRun('discard-child'), true);
  assert.equal(await ai.resumeRun('discard-child'), null);
  assert.equal(calls.length, count);
  assert.equal(state.lanes.size, 0);
});

test('汇总和备用汇总均失败保留父检查点，恢复不重复 reviewer', async () => {
  let fail = true;
  const { ai, calls } = loadAi((n, messages, options) => {
    if (fail && options.kind === '多模型汇总') throw new Error('汇总失败');
    return '原文';
  });
  const result = await ai.analyzeOverviewMulti({ folder: '', files: files(1), runId: 'fallback-resume',
    models: [{ backend: 'api', model: 'a' }, { backend: 'opencode', model: 'b' }] });
  assert.equal(result.failed.stage, 'synthesis');
  assert.equal(calls.length, 4);
  fail = false;
  await ai.resumeRun('fallback-resume');
  assert.equal(calls.filter((c) => c.options.kind !== '多模型汇总').length, 2);
  assert.equal(calls.length, 5);
});

test('汇总器失败后的实际备用模型及思考强度保留', async () => {
  const { ai } = loadAi((n, messages, options, cfg) => {
    if (options.kind === '多模型汇总' && cfg.backend === 'api') throw new Error('汇总失败');
    return cfg.backend === 'opencode' ? 'CLI原文' : 'API原文';
  });
  const result = await ai.analyzeOverviewMulti({ folder: '', files: files(1), runId: 'fallback',
    models: [{ backend: 'api', model: 'api-model' }, { backend: 'opencode', model: 'cli-model', effort: 'high' }],
    synthesizer: { backend: 'api', model: 'syn-model' } });
  const context = ai.getCompletionContext(result);
  const raw = context.historyPerModel;
  assert.equal(raw[2].outcome, 'failed');
  assert.equal(raw[3].slotId, 'synthesizer-fallback');
  assert.equal(raw[3].model, 'cli-model');
  assert.equal(raw[3].effort, 'high');
  assert.equal(raw[3].markdown, 'CLI原文');
  assert.equal(context.provenance.backends.at(-1).role, 'synthesizer');
});

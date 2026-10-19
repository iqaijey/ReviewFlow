const ai = require('./ai');
const prompts = require('./ai/prompts');
const snapshots = require('./reviewSnapshot');
const { captureProjectRules, rulesForPaths, withCapturedRules, storedPlanContext } = require('./ai/planContext');
const settings = require('./settings');
/** @typedef {{backend:string,model:string,inputChars:number,inputTokens:number,maxOutputTokens:number}} Call */
/** 估算而非 tokenizer：CJK 每字符约 1 token，其他字符每 4 字符约 1 token。 @param {string} text */
function estimateTokens(text) {
  let cjk = 0, other = 0;
  for (const char of text) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}
function identity(cfg) {
  const frozen = ai.freezeBackend(cfg);
  return { backend: frozen._reviewBackend.backend, model: frozen._reviewBackend.resolvedModel || '' };
}
/** @param {Call[]} calls @param {ReturnType<typeof settings.validatePricing>} pricing @param {string[]} notes */
function priceCalls(calls, pricing, notes) {
  let min = 0, max = 0;
  /** @type {string|null} */
  let currency = null;
  let complete = true;
  for (const call of calls) {
    const price = pricing[`${call.backend}:${call.model}`] || pricing[call.backend];
    if (!price) {
      complete = false;
      if (call.backend !== 'api' && !notes.includes('订阅制 CLI 按其套餐计费，金额仅供参考')) notes.push('订阅制 CLI 按其套餐计费，金额仅供参考');
      continue;
    }
    if (currency && currency !== price.currency) { complete = false; notes.push('价格币种不一致，未换汇，无法合计金额'); }
    currency = price.currency;
    const input = call.inputTokens * price.inputPerMTokens / 1000000;
    min += input; max += input + call.maxOutputTokens * price.outputPerMTokens / 1000000;
  }
  if (!complete) notes.push('部分后端未配置可合计的价格，金额不可用');
  if (!Number.isFinite(min) || !Number.isFinite(max)) { notes.push('价格计算超出数值范围'); return null; }
  return complete && currency ? { currency, min, max } : null;
}
async function resolveFiles(payload) {
  if (payload.snapshotId) {
    const files = snapshots.getSnapshotFiles(payload.snapshotId, payload.folder);
    if (!files) throw new Error('改动快照不存在或已过期，请重新加载改动');
    return files;
  }
  const latest = snapshots.getLatestSnapshot(payload.folder);
  if (payload.files === undefined && latest?.source.mode) {
    const source = latest.source;
    return (await require('./git').getChanges(payload.folder, { mode: source.mode, base: source.requestedBase,
      commits: source.commits.length ? source.commits.map((c) => c.sha) : null })).files;
  }
  if (payload.files !== undefined) {
    if (!Array.isArray(payload.files) || payload.files.length > 200) throw new Error('估算文件列表无效');
    for (const file of payload.files) {
      if (!file || typeof file.path !== 'string' || !Array.isArray(file.hunks)) throw new Error('估算文件格式无效');
      require('./patchSafety').safePath(file.path);
    }
    const patterns = [...await settings.getExcludePatterns(), ...require('./effectiveRules').rootIgnorePatterns(payload.folder)];
    return structuredClone(payload.files).map((f) => ({ ...f, resource: f.resource || require('./git').isResourcePath(f.path), excluded: f.excluded || Boolean(require('./globMatch').excludedBy(f.path, patterns)) }));
  }
  return (await require('./git').getChanges(payload.folder, {})).files;
}
async function estimateRun(payload) {
  const { folder, kind, noiseLevelOverride, planEnabled } = payload;
  require('./patchSafety').validateFolder(folder);
  if (!['overview', 'full', 'file'].includes(kind)) throw new Error('估算类型必须为 overview、full 或 file');
  const cfg = await settings.getSettings();
  prompts.effectiveNoiseLevel(noiseLevelOverride, cfg.noiseLevel);
  const allFiles = await resolveFiles(payload), files = allFiles.filter((f) => !f.resource && !f.excluded);
  const activePlan = planEnabled === false ? null : require('./planStore').getActivePlan(folder);
  const planContext = activePlan ? storedPlanContext(folder, activePlan.id) : '';
  const notes = ['token 为启发式估算：CJK 每字符约 1 token，其他字符每 4 字符约 1 token；不含协议开销、缓存折扣、重试或隐藏推理 token。'];
  if (allFiles.length !== files.length) notes.push(`已跳过 ${allFiles.length - files.length} 个资源或排除文件`);
  /** @type {Call[]} */
  const calls = [];
  const add = (config, system, user, maxOutputTokens) => {
    const text = `${system}\n\n${user}`;
    calls.push({ ...identity(config), inputChars: text.length, inputTokens: estimateTokens(text), maxOutputTokens });
  };
  const synthesize = (config, count, system, prefix) => {
    if (count < 2) return;
    // 输出长度无法预知：每份按约 4000 字符、每层压缩一半估算，与真实 24000 分组预算一致。
    let inputs = Array.from({ length: count }, () => '评'.repeat(4000));
    for (;;) {
      const groups = prompts.groupSynthesisResults(inputs, 24000);
      if (groups.length <= 1) { add(config, system, prefix + (groups[0] || ''), 4096); break; }
      for (const group of groups) add(config, system, prefix + group, 4096);
      inputs = groups.map((group) => '评'.repeat(Math.ceil(group.length / 2)));
    }
  };
  if (kind === 'file') {
    if (typeof payload.filePath !== 'string' || !payload.filePath) throw new Error('逐文件估算缺少文件路径');
    const file = files.find((f) => f.path === payload.filePath);
    if (file) {
      const prepared = await ai.prepareFileAnalysis({ folder, file, planContext, planEnabled, noiseLevelOverride });
      add(prepared.cfg, prepared.system, prepared.user, 2048);
    } else if (!allFiles.some((f) => f.path === payload.filePath)) throw new Error('估算文件不在当前改动中');
  } else if (files.length) {
    const ctx = kind === 'overview' ? await ai.prepareOverview({ folder, files, rulePaths: allFiles.map((f) => f.path), planContext, planEnabled, noiseLevelOverride }) : null;
    const split = ctx || prompts.splitIntoBatches(folder, files);
    const rules = ctx?.rules || captureProjectRules(folder, allFiles.map((f) => f.path));
    const baseSystem = prompts.withCustomPrompt(prompts.FULL_EXPLAIN_SYSTEM, cfg);
    const batchSystems = ctx?.batchSystems || split.batchPaths.map((paths) => withCapturedRules(baseSystem, rulesForPaths(rules, paths)));
    const system = ctx?.system || withCapturedRules(baseSystem, rules);
    const prefix = ctx ? `${ctx.pendingText ? ctx.pendingText + '\n\n' : ''}${ctx.plan ? ctx.plan + '\n\n' : ''}${ctx.prevText ? ctx.prevText + '\n\n' : ''}` : planContext ? planContext + '\n\n' : '';
    const multi = payload.multiModels;
    const models = Array.isArray(multi) ? multi : multi?.models;
    if (models !== undefined && (!Array.isArray(models) || models.length < 2 || models.length > 4 || models.some((m) => !m || !['api', 'opencode', 'kimi', 'codex'].includes(m.backend)))) throw new Error('多模型估算须选择 2–4 个有效模型');
    if (models && kind !== 'overview') throw new Error('多模型仅支持整体分析估算');
    const configs = models ? models.map((m) => ai.applyModelOverride(cfg, m)) : [cfg];
    for (const config of configs) {
      split.batches.forEach((batch, i) => {
        const label = split.batches.length > 1 ? `（第 ${i + 1}/${split.batches.length} 批）` : '';
        const user = kind === 'overview' ? `${prefix}以下是本次未提交的代码改动${label}（unified diff），请进行多角度评审：\n\n${batch.join('\n\n')}` : `${prefix}以下是部分代码改动${label}（unified diff），请完整详细讲解：\n\n${batch.join('\n\n')}`;
        add(config, batchSystems[i], user, kind === 'overview' ? 4096 : 8192);
      });
      if (kind === 'overview') synthesize(config, split.batches.length, system, prefix);
    }
    if (models) {
      const synthesizer = !Array.isArray(multi) && multi.synthesizer ? ai.applyModelOverride(cfg, multi.synthesizer) : cfg;
      synthesize(synthesizer, models.length, system, prefix);
    }
    if (kind === 'overview' && (split.batches.length > 1 || models)) notes.push('综合及分层合并按每份输出约 4000 字符、每层压缩一半近似；实际调用数与金额可能变化');
  }
  const perBackend = [];
  for (const call of calls) {
    let entry = perBackend.find((b) => b.backend === call.backend && b.model === call.model);
    if (!entry) { entry = { backend: call.backend, model: call.model, calls: 0, inputTokens: 0 }; perBackend.push(entry); }
    entry.calls++; entry.inputTokens += call.inputTokens;
  }
  const cost = priceCalls(calls, settings.validatePricing(cfg.pricing || {}), notes);
  return { calls: calls.length, inputChars: calls.reduce((n, c) => n + c.inputChars, 0), inputTokens: calls.reduce((n, c) => n + c.inputTokens, 0),
    maxOutputTokens: calls.reduce((n, c) => n + c.maxOutputTokens, 0), perBackend, cost, notes: [...new Set(notes)] };
}
module.exports = { estimateTokens, priceCalls, estimateRun };

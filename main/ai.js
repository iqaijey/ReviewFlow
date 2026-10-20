const fs = require('fs');
const { getSettings, resolveConnectionSettings } = require('./settings');
const { readKimiConfig, readCodexConfig } = require('./cliConfig');
const {
  getRuns,
  getRunPrompt,
  getCurrentRun,
  pauseRun,
  cancelRun,
  setChunkSender,
  onRunsChanged,
  notifyRunsChanged,
  ensureRunId,
  ensureLane,
  resolveLane,
  ownerRunId,
  maybeCleanupLane,
  touchLane,
  cancelledError,
} = require('./ai/runControl');
const { cliCmdLabel, chatViaCli, listOpencodeModels, listCodexModels } = require('./ai/cli');
const { chatViaApi } = require('./ai/backends');
const {
  fileToPromptText,
  overviewSectionsText,
  buildOverviewSystem,
  FULL_EXPLAIN_SYSTEM,
  PLAN_SYSTEM,
  splitIntoBatches,
  groupSynthesisResults,
  buildExplainContext,
  captureExplainSelection, buildIndexedExplainContext,
  withCustomPrompt,
  applyPromptOverride,
  ISSUE_LIST_SECTION, LEGACY_CHECK_SECTION, effectiveNoiseLevel, noiseInstructions, selectPendingFindings, pendingFindingsText,
} = require('./ai/prompts');
const { normalizePlanContext, withProjectRules, captureProjectRules, rulesForPaths, withCapturedRules, imageMime } = require('./ai/planContext');
const reviewSnapshots = require('./reviewSnapshot');
const { randomUUID } = require('crypto');
const completionContexts = new WeakMap();
const completedRuns = new Map();
const FILE_ANALYSIS_CHAR_LIMIT = 12000;
function completedResult(result, state) {
  if (resolveLane(state.runId)?.cancelled) throw cancelledError();
  if (state.parent) {
    const paths = state.aiTruncatedPaths || [];
    result.coverageNotices = [
      ...(paths.length ? [`以下文件内容超出单次分析上限被截断：${paths.join('、')}`] : []),
      ...(state.synthesisNotices || []),
    ];
    if (state.provenance) state.provenance.files = state.provenance.files.map((f) => ({ ...f, aiTruncated: paths.includes(f.path) }));
  }
  completionContexts.set(result, { ...state, reviewId: state.reviewId || state.runId });
  if (state.parent) {
    completedRuns.set(state.runId, result);
    if (completedRuns.size > 20) completedRuns.delete(completedRuns.keys().next().value);
  }
  return result;
}
function getCompletionContext(result) { return result && completionContexts.get(result); }

function freezeBackend(cfg, slotId = 'reviewer-0', role = 'reviewer') {
  const field = { api: 'model', opencode: 'opencodeModel', kimi: 'kimiModel', codex: 'codexModel' }[cfg.backend];
  const requestedModel = cfg[field] || null;
  const cli = cfg.backend === 'kimi' ? readKimiConfig() : cfg.backend === 'codex' ? readCodexConfig() : null;
  const resolvedModel = requestedModel || cli?.defaultModel || null;
  const effort = cfg.reasoningEffort || cli?.effort || '';
  const backend = { slotId, role, backend: cfg.backend || 'api', requestedModel, resolvedModel,
    modelSource: requestedModel ? 'settings' : cli?.defaultModel ? 'cli-config' : 'backend-default', effort };
  return { ...cfg, ...(resolvedModel && field ? { [field]: resolvedModel } : {}), reasoningEffort: effort, _reviewBackend: backend };
}

function freezeProvenance(payload, files, cfg, rules, plan, inputs) {
  const snapshot = reviewSnapshots.getSnapshot(payload.snapshotId, payload.folder) || reviewSnapshots.buildSnapshot(files, null);
  const { snapshotId, ...captured } = snapshot;
  const { app } = require('electron');
  const provenance = { ...captured, capturedAt: Date.now(),
    plan: plan && typeof payload.planId === 'string' && payload.planId ? { id: payload.planId, title: typeof payload.planTitle === 'string' ? payload.planTitle : '', contextHash: reviewSnapshots.hash(plan) } : null,
    preset: typeof payload.presetId === 'string' && payload.presetId ? { id: payload.presetId, name: typeof payload.presetName === 'string' ? payload.presetName : '' } : null,
    projectRules: { fileHash: rules.fileHash, injectedHash: rules.injectedHash, files: rules.files.map((f) => f.path) },
    appVersion: app?.getVersion ? app.getVersion() : require('../package.json').version,
    promptVersion: 'review-v2', promptInputsHash: reviewSnapshots.hash(JSON.stringify(inputs)), noiseLevel: cfg.noiseLevel || 'balanced', backends: [] };
  cfg._reviewProvenance = provenance;
  cfg._promptHashes = [provenance.promptInputsHash];
  return provenance;
}

function recordInvocation(cfg, messages) {
  if (!cfg._reviewProvenance) return;
  const fingerprint = reviewSnapshots.hash(JSON.stringify(messages.map((m) => [m.role, m.content])));
  if (!cfg._promptHashes.includes(fingerprint)) cfg._promptHashes.push(fingerprint);
  cfg._reviewProvenance.promptInputsHash = reviewSnapshots.hash(JSON.stringify(cfg._promptHashes));
  const backend = cfg._reviewBackend;
  if (backend && !cfg._reviewProvenance.backends.some((b) => b.slotId === backend.slotId)) cfg._reviewProvenance.backends.push({ ...backend });
}

/**
 * @param {any} settings
 * @param {any} messages
 * @param {{ maxTokens?: number, temperature?: number, folder?: string | null, kind?: string, batch?: string, batchIndex?: number | null, batchTotal?: number | null, runId?: string | null, stream?: boolean }} [options]
 */
async function chatWithStats(settings, messages, { maxTokens = 1024, temperature = 0.2, folder = null, kind = 'AI 调用', batch = '', batchIndex = null, batchTotal = null, runId = null, stream = false } = {}) {
  const cfg = settings || (await getSettings());
  recordInvocation(cfg, messages);
  const startedAt = Date.now();
  // 多模态消息（content 为数组）只提取文本部分用于运行详情展示
  const promptText = messages.map((m) => {
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map((p) => (p && p.type === 'text' ? p.text : '[图片]')).join('\n');
    }
    return String(m.content || '');
  }).join('\n\n');
  // 并发跑道：渲染进程传入的 runId 直接沿用，未传时生成；同 runId 的批次共享一条跑道
  if (!runId) runId = ensureRunId(null);
  const lane = ensureLane(runId);
  if (lane.cancelled) throw cancelledError();
  touchLane(lane);
  if (cfg.backend === 'opencode' || cfg.backend === 'kimi' || cfg.backend === 'codex') {
    // 模型与思考强度以 CLI 实际配置为准：未覆盖时读取各 CLI 的 config.toml
    let model = '默认模型';
    let effort = cfg.reasoningEffort || '';
    if (cfg._reviewBackend) {
      model = cfg._reviewBackend.resolvedModel || '默认模型';
      effort = cfg._reviewBackend.effort;
    } else if (cfg.backend === 'opencode') {
      model = cfg.opencodeModel || '默认模型';
    } else if (cfg.backend === 'kimi') {
      const kimiCfg = readKimiConfig();
      model = cfg.kimiModel || kimiCfg.defaultModel || '默认模型';
      // kimi CLI 无 effort 参数，实际值来自其 config.toml 的 [thinking] effort
      effort = cfg.reasoningEffort || kimiCfg.effort || '';
    } else {
      const codexCfg = readCodexConfig();
      model = cfg.codexModel || codexCfg.defaultModel || '默认模型';
      effort = cfg.reasoningEffort || codexCfg.effort || '';
    }
    lane.currentRun = {
      kind, batch, batchIndex, batchTotal, backend: cfg.backend, model, effort,
      command: cliCmdLabel(cfg.backend, cfg, folder),
      promptChars: promptText.length, promptText, startedAt,
    };
    notifyRunsChanged();
    try {
      const content = await chatViaCli(cfg.backend, cfg, messages, folder, runId);
      if (lane.cancelled) throw cancelledError();
      return {
        content,
        stats: {
          backend: cfg.backend,
          model,
          effort,
          promptTokens: null,
          completionTokens: null,
          durationMs: Date.now() - startedAt,
        },
      };
    } finally {
      lane.currentRun = null;
      lane.currentCancel = null;
      maybeCleanupLane(runId);
    }
  }
  if (!cfg.apiKey) throw new Error('请先在「AI 设置」中配置 API Key');
  const url = `${String(cfg.baseUrl || '').replace(/\/+$/, '')}/chat/completions`;
  lane.currentRun = {
    kind, batch, batchIndex, batchTotal, backend: 'api', model: cfg.model, effort: cfg.reasoningEffort || '',
    command: `POST ${url}`,
    promptChars: promptText.length, promptText, startedAt,
  };
  notifyRunsChanged();
  try {
    const { content, usage, appliedEffort } = await chatViaApi(cfg, messages, { maxTokens, temperature, stream, runId });
    if (lane.cancelled) throw cancelledError();
    return {
      content,
      stats: {
        backend: 'api',
        model: cfg.model,
        effort: appliedEffort,
        promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null,
        completionTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null,
        durationMs: Date.now() - startedAt,
      },
    };
  } finally {
    lane.currentRun = null;
    lane.currentCancel = null;
    maybeCleanupLane(runId);
  }
}

async function chat(settings, messages, options) {
  const { content } = await chatWithStats(settings, messages, options);
  return content;
}

// 多次调用的 stats 聚合：token 求和（全为 null 则 null），耗时求和
function aggregateStats(list) {
  const sumToken = (key) => {
    let total = 0;
    let seen = false;
    for (const s of list) {
      if (s && typeof s[key] === 'number') {
        total += s[key];
        seen = true;
      }
    }
    return seen ? total : null;
  };
  return {
    backend: list.length && list[0] ? list[0].backend : null,
    model: list.length && list[0] ? list[0].model : null,
    effort: list.length && list[0] ? list[0].effort : '',
    promptTokens: sumToken('promptTokens'),
    completionTokens: sumToken('completionTokens'),
    durationMs: list.reduce((t, s) => t + ((s && s.durationMs) || 0), 0),
  };
}

// 从指定跑道的 pausedState 的 nextIndex 继续原分批循环；无暂停状态返回 null
async function resumeRun(runId) {
  runId = ownerRunId(runId);
  if (completedRuns.has(runId)) return completedRuns.get(runId);
  const lane = resolveLane(runId);
  const state = lane && lane.pausedState;
  if (!state) return null;
  lane.pausedState = null;
  lane.pauseRequested = false;
  for (const childId of lane.childRunIds || []) {
    const child = resolveLane(childId);
    if (child) child.pauseRequested = false;
  }
  lane.batchRunActive = true;
  notifyRunsChanged();
  try {
    // 多模型子跑道续跑时必须沿用该模型的配置，不能回退到当前设置
    const cfg = state.cfg || (await getSettings());
    if (state.kind === 'multi') return await runMulti(state.multi);
    if (state.kind === 'full') {
      return await runFullBatches(cfg, state);
    }
    return await runOverviewBatches(cfg, state);
  } finally {
    lane.batchRunActive = false;
    lane.pauseRequested = false;
    if (!lane.pausedState) reviewSnapshots.releaseRunSnapshots(state.runId);
    maybeCleanupLane(state.runId);
  }
}

// 拉取可用模型列表：api 走 OpenAI 兼容的 GET /models，opencode 走本机 CLI
async function listModels(settings) {
  const cfg = await resolveConnectionSettings(settings);
  if (cfg.backend === 'opencode') {
    return listOpencodeModels();
  }
  if (cfg.backend === 'kimi') {
    const { models } = readKimiConfig();
    if (!models.length) throw new Error('未从 Kimi CLI 配置中读取到模型列表');
    return models;
  }
  if (cfg.backend === 'codex') {
    return listCodexModels();
  }
  if (!cfg.apiKey) throw new Error('请先填写 API Key');
  const url = `${String(cfg.baseUrl || '').replace(/\/+$/, '')}/models`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 300);
    throw new Error(`拉取模型列表失败 (${resp.status}): ${detail || resp.statusText}`);
  }
  const data = /** @type {any} */ (await resp.json());
  const ids = (Array.isArray(data.data) ? data.data : [])
    .map((m) => m && m.id)
    .filter((id) => typeof id === 'string' && id);
  return [...new Set(ids)].sort();
}

// 比旧预算留出更多具体问题空间；超过预算分层合并，不能直接裁掉后续批次。
const SYNTHESIS_CHAR_BUDGET = 24000;
// 每组合并结果控制在预算一半以内，两组即可装进下一层的一组，保证逐层收敛
const MERGE_TARGET_CHARS = Math.floor(SYNTHESIS_CHAR_BUDGET / 2);
const MERGE_SYSTEM = '请用中文合并、去重以下评审片段，保留每一个具体问题、文件/行号、证据、建议及遗留问题核对结论。' +
  '只压缩重复表述，不要用笼统总结替代具体问题，不要遗漏末尾片段；保留来源标记。' +
  `输出总长度控制在 ${MERGE_TARGET_CHARS} 字以内：优先精简分析性描述，但每条具体问题都必须保留为问题清单中的一行。` +
  ISSUE_LIST_SECTION + LEGACY_CHECK_SECTION;

/** @param {string[]} parts */
function unmergedReport(parts) {
  return '> 注：各部分评审结果过长，模型未能进一步压缩，未生成统一的综合报告；以下按部分完整列出，未丢弃任何内容。\n\n' +
    parts.map((part, i) => `## 第 ${i + 1} 部分（合并结果）\n\n${part}`).join('\n\n---\n\n');
}

// 保存每层已完成的合并，续跑仅重试失败调用。以「重新分组后的组数」判断是否收敛：
// 组数不减少说明模型压不下去，此时不再报错重试（重试大概率同样失败），而是无损列出各部分结果。
async function synthesizeResults(cfg, state, inputs, system, prefix, options) {
  const progress = state.synthesis || (state.synthesis = { inputs, groups: null, merged: [] });
  const shouldPause = () => resolveLane(ownerRunId(options.runId))?.pauseRequested;
  for (;;) {
    if (shouldPause()) return null;
    const groups = progress.groups || groupSynthesisResults(progress.inputs, SYNTHESIS_CHAR_BUDGET);
    progress.groups = groups;
    if (groups.length <= 1) {
      const result = await chatWithStats(cfg, [
        { role: 'system', content: system },
        { role: 'user', content: `${prefix}${groups[0] || ''}` },
      ], options);
      state.statsList.push(result.stats);
      return result.content;
    }
    for (let i = progress.merged.length; i < groups.length; i += 1) {
      if (shouldPause()) return null;
      const result = await chatWithStats(cfg, [
        { role: 'system', content: withCapturedRules(MERGE_SYSTEM, state.rules || { text: '' }) + noiseInstructions(cfg.noiseLevel) },
        { role: 'user', content: prefix + groups[i] },
      ], { ...options, batch: `（分层合并 ${i + 1}/${groups.length}）` });
      state.statsList.push(result.stats);
      progress.merged.push(result.content);
    }
    if (groupSynthesisResults(progress.merged, SYNTHESIS_CHAR_BUDGET).length >= groups.length) {
      state.synthesisNotices = ['综合阶段内容过长，模型未能压缩到单次综合上限，已按部分完整列出合并结果（未生成统一总结）'];
      return unmergedReport(progress.merged);
    }
    progress.inputs = progress.merged;
    progress.groups = null;
    progress.merged = [];
  }
}

/**
 * @param {'batch' | 'synthesis'} [stage]
 * @param {Error & { cancelled?: boolean }} [error]
 */
function checkpointResult(lane, state, markdown, nextIndex, stage = undefined, error = undefined) {
  if (lane.cancelled || (error && (error.cancelled || String(error.message).includes('已被用户终止')))) {
    throw cancelledError();
  }
  lane.pauseRequested = false;
  state.nextIndex = nextIndex;
  state.pausedAt = Date.now();
  lane.pausedState = state;
  touchLane(lane);
  const failed = stage ? {
    stage, batchIndex: stage === 'batch' ? nextIndex + 1 : state.batches.length,
    batchTotal: state.batches.length, message: error && error.message ? error.message : String(error),
  } : undefined;
  const notice = failed
    ? `（${stage === 'batch' ? `第 ${failed.batchIndex}/${failed.batchTotal} 批` : '综合'}失败：${failed.message}；已保留完成结果，可在「运行详情」中继续）`
    : '（已暂停，可在「运行详情」中继续）';
  return { markdown: `${markdown}\n\n${notice}`, stats: aggregateStats(state.statsList), paused: true, ...(failed ? { failed } : {}) };
}

// 整体分析分批循环：每批开始前检查暂停请求，暂停时保存续跑状态并返回已完成部分；
// 正常跑完后多批结果再综合（续跑走到这里同样执行综合）
// state.runLabel 可选：多模型评审时用于在运行详情中区分各模型跑道
async function runOverviewBatches(cfg, state) {
  const { folder, batches, system, runId } = state;
  const runKind = state.runLabel || '整体分析';
  const lane = ensureLane(runId);
  const planPrefix = state.planContext ? `${state.planContext}\n\n` : '';
  // 遗留问题清单放在用户消息开头，让各批与综合都能看到
  const pendingPrefix = state.pendingText ? `${state.pendingText}\n\n` : '';
  // 上次评审结论，供对比「哪些已修复/仍存在/新引入」
  const prevPrefix = state.prevText ? `${state.prevText}\n\n` : '';
  for (let i = state.nextIndex; i < batches.length; i += 1) {
    if (lane.cancelled) throw cancelledError();
    if (lane.pauseRequested) {
      return checkpointResult(lane, state, state.batchResults.join('\n\n'), i);
    }
    const label = batches.length > 1 ? `（第 ${i + 1}/${batches.length} 批）` : '';
    const user = `${pendingPrefix}${planPrefix}${prevPrefix}以下是本次未提交的代码改动${label}（unified diff），请进行多角度评审：\n\n${batches[i].join('\n\n')}`;
    try {
      const { content, stats } = await chatWithStats(cfg, [
        { role: 'system', content: state.batchSystems?.[i] || system },
        { role: 'user', content: user },
      ], { maxTokens: 4096, folder, kind: runKind, batch: label, batchIndex: i + 1, batchTotal: batches.length, runId, stream: true });
      state.batchResults.push(content);
      state.statsList.push(stats);
      state.nextIndex = i + 1;
    } catch (error) {
      return checkpointResult(lane, state, state.batchResults.join('\n\n'), i, 'batch', error);
    }
  }
  let markdown;
  if (state.batchResults.length === 1) {
    markdown = state.batchResults[0];
  } else {
    if (lane.pauseRequested) return checkpointResult(lane, state, state.batchResults.join('\n\n'), batches.length);
    const synthSystem = withCapturedRules(withCustomPrompt(
      '你是一位资深代码评审专家。以下是针对同一批代码改动分批评审得到的多份评审结果，' +
      `请将它们去重、合并为一份完整评审，仍${overviewSectionsText(cfg, Boolean(state.planContext))}\n` +
      (state.pendingText ? `${ISSUE_LIST_SECTION}\n${LEGACY_CHECK_SECTION}` : ISSUE_LIST_SECTION) +
      (state.prevText
        ? '\n另外已提供上次评审的结论：请在「总结与建议」之前追加一节 ## 与上次对比，' +
          '说明上次指出的问题本次是否已修复、哪些仍存在、本次改动新引入了什么问题。'
        : ''),
      cfg,
    ), state.rules) + noiseInstructions(state.noiseLevel) + '\n' + LEGACY_CHECK_SECTION;
    try {
      markdown = await synthesizeResults(cfg, state,
        state.batchResults.map((r, i) => `【第 ${i + 1} 批评审结果】\n${r}`),
        synthSystem, `${pendingPrefix}${planPrefix}${prevPrefix}`,
        { maxTokens: 4096, folder, kind: runKind, batch: '（综合结果）', batchIndex: batches.length, batchTotal: batches.length, runId, stream: true });
      if (markdown === null) return checkpointResult(lane, state, state.batchResults.join('\n\n'), batches.length);
    } catch (error) {
      return checkpointResult(lane, state, state.batchResults.join('\n\n'), batches.length, 'synthesis', error);
    }
  }
  if (state.reviewed < state.files.length) {
    markdown += `\n\n改动过多，仅评审了前 ${state.reviewed} 个文件。`;
  }
  return completedResult({ markdown, stats: aggregateStats(state.statsList), paused: false }, state);
}

// 过滤资源文件（图片/字体/资源目录等），不参与 AI 评审
function skipResources(files) {
  return files.filter((f) => !(f && (f.resource || f.excluded)));
}

// 整体分析的公共上下文：设置覆盖、system prompt、分批、遗留问题/上次对比前缀。
// analyzeOverview 与 analyzeOverviewMulti 共用，保证单模型/多模型 prompt 完全一致
/** @param {any} opts */
async function prepareOverview({ folder, files, rulePaths = files.map((f) => f.path), customPromptOverride = '', planContext = '', planEnabled = undefined, customDimensionsOverride = '', previousReview = '', noiseLevelOverride = undefined }) {
  let cfg = applyPromptOverride(await getSettings(), customPromptOverride);
  cfg = { ...cfg, noiseLevel: effectiveNoiseLevel(noiseLevelOverride, cfg.noiseLevel) };
  // 评审预设：本次生效的自定义维度覆盖（不写回设置）
  if (typeof customDimensionsOverride === 'string' && customDimensionsOverride.trim()) {
    cfg = { ...cfg, customDimensions: customDimensionsOverride };
  }
  const plan = planEnabled === false ? '' : normalizePlanContext(planContext);
  const rules = captureProjectRules(folder, rulePaths);
  // 上次未关闭的问题：非空时要求 AI 追加「遗留问题核对」节
  // 忽略 renderer 的 pendingIssues；只有主进程存储中的活动问题可参与复核。
  const pending = folder ? selectPendingFindings(require('./store').listChecklist(folder)) : [];
  const issueSuffix = `\n${ISSUE_LIST_SECTION}\n${LEGACY_CHECK_SECTION}${noiseInstructions(cfg.noiseLevel)}`;
  // 上次评审结论：非空时注入各批 prompt，并要求追加「与上次对比」节
  const prev = typeof previousReview === 'string' ? previousReview.trim() : '';
  const prevSuffix = prev
    ? '\n另外已提供上次评审的结论：请在「总结与建议」之前追加一节 ## 与上次对比，' +
      '说明上次指出的问题本次是否已修复、哪些仍存在、本次改动新引入了什么问题。'
    : '';
  const { batches, reviewed, batchPaths, aiTruncatedPaths } = splitIntoBatches(folder, files);
  const baseSystem = withCustomPrompt(buildOverviewSystem(cfg, Boolean(plan)), cfg);
  return {
    cfg,
    rules,
    batchSystems: batchPaths.map((paths) => withCapturedRules(baseSystem, rulesForPaths(rules, paths)) + issueSuffix + prevSuffix),
    captured: pending.map((f) => ({ id: f.id, updatedAt: f.updatedAt })),
    system: withCapturedRules(withCustomPrompt(buildOverviewSystem(cfg, Boolean(plan)), cfg), rules) + issueSuffix + prevSuffix,
    issueSuffix,
    prevSuffix,
    plan,
    prevText: prev
      ? `上次评审的结论（供对比参考，不需要复述它）：\n${prev.length > 8000 ? `${prev.slice(0, 8000)}\n（过长已截断）` : prev}`
      : '',
    pendingText: pendingFindingsText(pending),
    batches,
    reviewed,
    aiTruncatedPaths,
  };
}

async function analyzeOverview({ folder, files, runId = null, title = '', kind = 'review', noiseLevelOverride = undefined, customPromptOverride = '', planContext = '', pendingIssues = [], customDimensionsOverride = '', previousReview = '', ...metadata }) {
  files = structuredClone(files);
  const allFiles = files;
  files = skipResources(files);
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('没有可分析的改动');
  }
  const ctx = await prepareOverview({ folder, files, rulePaths: allFiles.map((f) => f.path), customPromptOverride, planContext, customDimensionsOverride, previousReview, noiseLevelOverride, planEnabled: metadata.planEnabled });
  ctx.cfg = freezeBackend(ctx.cfg);
  const provenance = freezeProvenance({ ...metadata, folder }, allFiles, ctx.cfg, ctx.rules, ctx.plan, [ctx.system, ctx.batches, ctx.plan, ctx.pendingText, ctx.prevText]);
  runId = ensureRunId(runId);
  const state = {
    provenance, rules: ctx.rules, snapshotId: metadata.snapshotId,
    title, historyKind: kind, reviewId: randomUUID(), noiseLevel: ctx.cfg.noiseLevel, captured: ctx.captured, parent: true,
    kind: 'overview',
    folder,
    files,
    cfg: ctx.cfg,
    system: ctx.system,
    batchSystems: ctx.batchSystems,
    planContext: ctx.plan,
    prevText: ctx.prevText,
    pendingText: ctx.pendingText,
    batchResults: [],
    statsList: [],
    nextIndex: 0,
    batches: ctx.batches,
    reviewed: ctx.reviewed,
    aiTruncatedPaths: ctx.aiTruncatedPaths,
    runId,
    pausedAt: null,
  };
  const lane = ensureLane(runId);
  reviewSnapshots.retainSnapshot(metadata.snapshotId, runId);
  lane.batchRunActive = true;
  try {
    return await runOverviewBatches(ctx.cfg, state);
  } finally {
    lane.batchRunActive = false;
    lane.pauseRequested = false;
    if (!lane.pausedState) reviewSnapshots.releaseSnapshot(metadata.snapshotId, runId);
    maybeCleanupLane(runId);
  }
}

// 多模型评审的后端槽位与模型字段映射
const BACKEND_LABELS = { api: 'API', opencode: 'OpenCode', kimi: 'Kimi CLI', codex: 'Codex' };
const MODEL_FIELD_BY_BACKEND = { api: 'model', opencode: 'opencodeModel', kimi: 'kimiModel', codex: 'codexModel' };

// 按槽位覆盖模型/思考强度：model 为空时沿用设置里该后端已配置的值
function applyModelOverride(base, m) {
  const cfg = { ...base, backend: m.backend };
  const field = MODEL_FIELD_BY_BACKEND[m.backend];
  if (field && typeof m.model === 'string' && m.model) cfg[field] = m.model;
  if (typeof m.effort === 'string' && m.effort) cfg.reasoningEffort = m.effort;
  return cfg;
}

// 多模型并行评审：每个选中模型跑完整体分析（独立子跑道，互不影响），
// 全部结束后由指定的汇总模型合并为一份报告。单个模型失败不阻断其他模型
/** @param {any} opts */
async function analyzeOverviewMulti({ folder, files, models = [], synthesizer = null, runId = null, title = '', kind = 'review', noiseLevelOverride = undefined, customPromptOverride = '', planContext = '', pendingIssues = [], customDimensionsOverride = '', previousReview = '', ...metadata }) {
  files = structuredClone(files);
  const allFiles = files;
  files = skipResources(files);
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('没有可分析的改动');
  }
  const validModels = (Array.isArray(models) ? models : [])
    .filter((m) => m && MODEL_FIELD_BY_BACKEND[m.backend])
    .slice(0, 4);
  if (validModels.length < 2) throw new Error('多模型评审至少需要选择 2 个模型');
  const ctx = await prepareOverview({ folder, files, rulePaths: allFiles.map((f) => f.path), customPromptOverride, planContext, customDimensionsOverride, previousReview, noiseLevelOverride, planEnabled: metadata.planEnabled });
  const provenance = freezeProvenance({ ...metadata, folder }, allFiles, ctx.cfg, ctx.rules, ctx.plan, [ctx.system, ctx.batches, ctx.plan, ctx.pendingText, ctx.prevText]);
  const modelConfigs = validModels.map((m, i) => freezeBackend(applyModelOverride(ctx.cfg, m), m.slotId || `reviewer-${i}`));
  const syn = synthesizer && MODEL_FIELD_BY_BACKEND[synthesizer.backend] ? synthesizer : { backend: ctx.cfg.backend };
  const synCfg = freezeBackend(applyModelOverride(ctx.cfg, syn), syn.slotId || 'synthesizer', 'synthesizer');
  runId = ensureRunId(runId);
   const mainLane = ensureLane(runId);
    mainLane.childRunIds = validModels.map((_, i) => `${runId}-m${i}`);
    for (const childRunId of mainLane.childRunIds) ensureLane(childRunId).parentRunId = runId;
   const multi = { ctx, provenance, modelConfigs, validModels, syn, synCfg, folder, files, runId,
     title, historyKind: kind, reviewId: randomUUID(), snapshotId: metadata.snapshotId, results: [], synState: { statsList: [], rules: ctx.rules } };
   reviewSnapshots.retainSnapshot(metadata.snapshotId, runId);
   return runMulti(multi);
}

async function runMulti(multi) {
   const { ctx, provenance, modelConfigs, validModels, syn, synCfg, folder, files, runId, title, historyKind } = multi;
   const mainLane = ensureLane(runId);
   mainLane.batchRunActive = true;
   try {
     const settled = await Promise.allSettled(validModels.map(async (m, i) => {
       if (mainLane.cancelled) throw cancelledError();
       if (multi.results[i] && !multi.results[i].paused) return multi.results[i];
      const cfg = modelConfigs[i];
      const label = BACKEND_LABELS[m.backend] || m.backend;
      const subRunId = `${runId}-m${i}`;
       const lane = ensureLane(subRunId);
       lane.parentRunId = runId;
      lane.batchRunActive = true;
       const state = lane.pausedState || {
        rules: ctx.rules,
        kind: 'overview', folder, files, cfg,
        parent: false, noiseLevel: ctx.cfg.noiseLevel,
        system: ctx.system,
        batchSystems: ctx.batchSystems,
        planContext: ctx.plan,
        prevText: ctx.prevText,
        pendingText: ctx.pendingText,
        batchResults: [], statsList: [], nextIndex: 0,
        batches: ctx.batches, reviewed: ctx.reviewed,
        runId: subRunId, pausedAt: null,
        runLabel: `整体分析（${label}）`,
       };
       lane.pausedState = null;
       try {
         const r = await runOverviewBatches(cfg, state);
         const result = { label, backend: m.backend, model: cfg[MODEL_FIELD_BY_BACKEND[m.backend]] || '', ...r };
         multi.results[i] = result;
         return result;
      } finally {
        lane.batchRunActive = false;
        lane.pauseRequested = false;
        maybeCleanupLane(subRunId);
      }
     }));
     if (mainLane.cancelled || settled.some((r) => r.status === 'rejected' && r.reason?.cancelled)) throw cancelledError();
     const incomplete = settled.findIndex((r) => r.status === 'rejected' || r.value.paused);
     if (incomplete >= 0) {
       const r = settled[incomplete];
       const message = r.status === 'rejected' ? String(r.reason?.message || r.reason) : r.value.failed?.message;
       const label = `${BACKEND_LABELS[validModels[incomplete].backend]} ${validModels[incomplete].model || ''}`;
       return multiCheckpoint(multi, message ? 'batch' : undefined, message ? new Error(`${label}：${message}`) : undefined);
     }
    const perModel = [];
    const historyPerModel = [];
    const parts = [];
    settled.forEach((r, i) => {
      const label = BACKEND_LABELS[validModels[i].backend] || validModels[i].backend;
      const identity = modelConfigs[i]._reviewBackend;
      historyPerModel.push({ slotId: identity.slotId, role: 'reviewer', backend: identity.backend, model: identity.resolvedModel,
        effort: identity.effort, outcome: r.status === 'fulfilled' ? (r.value.paused ? 'partial' : 'complete') : 'failed',
        markdown: r.status === 'fulfilled' ? r.value.markdown : null,
        error: r.status === 'rejected' ? String(r.reason?.message || r.reason) : r.value.paused ? ('failed' in r.value ? r.value.failed?.message : '评审已暂停') : null,
        stats: r.status === 'fulfilled' ? r.value.stats : null });
      if (r.status === 'fulfilled') {
        const v = r.value;
        const failure = 'failed' in v ? v.failed : undefined;
        if (v.paused || failure) {
          const errMsg = failure ? failure.message : '评审已暂停，未完成';
          perModel.push({ label, backend: v.backend, model: v.model, error: errMsg, stats: v.stats });
          parts.push(`【${label} 评审未完成，未纳入汇总】${errMsg}`);
          return;
        }
        perModel.push({ label, backend: v.backend, model: v.model, markdown: v.markdown, stats: v.stats });
        parts.push(`【${label} 的评审结果】\n${v.markdown}`);
      } else {
        const errMsg = r.reason && r.reason.message ? r.reason.message : String(r.reason);
        perModel.push({ label, backend: validModels[i].backend, model: validModels[i].model || '', error: errMsg });
        parts.push(`【${label} 评审失败，未产出结果】${errMsg}`);
      }
    });
    const okCount = perModel.filter((p) => p.markdown).length;
    if (!okCount) {
      if (settled.some((r) => r.status === 'rejected' && r.reason && r.reason.cancelled)) throw cancelledError();
      throw new Error(`所有模型都评审失败：${perModel[0] ? perModel[0].error : '未知错误'}`);
    }
    // 汇总：默认用当前设置的后端；汇总流式走主跑道，渲染端可实时看到
    const synSystem = withCapturedRules(withCustomPrompt(
      '你是一位资深代码评审专家。以下是对同一批代码改动由多个模型分别给出的评审结果，' +
      `请将它们去重、合并为一份完整评审，仍${overviewSectionsText(ctx.cfg, Boolean(ctx.plan))}\n` +
      `${ctx.issueSuffix}${ctx.prevSuffix}`,
      ctx.cfg,
    ), ctx.rules) + noiseInstructions(ctx.cfg.noiseLevel);
    const planPrefix = ctx.plan ? `${ctx.plan}\n\n` : '';
    const prefix = `${ctx.pendingText ? `${ctx.pendingText}\n\n` : ''}${planPrefix}${ctx.prevText ? `${ctx.prevText}\n\n` : ''}` +
      `以下是 ${okCount} 个模型对同一批代码改动的评审结果，请合并为一份评审：\n\n`;
    const synOptions = { maxTokens: 4096, folder, kind: '多模型汇总', batch: `${okCount} 个模型`, runId, stream: true };
     const synState = multi.synState;
     if (mainLane.cancelled) throw cancelledError();
     if (mainLane.pauseRequested) return multiCheckpoint(multi);
    // 汇总模型自身失败时，回退到第一个成功的模型后端做汇总
    let content;
    let fallbackNote = '';
    try {
       if (multi.pausedFallbackError) throw multi.pausedFallbackError;
       content = await synthesizeResults(synCfg, synState, parts, synSystem, prefix, synOptions);
       if (content === null) return multiCheckpoint(multi);
      historyPerModel.push(rawSynthesis(synCfg, content, null, synState));
    } catch (err) {
      if (mainLane.cancelled || err.cancelled || String(err.message).includes('已被用户终止')) throw cancelledError();
      const fallback = perModel.find((p) => p.markdown && p.backend !== syn.backend);
       if (!fallback) return multiCheckpoint(multi, 'synthesis', err);
      historyPerModel.push(rawSynthesis(synCfg, null, String(err.message || err), synState));
      const fallbackIndex = perModel.indexOf(fallback);
      const fallbackCfg = { ...modelConfigs[fallbackIndex], _reviewBackend: { ...modelConfigs[fallbackIndex]._reviewBackend, slotId: 'synthesizer-fallback', role: 'synthesizer' } };
       const fallbackState = multi.fallbackState || (multi.fallbackState = { statsList: [], rules: ctx.rules });
       try { content = await synthesizeResults(
         fallbackCfg, fallbackState, parts, synSystem, prefix, synOptions,
        ); } catch (error) {
          delete multi.pausedFallbackError;
          return multiCheckpoint(multi, 'synthesis', error);
        }
       if (content === null) {
         multi.pausedFallbackError = err;
         return multiCheckpoint(multi);
       }
       delete multi.pausedFallbackError;
      historyPerModel.push(rawSynthesis(fallbackCfg, content, null, fallbackState));
      const synLabel = BACKEND_LABELS[syn.backend] || syn.backend;
      fallbackNote = `\n\n> 注：汇总模型 ${synLabel} 调用失败，已改用 ${fallback.label} 汇总。`;
    }
    let markdown = content + fallbackNote;
    if (ctx.reviewed < files.length) {
      markdown += `\n\n改动过多，仅评审了前 ${ctx.reviewed} 个文件。`;
    }
    if (okCount < perModel.length) {
      const failed = perModel.filter((p) => !p.markdown).map((p) => p.label).join('、');
      markdown += `\n\n> 注：${failed} 评审失败，未纳入汇总。`;
    }
     const allStats = perModel.map((p) => p.stats).filter(Boolean).concat(synState.statsList, multi.fallbackState?.statsList || []);
     if (mainLane.cancelled) throw cancelledError();
     return completedResult({ markdown, stats: aggregateStats(allStats), perModel }, { provenance, historyPerModel, folder, files, runId, reviewId: multi.reviewId, title, historyKind, kind: 'overview', noiseLevel: ctx.cfg.noiseLevel, captured: ctx.captured, parent: true, batches: ctx.batches, rules: ctx.rules, planContext: ctx.plan, aiTruncatedPaths: ctx.aiTruncatedPaths,
       synthesisNotices: [...(synState.synthesisNotices || []), ...(multi.fallbackState?.synthesisNotices || [])] });
  } finally {
    const lane = resolveLane(runId);
    if (lane) {
      lane.batchRunActive = false;
      lane.pauseRequested = false;
      if (!lane.pausedState) {
        for (const childRunId of lane.childRunIds || []) {
          const child = resolveLane(childRunId);
          if (child) {
            child.pausedState = null;
            child.pauseRequested = false;
          }
          maybeCleanupLane(childRunId);
        }
      }
    }
    maybeCleanupLane(runId);
     if (!lane?.pausedState) reviewSnapshots.releaseSnapshot(multi.snapshotId, runId);
   }
}

/** @param {any} multi @param {'batch'|'synthesis'} [stage] @param {Error & {cancelled?:boolean}} [error] */
function multiCheckpoint(multi, stage = undefined, error = undefined) {
  const lane = ensureLane(multi.runId);
  if (lane.cancelled || error?.cancelled) throw cancelledError();
  const results = multi.results.filter(Boolean);
  const state = { kind: 'multi', multi, runId: multi.runId, nextIndex: results.filter((r) => !r.paused).length,
    batches: multi.validModels.map(() => []), statsList: results.map((r) => r.stats).concat(multi.synState.statsList, multi.fallbackState?.statsList || []) };
  return checkpointResult(lane, state, results.map((r) => `【${r.label} ${r.model}】\n${r.markdown}`).join('\n\n'), state.nextIndex, stage, error);
}

function rawSynthesis(cfg, markdown, error, state) {
  const identity = cfg._reviewBackend;
  return { slotId: identity.slotId, role: 'synthesizer', backend: identity.backend, model: identity.resolvedModel, effort: identity.effort,
    outcome: error ? (state.statsList.length ? 'partial' : 'failed') : 'complete',
    markdown: markdown || state.synthesis?.merged?.join('\n\n') || null, error, stats: aggregateStats(state.statsList) };
}

/** @param {any} payload @param {{settings:object,rules:import('./effectiveRules').RuleFile[]}|null} [captured] */
async function prepareFileAnalysis({ folder, file, planContext = '', noiseLevelOverride = undefined, customPromptOverride = '', ...metadata }, captured = null) {
  file = structuredClone(file);
  if (!file || !file.path) throw new Error('缺少要分析的文件');
  if (file.excluded) throw new Error(`该文件已被排除规则「${file.excludedBy || '项目排除规则'}」排除，不参与 AI 评审`);
  if (file.resource) {
    throw new Error('资源文件不参与 AI 评审');
  }
  const cfg = freezeBackend(applyPromptOverride(captured?.settings || await getSettings(), customPromptOverride));
  const noiseLevel = effectiveNoiseLevel(noiseLevelOverride, cfg.noiseLevel);
  cfg.noiseLevel = noiseLevel;
  const plan = metadata.planEnabled === false ? '' : normalizePlanContext(planContext || require('./ai/planContext').storedPlanContext(folder, metadata.planId));
  const rules = captured ? require('./effectiveRules').captureRules(folder, [file.path], captured.rules) : captureProjectRules(folder, [file.path]);
  let text = fileToPromptText(folder, file);
  const aiTruncated = text.length > FILE_ANALYSIS_CHAR_LIMIT;
  const coverageNotices = aiTruncated ? [`该文件内容超出单次分析上限（${FILE_ANALYSIS_CHAR_LIMIT} 字），已截断，结果可能不完整`] : [];
  if (aiTruncated) text = `${text.slice(0, FILE_ANALYSIS_CHAR_LIMIT)}\n(diff 过长已截断)`;
  const system = withCapturedRules(withCustomPrompt(
    '你是一位资深代码评审专家，请用中文、markdown 格式输出，严格使用以下二级标题分节：' +
    '## 改动概述 / ## 问题与风险 / ## 改进建议。' +
    '每节给出具体、可执行的发现，无问题的小节明确说『未发现问题』，引用具体行号。',
    cfg,
  ), rules) + noiseInstructions(noiseLevel);
  const user = `${plan ? `${plan}\n\n` : ''}以下是该文件的代码改动（unified diff），请进行评审：\n\n${text}`;
  const provenance = freezeProvenance({ ...metadata, folder }, [file], cfg, rules, plan, [system, user]);
  provenance.files = provenance.files.map((f) => ({ ...f, aiTruncated }));
  const execution = require('./cliConfig').fileAnalysisExecution(cfg, folder);
  const identity = require('./fileAnalysisCache').buildIdentity({ path: file.path,
    diffFingerprint: reviewSnapshots.fileDiffFingerprint(file), system, user, reusable: Boolean(execution), execution: execution || {
      backend: cfg.backend, endpoint: null, requestedModel: cfg._reviewBackend.requestedModel, resolvedModel: cfg._reviewBackend.resolvedModel,
      effort: cfg.reasoningEffort || '', cliConfigFingerprint: null, maxTokens: 2048, temperature: 0.2, promptVersion: 'file-v2' } });
  return { cfg, system, user, identity, coverageNotices };
}

async function analyzeFile(payload) {
  if (payload?.force !== undefined && typeof payload.force !== 'boolean') throw new Error('force 必须为布尔值');
  if (payload?.file?.excluded) throw new Error(`该文件已被排除规则「${payload.file.excludedBy || '项目排除规则'}」排除，不参与 AI 评审`);
  if (payload?.file?.resource) return { markdown: '该文件是资源文件（图片/字体/资源目录等），不参与 AI 评审。', stats: null, cacheHit: false, cacheKey: null, cachedAt: null, coverageNotices: [] };
  const { cfg, system, user, identity, coverageNotices } = await prepareFileAnalysis(payload);
  return require('./fileAnalysisCache').run(payload.folder, identity, async () => {
    const { content, stats } = await chatWithStats(cfg, [{ role: 'system', content: system }, { role: 'user', content: user }],
      { maxTokens: 2048, folder: payload.folder, kind: '逐文件分析', batch: payload.file.path, runId: payload.runId, stream: true });
    return { markdown: content, stats, coverageNotices };
  }, payload.force === true);
}

async function listFileAnalyses({ folder, snapshotId, planId, noiseLevelOverride }) {
  const files = reviewSnapshots.getSnapshotFiles(snapshotId, folder);
  if (!files) throw new Error('改动快照不存在或已过期，请重新加载改动');
  const planContext = require('./ai/planContext').storedPlanContext(folder, planId);
  const captured = { settings: await getSettings(), rules: require('./effectiveRules').discoverRules(folder) };
  const identities = [];
  for (const file of skipResources(files)) {
    const { identity } = await prepareFileAnalysis({ folder, file, snapshotId, planId, planContext, noiseLevelOverride }, captured);
    identities.push(identity);
  }
  return require('./fileAnalysisCache').list(folder, identities);
}

// 完整讲解分批循环：各批结果直接拼接（每批内容互不重叠，无需综合）；支持暂停/续跑
async function runFullBatches(cfg, state) {
  const { folder, batches, system, runId } = state;
  const lane = ensureLane(runId);
  const planPrefix = state.planContext ? `${state.planContext}\n\n` : '';
  for (let i = state.nextIndex; i < batches.length; i += 1) {
    if (lane.cancelled) throw cancelledError();
    if (lane.pauseRequested) {
      return checkpointResult(lane, state, state.parts.join('\n\n---\n\n'), i);
    }
    const label = batches.length > 1 ? `（第 ${i + 1}/${batches.length} 批）` : '';
    const user = `${planPrefix}以下是部分代码改动${label}（unified diff），请完整详细讲解：\n\n${batches[i].join('\n\n')}`;
    try {
      const { content, stats } = await chatWithStats(cfg, [
        { role: 'system', content: state.batchSystems?.[i] || system },
        { role: 'user', content: user },
      ], { maxTokens: 8192, folder, kind: '完整讲解', batch: label, batchIndex: i + 1, batchTotal: batches.length, runId, stream: true });
      state.parts.push(content);
      state.statsList.push(stats);
      state.nextIndex = i + 1;
    } catch (error) {
      return checkpointResult(lane, state, state.parts.join('\n\n---\n\n'), i, 'batch', error);
    }
  }
  let markdown = state.parts.join('\n\n---\n\n');
  if (state.reviewed < state.files.length) {
    markdown += `\n\n改动过多，仅讲解了前 ${state.reviewed} 个文件。`;
  }
  return completedResult({ markdown, stats: aggregateStats(state.statsList), paused: false }, state);
}

// 完整讲解：分批逐文件讲透
async function explainFull({ folder, files, runId = null, title = '', kind = 'full', noiseLevelOverride = undefined, customPromptOverride = '', planContext = '', ...metadata }) {
  files = structuredClone(files);
  const allFiles = files;
  files = skipResources(files);
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('没有可讲解的改动');
  }
  const cfg = freezeBackend(applyPromptOverride(await getSettings(), customPromptOverride));
  cfg.noiseLevel = effectiveNoiseLevel(noiseLevelOverride, cfg.noiseLevel);
  const rules = captureProjectRules(folder, allFiles.map((f) => f.path));
  const plan = metadata.planEnabled === false ? '' : normalizePlanContext(planContext);
  const system = withCapturedRules(withCustomPrompt(FULL_EXPLAIN_SYSTEM, cfg), rules);
  const { batches, reviewed, batchPaths, aiTruncatedPaths } = splitIntoBatches(folder, files);
  const batchSystems = batchPaths.map((paths) => withCapturedRules(withCustomPrompt(FULL_EXPLAIN_SYSTEM, cfg), rulesForPaths(rules, paths)));
  const provenance = freezeProvenance({ ...metadata, folder }, allFiles, cfg, rules, plan, [system, batches, plan]);
  runId = ensureRunId(runId);
  const state = {
    provenance, rules, snapshotId: metadata.snapshotId,
    title, historyKind: kind, reviewId: randomUUID(), parent: true, noiseLevel: effectiveNoiseLevel(noiseLevelOverride, cfg.noiseLevel),
    kind: 'full',
    folder,
    files,
    cfg,
    system,
    batchSystems,
    planContext: plan,
    parts: [],
    statsList: [],
    nextIndex: 0,
    batches,
    reviewed,
    aiTruncatedPaths,
    runId,
    pausedAt: null,
  };
  const lane = ensureLane(runId);
  lane.batchRunActive = true;
  reviewSnapshots.retainSnapshot(metadata.snapshotId, runId);
  try {
    return await runFullBatches(cfg, state);
  } finally {
    lane.batchRunActive = false;
    lane.pauseRequested = false;
    if (!lane.pausedState) reviewSnapshots.releaseSnapshot(metadata.snapshotId, runId);
    maybeCleanupLane(runId);
  }
}

async function explainChange({ folder, filePath, hunk, line, segments, runId = null, planContext = '' }) {
  const selection = captureExplainSelection({ filePath, hunk, line, segments });
  const ctx = buildIndexedExplainContext(selection);
  ctx.multi = Boolean(segments?.length);
  const rules = captureProjectRules(folder, selection.map((s) => s.path));
  const plan = normalizePlanContext(planContext);
  const prefix = plan ? `${plan}\n\n` : '';
  // 框选多行：整体解释这组改动
  if (ctx.multi) {
    const system = withCapturedRules('你是代码讲解专家，用简洁中文解释一组代码改动的整体含义、意图和潜在影响，3~5 句话，不要复述代码。', rules);
    const user = `${prefix}${ctx.context}\n\n请把这些以 > 标出的改动作为一个整体来解释。`;
    const { content, stats } = await chatWithStats(null, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { maxTokens: 768, folder, kind: '逐句解析', batch: filePath, runId, stream: true });
    const thread = require('./chatStore').create({ folder, kind: 'line', title: filePath || '逐句解析', context: {
      codeContext: ctx.context, planContext: plan, projectRulesText: rules.text, initialMarkdown: content, selection } });
    return { markdown: content, stats, threadId: thread.id, persistenceWarnings: thread.persistenceWarnings || [] };
  }
  const system = withCapturedRules('你是代码讲解专家，用简洁中文解释单行代码改动的含义、意图和潜在影响，2~4 句话，不要复述代码。', rules);
  const user = `${prefix}${ctx.context}\n\n请解释以 > 标出的那一行改动。`;
  const { content, stats } = await chatWithStats(null, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { maxTokens: 512, folder, kind: '逐句解析', batch: filePath, runId, stream: true });
  const thread = require('./chatStore').create({ folder, kind: 'line', title: filePath || '逐句解析', context: {
    codeContext: ctx.context, planContext: plan, projectRulesText: rules.text, initialMarkdown: content, selection } });
  return { markdown: content, stats, threadId: thread.id, persistenceWarnings: thread.persistenceWarnings || [] };
}

// 逐句追问：带上改动上下文与历史问答，继续回答用户的新问题
async function explainFollowUp({ folder, filePath, hunk, line, segments, previousQA, question, runId = null, planContext = '' }) {
  if (!question || !String(question).trim()) throw new Error('缺少追问问题');
  const ctx = buildExplainContext({ filePath, hunk, line, segments });
  const plan = normalizePlanContext(planContext);
  const system = withProjectRules('你是代码讲解专家，已为用户讲解过一组代码改动，请用简洁中文回答用户的追问，不要复述代码。', folder, captureExplainSelection({ filePath, hunk, line, segments }).map((s) => s.path));
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: `${plan ? `${plan}\n\n` : ''}${ctx.context}\n\n请先理解这组改动。` },
  ];
  for (const qa of Array.isArray(previousQA) ? previousQA : []) {
    if (!qa || typeof qa.question !== 'string') continue;
    messages.push({ role: 'user', content: qa.question });
    messages.push({ role: 'assistant', content: typeof qa.answer === 'string' ? qa.answer : '' });
  }
  messages.push({ role: 'user', content: String(question) });
  const { content, stats } = await chatWithStats(null, messages, {
    maxTokens: 1024, folder, kind: '追问', batch: filePath, runId, stream: true,
  });
  return { markdown: content, stats };
}

// 评审/讲解结果追问：带上本次全部改动上下文与历史问答（首条通常是初始评审/讲解），回答用户的新问题
const FOLLOWUP_CONTEXT_MAX_CHARS = 10000;

async function reviewFollowUp({ folder, files, previousQA, question, runId = null, planContext = '' }) {
  if (!question || !String(question).trim()) throw new Error('缺少追问问题');
  if (!Array.isArray(files) || files.length === 0) throw new Error('没有可参考的改动');
  files = skipResources(files);
  const plan = normalizePlanContext(planContext);
  let context = files.map((file) => fileToPromptText(folder, file)).join('\n\n');
  if (context.length > FOLLOWUP_CONTEXT_MAX_CHARS) {
    context = `${context.slice(0, FOLLOWUP_CONTEXT_MAX_CHARS)}\n（改动过多已截断）`;
  }
  const system = withProjectRules('你是资深代码评审与讲解专家，已为用户评审/讲解过一批代码改动，请用简洁中文回答用户就这批改动的追问。', folder, files.map((f) => f.path));
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: `${plan ? `${plan}\n\n` : ''}${context}\n\n这是本次改动的 diff 与相关定义，请先理解。` },
  ];
  for (const qa of Array.isArray(previousQA) ? previousQA : []) {
    if (!qa || typeof qa.question !== 'string') continue;
    messages.push({ role: 'user', content: qa.question });
    messages.push({ role: 'assistant', content: typeof qa.answer === 'string' ? qa.answer : '' });
  }
  messages.push({ role: 'user', content: String(question) });
  const { content, stats } = await chatWithStats(null, messages, {
    maxTokens: 2048, folder, kind: '追问', batch: '评审追问', runId, stream: true,
  });
  return { markdown: content, stats };
}

// 需求方案生成：API 后端走 OpenAI 兼容多模态消息（base64 data URL），
// CLI 后端（opencode/kimi/codex）在 prompt 中给出图片绝对路径，由 CLI 自行读取
/**
 * @param {{ prdText?: string, prdFileName?: string, imagePaths?: string[], extraRequirement?: string }} [payload]
 * @param {any} [settings]
 * @param {{ runId?: string | null, folder?: string | null }} [opts]
 */
async function generatePlan({ prdText, prdFileName, imagePaths = [], extraRequirement = '' } = {}, settings, { runId = null, folder = null } = {}) {
  if (!prdText || !String(prdText).trim()) throw new Error('缺少 PRD 内容');
  const cfg = settings || (await getSettings());
  const images = (Array.isArray(imagePaths) ? imagePaths : []).filter((p) => typeof p === 'string' && p);
  const extra = typeof extraRequirement === 'string' && extraRequirement.trim()
    ? `\n\n额外要求（必须遵守）：${extraRequirement.trim()}`
    : '';
  const prdSection = `需求文档（${prdFileName || 'PRD'}）全文：\n\n${prdText}`;
  const options = { maxTokens: 8192, folder, kind: '方案生成', batch: prdFileName || '', runId, stream: true };
  const system = withCapturedRules(PLAN_SYSTEM, captureProjectRules(folder));
  if (cfg.backend === 'opencode' || cfg.backend === 'kimi' || cfg.backend === 'codex') {
    const imgNote = images.length
      ? `\n\n设计稿图片（共 ${images.length} 张，请用文件读取能力逐张查看后结合设计稿输出方案）：\n${images.map((p) => `- ${p}`).join('\n')}`
      : '';
    const user = `${prdSection}${imgNote}${extra}\n\n请基于以上需求文档${images.length ? '与设计稿' : ''}输出技术方案。`;
    const { content, stats } = await chatWithStats(cfg, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], options);
    return { markdown: content, stats };
  }
  const text = `${prdSection}${extra}\n\n请基于以上需求文档${images.length ? '与设计稿图片' : ''}输出技术方案。`;
  /** @type {Array<{ type: string, text: string } | { type: string, image_url: { url: string } }>} */
  const parts = [{ type: 'text', text }];
  for (const p of images) {
    try {
      const base64 = fs.readFileSync(p).toString('base64');
      parts.push({ type: 'image_url', image_url: { url: `data:${imageMime(p)};base64,${base64}` } });
    } catch { /* 读取失败的图片跳过 */ }
  }
  const { content, stats } = await chatWithStats(cfg, [
    { role: 'system', content: system },
    { role: 'user', content: parts.length > 1 ? parts : text },
  ], options);
  return { markdown: content, stats };
}

async function testConnection(settings) {
  try {
    await chat(await resolveConnectionSettings(settings), [{ role: 'user', content: 'ping' }], { maxTokens: 5, kind: '测试连接' });
    return { ok: true, message: '连接成功' };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

module.exports = { analyzeOverview, analyzeOverviewMulti, analyzeFile, listFileAnalyses, prepareOverview, prepareFileAnalysis, freezeBackend, applyModelOverride, chatWithStats, explainFull, explainChange, explainFollowUp, reviewFollowUp, generatePlan, testConnection, listModels, getRuns, getRunPrompt, getCurrentRun, setChunkSender, onRunsChanged, cancelRun, pauseRun, resumeRun, buildOverviewSystem, getCompletionContext };

const fs = require('fs');
const { getSettings } = require('./settings');
const { readKimiConfig, readCodexConfig } = require('./cliConfig');
const {
  getRuns,
  getRunPrompt,
  getCurrentRun,
  pauseRun,
  cancelRun,
  setChunkSender,
  ensureRunId,
  ensureLane,
  resolveLane,
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
  buildExplainContext,
  withCustomPrompt,
  applyPromptOverride,
} = require('./ai/prompts');
const { normalizePlanContext, withProjectRules, imageMime } = require('./ai/planContext');

/**
 * @param {any} settings
 * @param {any} messages
 * @param {{ maxTokens?: number, temperature?: number, folder?: string | null, kind?: string, batch?: string, batchIndex?: number | null, batchTotal?: number | null, runId?: string | null, stream?: boolean }} [options]
 */
async function chatWithStats(settings, messages, { maxTokens = 1024, temperature = 0.2, folder = null, kind = 'AI 调用', batch = '', batchIndex = null, batchTotal = null, runId = null, stream = false } = {}) {
  const cfg = settings || (await getSettings());
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
  touchLane(lane);
  if (cfg.backend === 'opencode' || cfg.backend === 'kimi' || cfg.backend === 'codex') {
    // 模型与思考强度以 CLI 实际配置为准：未覆盖时读取各 CLI 的 config.toml
    let model = '默认模型';
    let effort = cfg.reasoningEffort || '';
    if (cfg.backend === 'opencode') {
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
    try {
      const content = await chatViaCli(cfg.backend, cfg, messages, folder, runId);
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
  try {
    const { content, usage, appliedEffort } = await chatViaApi(cfg, messages, { maxTokens, temperature, stream, runId });
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
  const lane = resolveLane(runId);
  const state = lane && lane.pausedState;
  if (!state) return null;
  lane.pausedState = null;
  // 多模型子跑道续跑时必须沿用该模型的配置，不能回退到当前设置
  const cfg = state.cfg || (await getSettings());
  lane.batchRunActive = true;
  try {
    if (state.kind === 'full') {
      return await runFullBatches(cfg, state);
    }
    return await runOverviewBatches(cfg, state);
  } finally {
    lane.batchRunActive = false;
    maybeCleanupLane(state.runId);
  }
}

// 拉取可用模型列表：api 走 OpenAI 兼容的 GET /models，opencode 走本机 CLI
async function listModels(settings) {
  const cfg = settings || (await getSettings());
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

// 问题清单闭环：整体分析固定追加的分节要求，渲染进程据此解析为可勾选清单；
// 有遗留问题时再追加核对节。定义在编排层（本文件），不改 prompts.js 的分节逻辑
const ISSUE_LIST_SECTION =
  '最后必须追加一节 ## 问题清单：把本次评审发现的可执行问题逐条列出，' +
  '格式严格为 `- [ ] 问题描述（一句话，含文件/位置）`，没有问题就写「无」。';
const LEGACY_CHECK_SECTION =
  '再追加一节 ## 遗留问题核对：对照当前 diff 逐条核对上次遗留问题，' +
  '每条输出 `旧问题描述 => 已修复 / 仍存在 / 部分修复（一句话说明）`。';

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
    if (lane.pauseRequested) {
      lane.pauseRequested = false;
      state.nextIndex = i;
      state.pausedAt = Date.now();
      lane.pausedState = state;
      touchLane(lane);
      return {
        markdown: `${state.batchResults.join('\n\n')}\n\n（已暂停，可在「运行详情」中继续）`,
        stats: aggregateStats(state.statsList),
        paused: true,
      };
    }
    const label = batches.length > 1 ? `（第 ${i + 1}/${batches.length} 批）` : '';
    const user = `${pendingPrefix}${planPrefix}${prevPrefix}以下是本次未提交的代码改动${label}（unified diff），请进行多角度评审：\n\n${batches[i].join('\n\n')}`;
    const { content, stats } = await chatWithStats(cfg, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { maxTokens: 4096, folder, kind: runKind, batch: label, batchIndex: i + 1, batchTotal: batches.length, runId, stream: true });
    state.batchResults.push(content);
    state.statsList.push(stats);
    state.nextIndex = i + 1;
  }
  let markdown;
  if (state.batchResults.length === 1) {
    markdown = state.batchResults[0];
  } else {
    let combined = state.batchResults
      .map((r, i) => `【第 ${i + 1} 批评审结果】\n${r}`)
      .join('\n\n');
    if (combined.length > 12000) combined = `${combined.slice(0, 12000)}\n(内容过长已截断)`;
    const synthSystem = withProjectRules(withCustomPrompt(
      '你是一位资深代码评审专家。以下是针对同一批代码改动分批评审得到的多份评审结果，' +
      `请将它们去重、合并为一份完整评审，仍${overviewSectionsText(cfg, Boolean(state.planContext))}\n` +
      (state.pendingText ? `${ISSUE_LIST_SECTION}\n${LEGACY_CHECK_SECTION}` : ISSUE_LIST_SECTION) +
      (state.prevText
        ? '\n另外已提供上次评审的结论：请在「总结与建议」之前追加一节 ## 与上次对比，' +
          '说明上次指出的问题本次是否已修复、哪些仍存在、本次改动新引入了什么问题。'
        : ''),
      cfg,
    ), state.folder);
      const { content, stats } = await chatWithStats(cfg, [
      { role: 'system', content: synthSystem },
      { role: 'user', content: `${pendingPrefix}${planPrefix}${prevPrefix}${combined}` },
    ], { maxTokens: 4096, folder, kind: runKind, batch: '（综合结果）', batchIndex: batches.length, batchTotal: batches.length, runId, stream: true });
    markdown = content;
    state.statsList.push(stats);
  }
  if (state.reviewed < state.files.length) {
    markdown += `\n\n改动过多，仅评审了前 ${state.reviewed} 个文件。`;
  }
  return { markdown, stats: aggregateStats(state.statsList), paused: false };
}

// 过滤资源文件（图片/字体/资源目录等），不参与 AI 评审
function skipResources(files) {
  return files.filter((f) => !(f && f.resource));
}

// 整体分析的公共上下文：设置覆盖、system prompt、分批、遗留问题/上次对比前缀。
// analyzeOverview 与 analyzeOverviewMulti 共用，保证单模型/多模型 prompt 完全一致
/** @param {any} opts */
async function prepareOverview({ folder, files, customPromptOverride = '', planContext = '', pendingIssues = [], customDimensionsOverride = '', previousReview = '' }) {
  let cfg = applyPromptOverride(await getSettings(), customPromptOverride);
  // 评审预设：本次生效的自定义维度覆盖（不写回设置）
  if (typeof customDimensionsOverride === 'string' && customDimensionsOverride.trim()) {
    cfg = { ...cfg, customDimensions: customDimensionsOverride };
  }
  const plan = normalizePlanContext(planContext);
  // 上次未关闭的问题：非空时要求 AI 追加「遗留问题核对」节
  const pending = (Array.isArray(pendingIssues) ? pendingIssues : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean)
    .slice(0, 50);
  const issueSuffix = pending.length
    ? `\n${ISSUE_LIST_SECTION}\n${LEGACY_CHECK_SECTION}`
    : `\n${ISSUE_LIST_SECTION}`;
  // 上次评审结论：非空时注入各批 prompt，并要求追加「与上次对比」节
  const prev = typeof previousReview === 'string' ? previousReview.trim() : '';
  const prevSuffix = prev
    ? '\n另外已提供上次评审的结论：请在「总结与建议」之前追加一节 ## 与上次对比，' +
      '说明上次指出的问题本次是否已修复、哪些仍存在、本次改动新引入了什么问题。'
    : '';
  const { batches, reviewed } = splitIntoBatches(folder, files);
  return {
    cfg,
    system: withProjectRules(withCustomPrompt(buildOverviewSystem(cfg, Boolean(plan)), cfg), folder) + issueSuffix + prevSuffix,
    issueSuffix,
    prevSuffix,
    plan,
    prevText: prev
      ? `上次评审的结论（供对比参考，不需要复述它）：\n${prev.length > 8000 ? `${prev.slice(0, 8000)}\n（过长已截断）` : prev}`
      : '',
    pendingText: pending.length
      ? `上次评审遗留的待处理问题（请在「遗留问题核对」节逐条核对当前 diff 是否已修复）：\n${pending.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
      : '',
    batches,
    reviewed,
  };
}

async function analyzeOverview({ folder, files, runId = null, customPromptOverride = '', planContext = '', pendingIssues = [], customDimensionsOverride = '', previousReview = '' }) {
  files = skipResources(files);
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('没有可分析的改动');
  }
  const ctx = await prepareOverview({ folder, files, customPromptOverride, planContext, pendingIssues, customDimensionsOverride, previousReview });
  runId = ensureRunId(runId);
  const state = {
    kind: 'overview',
    folder,
    files,
    cfg: ctx.cfg,
    system: ctx.system,
    planContext: ctx.plan,
    prevText: ctx.prevText,
    pendingText: ctx.pendingText,
    batchResults: [],
    statsList: [],
    nextIndex: 0,
    batches: ctx.batches,
    reviewed: ctx.reviewed,
    runId,
    pausedAt: null,
  };
  const lane = ensureLane(runId);
  lane.batchRunActive = true;
  try {
    return await runOverviewBatches(ctx.cfg, state);
  } finally {
    lane.batchRunActive = false;
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
async function analyzeOverviewMulti({ folder, files, models = [], synthesizer = null, runId = null, customPromptOverride = '', planContext = '', pendingIssues = [], customDimensionsOverride = '', previousReview = '' }) {
  files = skipResources(files);
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('没有可分析的改动');
  }
  const validModels = (Array.isArray(models) ? models : [])
    .filter((m) => m && MODEL_FIELD_BY_BACKEND[m.backend])
    .slice(0, 4);
  if (validModels.length < 2) throw new Error('多模型评审至少需要选择 2 个模型');
  const ctx = await prepareOverview({ folder, files, customPromptOverride, planContext, pendingIssues, customDimensionsOverride, previousReview });
  runId = ensureRunId(runId);
  // 主跑道只在汇总阶段登记（chatWithStats 内部）；模型阶段不标记 batchRunActive，
  // 避免运行详情里出现长期的「批间切换」占位卡片
  try {
    const settled = await Promise.allSettled(validModels.map(async (m, i) => {
      const cfg = applyModelOverride(ctx.cfg, m);
      const label = BACKEND_LABELS[m.backend] || m.backend;
      const subRunId = `${runId}-m${i}`;
      const lane = ensureLane(subRunId);
      lane.batchRunActive = true;
      const state = {
        kind: 'overview', folder, files, cfg,
        system: ctx.system,
        planContext: ctx.plan,
        prevText: ctx.prevText,
        pendingText: ctx.pendingText,
        batchResults: [], statsList: [], nextIndex: 0,
        batches: ctx.batches, reviewed: ctx.reviewed,
        runId: subRunId, pausedAt: null,
        runLabel: `整体分析（${label}）`,
      };
      try {
        const r = await runOverviewBatches(cfg, state);
        return { label, backend: m.backend, model: cfg[MODEL_FIELD_BY_BACKEND[m.backend]] || '', ...r };
      } finally {
        lane.batchRunActive = false;
        maybeCleanupLane(subRunId);
      }
    }));
    const perModel = [];
    const parts = [];
    settled.forEach((r, i) => {
      const label = BACKEND_LABELS[validModels[i].backend] || validModels[i].backend;
      if (r.status === 'fulfilled') {
        const v = r.value;
        perModel.push({ label, backend: v.backend, model: v.model, markdown: v.markdown, stats: v.stats });
        let md = v.markdown;
        if (md.length > 10000) md = `${md.slice(0, 10000)}\n（过长已截断）`;
        parts.push(`【${label} 的评审结果】\n${md}`);
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
    const syn = synthesizer && MODEL_FIELD_BY_BACKEND[synthesizer.backend]
      ? synthesizer
      : { backend: ctx.cfg.backend };
    const synCfg = applyModelOverride(ctx.cfg, syn);
    const synSystem = withProjectRules(withCustomPrompt(
      '你是一位资深代码评审专家。以下是对同一批代码改动由多个模型分别给出的评审结果，' +
      `请将它们去重、合并为一份完整评审，仍${overviewSectionsText(ctx.cfg, Boolean(ctx.plan))}\n` +
      `${ctx.issueSuffix}${ctx.prevSuffix}`,
      ctx.cfg,
    ), folder);
    const planPrefix = ctx.plan ? `${ctx.plan}\n\n` : '';
    const user = `${ctx.pendingText ? `${ctx.pendingText}\n\n` : ''}${planPrefix}${ctx.prevText ? `${ctx.prevText}\n\n` : ''}` +
      `以下是 ${okCount} 个模型对同一批代码改动的评审结果，请合并为一份评审：\n\n${parts.join('\n\n---\n\n')}`;
    const synMessages = [
      { role: 'system', content: synSystem },
      { role: 'user', content: user },
    ];
    const synOptions = { maxTokens: 4096, folder, kind: '多模型汇总', batch: `${okCount} 个模型`, runId, stream: true };
    // 汇总模型自身失败时，回退到第一个成功的模型后端做汇总
    let content;
    let stats;
    let fallbackNote = '';
    try {
      ({ content, stats } = await chatWithStats(synCfg, synMessages, synOptions));
    } catch (err) {
      const fallback = perModel.find((p) => p.markdown && p.backend !== syn.backend);
      if (!fallback) throw err;
      ({ content, stats } = await chatWithStats(
        applyModelOverride(ctx.cfg, { backend: fallback.backend, model: fallback.model }),
        synMessages, synOptions,
      ));
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
    const allStats = perModel.map((p) => p.stats).filter(Boolean).concat([stats]);
    return { markdown, stats: aggregateStats(allStats), perModel };
  } finally {
    maybeCleanupLane(runId);
  }
}

async function analyzeFile({ folder, file, runId = null, planContext = '' }) {
  if (!file || !file.path) throw new Error('缺少要分析的文件');
  if (file.resource) {
    return { markdown: '该文件是资源文件（图片/字体/资源目录等），不参与 AI 评审。', stats: null };
  }
  const cfg = await getSettings();
  const plan = normalizePlanContext(planContext);
  let text = fileToPromptText(folder, file);
  if (text.length > 12000) text = `${text.slice(0, 12000)}\n(diff 过长已截断)`;
  const system = withProjectRules(withCustomPrompt(
    '你是一位资深代码评审专家，请用中文、markdown 格式输出，严格使用以下二级标题分节：' +
    '## 改动概述 / ## 问题与风险 / ## 改进建议。' +
    '每节给出具体、可执行的发现，无问题的小节明确说『未发现问题』，引用具体行号。',
    cfg,
  ), folder);
  const user = `${plan ? `${plan}\n\n` : ''}以下是该文件的代码改动（unified diff），请进行评审：\n\n${text}`;
  const { content, stats } = await chatWithStats(cfg, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { maxTokens: 2048, folder, kind: '逐文件分析', batch: file.path, runId, stream: true });
  return { markdown: content, stats };
}

// 完整讲解分批循环：各批结果直接拼接（每批内容互不重叠，无需综合）；支持暂停/续跑
async function runFullBatches(cfg, state) {
  const { folder, batches, system, runId } = state;
  const lane = ensureLane(runId);
  const planPrefix = state.planContext ? `${state.planContext}\n\n` : '';
  for (let i = state.nextIndex; i < batches.length; i += 1) {
    if (lane.pauseRequested) {
      lane.pauseRequested = false;
      state.nextIndex = i;
      state.pausedAt = Date.now();
      lane.pausedState = state;
      touchLane(lane);
      return {
        markdown: `${state.parts.join('\n\n---\n\n')}\n\n（已暂停，可在「运行详情」中继续）`,
        stats: aggregateStats(state.statsList),
        paused: true,
      };
    }
    const label = batches.length > 1 ? `（第 ${i + 1}/${batches.length} 批）` : '';
    const user = `${planPrefix}以下是部分代码改动${label}（unified diff），请完整详细讲解：\n\n${batches[i].join('\n\n')}`;
    const { content, stats } = await chatWithStats(cfg, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { maxTokens: 8192, folder, kind: '完整讲解', batch: label, batchIndex: i + 1, batchTotal: batches.length, runId, stream: true });
    state.parts.push(content);
    state.statsList.push(stats);
    state.nextIndex = i + 1;
  }
  let markdown = state.parts.join('\n\n---\n\n');
  if (state.reviewed < state.files.length) {
    markdown += `\n\n改动过多，仅讲解了前 ${state.reviewed} 个文件。`;
  }
  return { markdown, stats: aggregateStats(state.statsList), paused: false };
}

// 完整讲解：分批逐文件讲透
async function explainFull({ folder, files, runId = null, customPromptOverride = '', planContext = '' }) {
  files = skipResources(files);
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('没有可讲解的改动');
  }
  const cfg = applyPromptOverride(await getSettings(), customPromptOverride);
  const { batches, reviewed } = splitIntoBatches(folder, files);
  runId = ensureRunId(runId);
  const state = {
    kind: 'full',
    folder,
    files,
    cfg,
    system: withProjectRules(withCustomPrompt(FULL_EXPLAIN_SYSTEM, cfg), folder),
    planContext: normalizePlanContext(planContext),
    parts: [],
    statsList: [],
    nextIndex: 0,
    batches,
    reviewed,
    runId,
    pausedAt: null,
  };
  const lane = ensureLane(runId);
  lane.batchRunActive = true;
  try {
    return await runFullBatches(cfg, state);
  } finally {
    lane.batchRunActive = false;
    maybeCleanupLane(runId);
  }
}

async function explainChange({ folder, filePath, hunk, line, segments, runId = null, planContext = '' }) {
  const ctx = buildExplainContext({ filePath, hunk, line, segments });
  const plan = normalizePlanContext(planContext);
  const prefix = plan ? `${plan}\n\n` : '';
  // 框选多行：整体解释这组改动
  if (ctx.multi) {
    const system = withProjectRules('你是代码讲解专家，用简洁中文解释一组代码改动的整体含义、意图和潜在影响，3~5 句话，不要复述代码。', folder);
    const user = `${prefix}${ctx.context}\n\n请把这些以 > 标出的改动作为一个整体来解释。`;
    const { content, stats } = await chatWithStats(null, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { maxTokens: 768, folder, kind: '逐句解析', batch: filePath, runId, stream: true });
    return { markdown: content, stats };
  }
  const system = withProjectRules('你是代码讲解专家，用简洁中文解释单行代码改动的含义、意图和潜在影响，2~4 句话，不要复述代码。', folder);
  const user = `${prefix}${ctx.context}\n\n请解释以 > 标出的那一行改动。`;
  const { content, stats } = await chatWithStats(null, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { maxTokens: 512, folder, kind: '逐句解析', batch: filePath, runId, stream: true });
  return { markdown: content, stats };
}

// 逐句追问：带上改动上下文与历史问答，继续回答用户的新问题
async function explainFollowUp({ folder, filePath, hunk, line, segments, previousQA, question, runId = null, planContext = '' }) {
  if (!question || !String(question).trim()) throw new Error('缺少追问问题');
  const ctx = buildExplainContext({ filePath, hunk, line, segments });
  const plan = normalizePlanContext(planContext);
  const system = withProjectRules('你是代码讲解专家，已为用户讲解过一组代码改动，请用简洁中文回答用户的追问，不要复述代码。', folder);
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
  const plan = normalizePlanContext(planContext);
  let context = files.map((file) => fileToPromptText(folder, file)).join('\n\n');
  if (context.length > FOLLOWUP_CONTEXT_MAX_CHARS) {
    context = `${context.slice(0, FOLLOWUP_CONTEXT_MAX_CHARS)}\n（改动过多已截断）`;
  }
  const system = withProjectRules('你是资深代码评审与讲解专家，已为用户评审/讲解过一批代码改动，请用简洁中文回答用户就这批改动的追问。', folder);
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
  if (cfg.backend === 'opencode' || cfg.backend === 'kimi' || cfg.backend === 'codex') {
    const imgNote = images.length
      ? `\n\n设计稿图片（共 ${images.length} 张，请用文件读取能力逐张查看后结合设计稿输出方案）：\n${images.map((p) => `- ${p}`).join('\n')}`
      : '';
    const user = `${prdSection}${imgNote}${extra}\n\n请基于以上需求文档${images.length ? '与设计稿' : ''}输出技术方案。`;
    const { content, stats } = await chatWithStats(cfg, [
      { role: 'system', content: PLAN_SYSTEM },
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
    { role: 'system', content: PLAN_SYSTEM },
    { role: 'user', content: parts.length > 1 ? parts : text },
  ], options);
  return { markdown: content, stats };
}

async function testConnection(settings) {
  try {
    await chat(settings, [{ role: 'user', content: 'ping' }], { maxTokens: 5, kind: '测试连接' });
    return { ok: true, message: '连接成功' };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

module.exports = { analyzeOverview, analyzeOverviewMulti, analyzeFile, explainFull, explainChange, explainFollowUp, reviewFollowUp, generatePlan, testConnection, listModels, getRuns, getRunPrompt, getCurrentRun, setChunkSender, cancelRun, pauseRun, resumeRun, buildOverviewSystem };

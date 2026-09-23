const fs = require('fs');
const { getSettings } = require('./settings');
const { readKimiConfig, readCodexConfig } = require('./cliConfig');
const runState = require('./ai/state');
const { getCurrentRun, pauseRun, cancelRun, setChunkSender } = require('./ai/runControl');
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
    runState.currentRun = {
      kind, batch, batchIndex, batchTotal, backend: cfg.backend, model, effort,
      command: cliCmdLabel(cfg.backend, cfg, folder),
      promptChars: promptText.length, promptText, startedAt,
    };
    try {
      const content = await chatViaCli(cfg.backend, cfg, messages, folder);
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
      runState.currentRun = null;
      runState.currentCancel = null;
    }
  }
  if (!cfg.apiKey) throw new Error('请先在「AI 设置」中配置 API Key');
  const url = `${String(cfg.baseUrl || '').replace(/\/+$/, '')}/chat/completions`;
  runState.currentRun = {
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
    runState.currentRun = null;
    runState.currentCancel = null;
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

// 从 pausedState 的 nextIndex 继续原分批循环；无暂停状态返回 null
async function resumeRun() {
  const state = runState.pausedState;
  if (!state) return null;
  runState.pausedState = null;
  const cfg = await getSettings();
  runState.batchRunActive = true;
  try {
    if (state.kind === 'full') {
      return await runFullBatches(cfg, state);
    }
    return await runOverviewBatches(cfg, state);
  } finally {
    runState.batchRunActive = false;
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
  const data = await resp.json();
  const ids = (Array.isArray(data.data) ? data.data : [])
    .map((m) => m && m.id)
    .filter((id) => typeof id === 'string' && id);
  return [...new Set(ids)].sort();
}

// 整体分析分批循环：每批开始前检查暂停请求，暂停时保存续跑状态并返回已完成部分；
// 正常跑完后多批结果再综合（续跑走到这里同样执行综合）
async function runOverviewBatches(cfg, state) {
  const { folder, batches, system, runId } = state;
  const planPrefix = state.planContext ? `${state.planContext}\n\n` : '';
  for (let i = state.nextIndex; i < batches.length; i += 1) {
    if (runState.pauseRequested) {
      runState.pauseRequested = false;
      state.nextIndex = i;
      state.pausedAt = Date.now();
      runState.pausedState = state;
      return {
        markdown: `${state.batchResults.join('\n\n')}\n\n（已暂停，可在「运行详情」中继续）`,
        stats: aggregateStats(state.statsList),
        paused: true,
      };
    }
    const label = batches.length > 1 ? `（第 ${i + 1}/${batches.length} 批）` : '';
    const user = `${planPrefix}以下是本次未提交的代码改动${label}（unified diff），请进行多角度评审：\n\n${batches[i].join('\n\n')}`;
    const { content, stats } = await chatWithStats(cfg, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { maxTokens: 4096, folder, kind: '整体分析', batch: label, batchIndex: i + 1, batchTotal: batches.length, runId, stream: true });
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
      `请将它们去重、合并为一份完整评审，仍${overviewSectionsText(cfg, Boolean(state.planContext))}`,
      cfg,
    ), state.folder);
    const { content, stats } = await chatWithStats(cfg, [
      { role: 'system', content: synthSystem },
      { role: 'user', content: `${planPrefix}${combined}` },
    ], { maxTokens: 4096, folder, kind: '整体分析', batch: '（综合结果）', batchIndex: batches.length, batchTotal: batches.length, runId, stream: true });
    markdown = content;
    state.statsList.push(stats);
  }
  if (state.reviewed < state.files.length) {
    markdown += `\n\n改动过多，仅评审了前 ${state.reviewed} 个文件。`;
  }
  return { markdown, stats: aggregateStats(state.statsList), paused: false };
}

async function analyzeOverview({ folder, files, runId = null, customPromptOverride = '', planContext = '' }) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('没有可分析的改动');
  }
  const cfg = applyPromptOverride(await getSettings(), customPromptOverride);
  const plan = normalizePlanContext(planContext);
  const { batches, reviewed } = splitIntoBatches(folder, files);
  const state = {
    kind: 'overview',
    folder,
    files,
    system: withProjectRules(withCustomPrompt(buildOverviewSystem(cfg, Boolean(plan)), cfg), folder),
    planContext: plan,
    batchResults: [],
    statsList: [],
    nextIndex: 0,
    batches,
    reviewed,
    runId,
    pausedAt: null,
  };
  runState.batchRunActive = true;
  try {
    return await runOverviewBatches(cfg, state);
  } finally {
    runState.batchRunActive = false;
  }
}

async function analyzeFile({ folder, file, runId = null, planContext = '' }) {
  if (!file || !file.path) throw new Error('缺少要分析的文件');
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
  const planPrefix = state.planContext ? `${state.planContext}\n\n` : '';
  for (let i = state.nextIndex; i < batches.length; i += 1) {
    if (runState.pauseRequested) {
      runState.pauseRequested = false;
      state.nextIndex = i;
      state.pausedAt = Date.now();
      runState.pausedState = state;
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
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('没有可讲解的改动');
  }
  const cfg = applyPromptOverride(await getSettings(), customPromptOverride);
  const { batches, reviewed } = splitIntoBatches(folder, files);
  const state = {
    kind: 'full',
    folder,
    files,
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
  runState.batchRunActive = true;
  try {
    return await runFullBatches(cfg, state);
  } finally {
    runState.batchRunActive = false;
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

module.exports = { analyzeOverview, analyzeFile, explainFull, explainChange, explainFollowUp, reviewFollowUp, generatePlan, testConnection, listModels, getCurrentRun, setChunkSender, cancelRun, pauseRun, resumeRun, buildOverviewSystem };

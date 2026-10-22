// 外部 Agent 专用组合工具：把界面里负责的编排（拉取改动、拼装评审参数、参照方案）放到主进程完成，
// 免得 Agent 搬运整份 diff
const fs = require('fs');
const git = require('../git');
const store = require('../store');
const planStore = require('../planStore');
const settingsStore = require('../settings');

// 与 renderer/lib/aiShared.js 的 loadPlanContext 保持一致
const PLAN_CONTEXT_MAX_CHARS = 6000;
const PLAN_PRD_EXCERPT_CHARS = 500;

/** @param {Record<string, any>} input */
function sourceOptions(input) {
  return {
    ...(typeof input.mode === 'string' ? { mode: input.mode } : {}),
    ...(typeof input.base === 'string' && input.base ? { base: input.base } : {}),
    ...(Array.isArray(input.commits) && input.commits.length ? { commits: input.commits } : {}),
  };
}

/** @param {string} folder */
function planContext(folder) {
  const plan = planStore.getActivePlan(folder);
  if (!plan || !plan.planMarkdown) return null;
  let markdown = String(plan.planMarkdown);
  if (markdown.length > PLAN_CONTEXT_MAX_CHARS) markdown = `${markdown.slice(0, PLAN_CONTEXT_MAX_CHARS)}\n\n（方案内容过长，已截断至 ${PLAN_CONTEXT_MAX_CHARS} 字）`;
  const prdText = String(plan.prdText || '');
  const prdExcerpt = prdText.length > PLAN_PRD_EXCERPT_CHARS ? `${prdText.slice(0, PLAN_PRD_EXCERPT_CHARS)}…（PRD 过长已截断）` : prdText;
  const title = plan.title || '未命名方案';
  let section = `## 需求方案（评审依据）\n\n方案标题：${title}\n\n${markdown}`;
  if (prdExcerpt) section += `\n\n### PRD 摘要\n\n${prdExcerpt}`;
  return { id: String(plan.id || ''), title, section };
}

/** @param {Array<{ hunks?: Array<{ lines?: Array<{ type: string }> }> }>} files */
function countLines(files) {
  let add = 0;
  let del = 0;
  for (const file of files) {
    for (const hunk of file.hunks || []) {
      for (const line of hunk.lines || []) {
        if (line.type === 'add') add++;
        else if (line.type === 'del') del++;
      }
    }
  }
  return { add, del };
}

/** @param {any[]} files */
function defaultTitle(files) {
  const d = new Date();
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  const { add, del } = countLines(files);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} · ${files.length} 文件 +${add} -${del}`;
}

const MODEL_FIELDS = /** @type {Record<string, string>} */ ({ api: 'model', opencode: 'opencodeModel', kimi: 'kimiModel', codex: 'codexModel' });

/**
 * 与界面选择预设一致：预设的后端、模型、思考强度写回设置，提示词与维度只作用于本次运行
 * @param {Record<string, any>} payload @param {Record<string, any>} input
 */
async function applyPreset(payload, input) {
  if (typeof input.presetId !== 'string' || !input.presetId) return;
  const settings = await settingsStore.getSettings();
  const preset = (Array.isArray(settings.presets) ? settings.presets : []).find((p) => p && p.id === input.presetId);
  if (!preset) throw new Error(`评审预设不存在：${input.presetId}`);
  /** @type {Record<string, string>} */
  const patch = {};
  const modelField = MODEL_FIELDS[preset.backend];
  if (modelField) {
    patch.backend = preset.backend;
    if (typeof preset.model === 'string') patch[modelField] = preset.model;
  }
  if (typeof preset.effort === 'string') patch.reasoningEffort = preset.effort;
  if (Object.keys(patch).length) await settingsStore.saveSettings(patch);
  payload.presetId = preset.id;
  payload.presetName = preset.name || preset.id;
  if (typeof preset.customPrompt === 'string' && preset.customPrompt.trim()) payload.customPromptOverride = preset.customPrompt;
  const dims = Array.isArray(preset.dimensions) ? preset.dimensions.map((d) => String(d || '').trim()).filter(Boolean) : [];
  if (dims.length) payload.customDimensionsOverride = dims.join('\n');
}

/** @param {Record<string, any>} payload @param {string} folder @param {Record<string, any>} input */
function applyPlan(payload, folder, input) {
  payload.planEnabled = input.usePlan !== false;
  if (!payload.planEnabled) return;
  const plan = planContext(folder);
  if (!plan) return;
  if (plan.id) payload.planId = plan.id;
  payload.planTitle = plan.title;
  payload.planContext = plan.section;
}

/** @param {any} finding */
function compactFinding(finding) {
  return { id: finding.id, status: finding.status, severity: finding.severity, category: finding.category, text: finding.text,
    location: finding.location ? { path: finding.location.path, startLine: finding.location.startLine ?? null, endLine: finding.location.endLine ?? null } : null };
}

/** @param {any} result @param {string} runId */
function summarizeRun(result, runId) {
  if (!result) return { runId, markdown: '', note: '运行没有返回结果' };
  if (result.paused) return { runId, paused: true, hint: '已暂停，用 ai_resume 继续' };
  return {
    runId,
    reviewId: result.reviewId || null,
    markdown: result.markdown || '',
    stats: result.stats || null,
    ...(result.failed ? { failed: result.failed, hint: '部分批次失败，可用 ai_resume 从失败处重试' } : {}),
    ...(Array.isArray(result.checklist) ? { findings: result.checklist.map(compactFinding) } : {}),
    persistenceWarnings: result.persistenceWarnings || [],
    coverageNotices: result.coverageNotices || [],
  };
}

/**
 * @param {{
 *   invoke: (channel: string, args: unknown[]) => Promise<any>,
 *   openProject: (folder: string) => Promise<void>,
 * }} deps
 */
function createComposites({ invoke, openProject }) {
  /** @param {Record<string, any>} input */
  async function loadChanges(input) {
    const changes = await git.getChanges(input.folder, sourceOptions(input));
    if (!changes.files.length) throw new Error('当前改动来源下没有改动文件');
    return changes;
  }

  return {
    /** @param {Record<string, any>} input */
    async review_start(input) {
      const { folder, runId } = input;
      const changes = await loadChanges(input);
      const kind = input.kind === 'full' ? 'full' : 'review';
      /** @type {Record<string, any>} */
      const payload = { folder, files: changes.files, runId, kind, snapshotId: changes.snapshotId,
        title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : defaultTitle(changes.files) };
      applyPlan(payload, folder, input);
      if (kind === 'full') return summarizeRun(await invoke('ai:explainFull', [payload]), runId);
      if (typeof input.noiseLevel === 'string') payload.noiseLevelOverride = input.noiseLevel;
      if (input.compareWithLast === true) {
        const latest = store.listReviews(folder).filter((e) => (!e.kind || e.kind === 'review') && e.markdown.trim())
          .reduce((best, e) => (!best || e.createdAt > best.createdAt ? e : best), null);
        if (latest) payload.previousReview = latest.markdown;
      }
      await applyPreset(payload, input);
      if (typeof input.customPrompt === 'string' && input.customPrompt.trim()) payload.customPromptOverride = input.customPrompt.trim();
      if (Array.isArray(input.models) && input.models.length) {
        if (input.models.length < 2) throw new Error('多模型评审至少需要 2 个模型');
        payload.models = input.models;
        const { backend } = await settingsStore.getSettings();
        payload.synthesizer = input.synthesizer && typeof input.synthesizer === 'object' ? input.synthesizer : { backend: backend || 'api' };
        return summarizeRun(await invoke('ai:analyzeOverviewMulti', [payload]), runId);
      }
      return summarizeRun(await invoke('ai:analyzeOverview', [payload]), runId);
    },

    /** @param {Record<string, any>} input */
    async file_analyze(input) {
      const changes = await loadChanges(input);
      const file = changes.files.find((f) => f.path === input.path);
      if (!file) throw new Error(`改动中没有这个文件：${input.path}（可先用 changes_summary 查看）`);
      /** @type {Record<string, any>} */
      const payload = { folder: input.folder, file, runId: input.runId, snapshotId: changes.snapshotId };
      if (input.force === true) payload.force = true;
      if (typeof input.noiseLevel === 'string') payload.noiseLevelOverride = input.noiseLevel;
      await applyPreset(payload, input);
      applyPlan(payload, input.folder, input);
      return invoke('ai:analyzeFile', [payload]);
    },

    /** @param {Record<string, any>} input */
    async changes_summary(input) {
      const changes = await git.getChanges(input.folder, sourceOptions(input));
      return {
        branch: changes.branch, base: changes.base, commits: changes.commits, snapshotId: changes.snapshotId,
        diffFingerprint: changes.diffFingerprint, source: changes.source, limits: changes.limits,
        files: changes.files.map((f) => {
          const { add, del } = countLines([f]);
          return { path: f.path, oldPath: f.oldPath || null, status: f.status, additions: add, deletions: del,
            resource: Boolean(f.resource), excluded: Boolean(f.excluded), truncated: Boolean(f.truncated) };
        }),
      };
    },

    /** @param {Record<string, any>} input */
    async app_openProject(input) {
      const folder = input.folder;
      if (typeof folder !== 'string' || !folder || !fs.statSync(folder, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error('folder 必须是存在的目录绝对路径');
      }
      await openProject(folder);
      return { opened: folder };
    },

    settings_getSecret: () => settingsStore.getSettings(),
  };
}

module.exports = { createComposites, summarizeRun, sourceOptions };

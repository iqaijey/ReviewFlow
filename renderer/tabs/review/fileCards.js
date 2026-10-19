import { formatRunEstimate, planReviewEnabled, loadPlanContext, countChanges } from '../../lib/aiShared.js';
import { renderMarkdown } from '../../markdown.js';
import { createStreamPreview } from '../../lib/streamPreview.js';
import { createRunStatus } from '../../lib/runStatus.js';
import { renderCoverageNotices } from '../../lib/reviewGuards.js';

export function createFileCards(context) {
  // ---------- 逐文件 ----------
  // file → 触发该文件逐文件分析（供「改动总览」的 AI 按钮跳转后调用）
  const fileAnalyzeTriggers = new Map();
  const fileCardControllers = new Map();
  let fileRehydrateSeq = 0;

  const formatCachedTime = (cachedAt) =>
    cachedAt ? new Date(cachedAt).toLocaleString() : '未知时间';

  const rehydrateFileAnalyses = async () => {
    const seq = ++fileRehydrateSeq;
    const folder = context.state.folder;
    const snapshotId = context.state.changes && context.state.changes.snapshotId;
    if (!folder || !snapshotId || typeof context.api.listFileAnalyses !== 'function') return;
    try {
      const plan = await loadPlanContext(context.api, folder);
      if (seq !== fileRehydrateSeq || context.state.folder !== folder) return;
      const listPayload = { folder, snapshotId };
      if (plan && plan.id) listPayload.planId = plan.id;
      const noiseLevelOverride = context.selectedNoiseOverride();
      if (noiseLevelOverride) listPayload.noiseLevelOverride = noiseLevelOverride;
      const list = await context.api.listFileAnalyses(listPayload);
      if (seq !== fileRehydrateSeq || context.state.folder !== folder) return;
      const byPath = new Map();
      for (const item of Array.isArray(list) ? list : []) {
        if (item && typeof item.path === 'string') {
          byPath.set(item.path, item);
        }
      }
      for (const [filePath, ctrl] of fileCardControllers.entries()) {
        ctrl.syncCache(byPath.get(filePath) || null);
      }
    } catch { context.toast('读取逐文件分析历史失败', 'error'); }
  };

  const renderFilesPanel = () => {
    const folder = context.state.folder;
    const snapshotId = context.state.changes?.snapshotId;
    context.filesPanel.textContent = '';
    fileAnalyzeTriggers.clear();
    fileCardControllers.clear();
    if (!context.state.changes || !context.state.changes.files.length) {
      context.filesPanel.appendChild(context.emptyState('请先加载项目改动',
        '点击左下角「选择项目」后，这里会列出可逐文件分析的改动'));
      return;
    }
    for (const file of context.state.changes.files) {
      if (file.resource) continue; // 资源文件不参与评审
      const { add, del } = countChanges([file]);
      const card = context.el('div', { class: 'review-file-item', dataset: { filePath: file.path } });
      const head = context.el('div', { class: 'review-file-head' });
      head.appendChild(context.el('span', { class: 'review-file-path' }, file.path));
      head.appendChild(context.el('span', { class: 'stat-add' }, `+${add}`));
      head.appendChild(context.el('span', { class: 'stat-del' }, `-${del}`));
      const fileEstimateEl = context.el('span', { class: 'file-estimate-badge', style: 'display:none' });
      head.appendChild(fileEstimateEl);
      const analyzeBtn = context.el('button', { class: 'btn', type: 'button' }, '分析');
      head.appendChild(analyzeBtn);
      card.appendChild(head);
      const resultBox = context.el('div', { class: 'review-file-result' });
      card.appendChild(resultBox);
      context.filesPanel.appendChild(card);

      let fileRunning = false;
      let hasAnalyzedResult = false;
      let fileEstimateLoaded = false;
      let fileEstimateSeq = 0;

      const ensureFileEstimate = async () => {
        if (fileEstimateLoaded || typeof context.api.estimateRun !== 'function' || !context.state.folder) return;
        fileEstimateLoaded = true;
        const seq = ++fileEstimateSeq;
        try {
          const est = await context.api.estimateRun({
            folder,
            kind: 'file',
            snapshotId: snapshotId || undefined,
            filePath: file.path,
            noiseLevelOverride: context.selectedNoiseOverride(),
            planEnabled: planReviewEnabled(),
          });
          if (seq !== fileEstimateSeq || context.state.folder !== folder) return;
          const formatted = formatRunEstimate(est);
          fileEstimateEl.textContent = formatted.text;
          fileEstimateEl.title = formatted.tooltip;
          fileEstimateEl.style.display = '';
          card.title = formatted.tooltip ? `${formatted.text}\n${formatted.tooltip}` : formatted.text;
          analyzeBtn.title = formatted.tooltip ? `${formatted.text}\n${formatted.tooltip}` : formatted.text;
        } catch {
          if (seq !== fileEstimateSeq || context.state.folder !== folder) return;
          fileEstimateEl.textContent = '无法估算';
          fileEstimateEl.title = '';
          fileEstimateEl.style.display = '';
          card.title = '无法估算';
          analyzeBtn.title = '无法估算';
        }
      };

      card.addEventListener('mouseenter', () => {
        ensureFileEstimate();
      });
      analyzeBtn.addEventListener('focus', () => {
        ensureFileEstimate();
      });

      const renderFileResult = ({ markdown, stats, cacheHit, cachedAt, reusable = true, coverageNotices = [] }) => {
        hasAnalyzedResult = true;
        analyzeBtn.textContent = '重新分析';
        resultBox.textContent = '';
        if (cacheHit || !reusable) {
          resultBox.appendChild(context.el('div', {
            class: 'file-cache-badge',
          }, reusable ? `缓存 · ${formatCachedTime(cachedAt)}` : `上次结果 · ${formatCachedTime(cachedAt)}（未作为缓存复用）`));
        }
        const coverage = context.el('div');
        renderCoverageNotices(context.el, coverage, coverageNotices);
        resultBox.appendChild(coverage);
        const mdNode = context.el('div', { class: 'md' });
        mdNode.innerHTML = renderMarkdown(markdown);
        resultBox.appendChild(mdNode);
        resultBox.appendChild(context.statsLine(stats));
      };

      const runFileAnalysis = async (force) => {
        if (fileRunning || context.state.folder !== folder) return;
        fileRunning = true;
        analyzeBtn.disabled = true;
        resultBox.textContent = '';
        const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const fileStatus = createRunStatus({
          el: context.el,
          api: context.api,
          bus: context.bus,
          runId,
          label: 'AI 分析中，请稍候…',
          compact: true,
          showDetails: () => context.ctx.showRunDetails(),
          toast: context.toast,
          errText: context.errText,
        });
        resultBox.appendChild(fileStatus.root);
        const stream = createStreamPreview({ el: context.el, api: context.api, runId, parent: resultBox });
        try {
          /** @type {Parameters<AutoReviewApi['analyzeFile']>[0]} */
          const filePayload = {
            folder,
            file,
            runId,
            planEnabled: planReviewEnabled(),
          };
          if (force) filePayload.force = true;
          if (snapshotId) {
            filePayload.snapshotId = snapshotId;
          }
          const preset = context.activePreset();
          if (preset && preset.id) {
            filePayload.presetId = preset.id;
            filePayload.presetName = preset.name || preset.id;
          }
          const noiseLevelOverride = context.selectedNoiseOverride();
          if (noiseLevelOverride) filePayload.noiseLevelOverride = noiseLevelOverride;
          const plan = await loadPlanContext(context.api, folder);
          if (plan) {
            if (plan.id) filePayload.planId = plan.id;
            filePayload.planTitle = plan.title;
            filePayload.planContext = plan.section;
          }
          const res = await context.api.analyzeFile(filePayload);
          if (context.state.folder !== folder || !context.filesPanel.contains(card)) return;
          renderFileResult(res);
          for (const warning of res.persistenceWarnings || []) context.toast(warning, 'error');
        } catch (err) {
          if (context.state.folder !== folder || !context.filesPanel.contains(card)) return;
          resultBox.textContent = '';
          if (context.errText(err).includes('已被用户终止')) {
            resultBox.appendChild(context.el('div', { class: 'run-terminal' }, '已终止，可点击「分析」重新开始'));
          } else {
            const box = context.el('div', { class: 'review-error' });
            box.appendChild(context.el('div', { class: 'error-text' }, `分析失败：${context.errText(err)}`));
            const retry = context.el('button', { class: 'btn', type: 'button' }, '重试');
            retry.addEventListener('click', () => runFileAnalysis(force));
            box.appendChild(retry);
            resultBox.appendChild(box);
          }
        } finally {
          fileStatus.dispose();
          fileStatus.root.remove();
          if (stream.unsubscribe) stream.unsubscribe();
          stream.streamBox.remove();
          fileRunning = false;
          analyzeBtn.disabled = false;
        }
      };

      fileCardControllers.set(file.path, {
        syncCache: (cached) => {
          if (fileRunning) return;
          if (cached) {
            renderFileResult(cached);
          } else {
            hasAnalyzedResult = false;
            analyzeBtn.textContent = '分析';
            resultBox.textContent = '';
          }
        },
        invalidateEstimate: () => {
          fileEstimateSeq++;
          fileEstimateLoaded = false;
          fileEstimateEl.style.display = 'none';
          fileEstimateEl.textContent = '';
          card.title = '';
          analyzeBtn.title = '';
        },
      });

      fileAnalyzeTriggers.set(file, () => {
        card.scrollIntoView({ block: 'start' });
        runFileAnalysis(false);
      });
      analyzeBtn.addEventListener('click', () => {
        runFileAnalysis(hasAnalyzedResult);
      });
    }
    rehydrateFileAnalyses();
  };

  return {
  get rehydrateFileAnalyses() { return rehydrateFileAnalyses; },
  get fileCardControllers() { return fileCardControllers; },
  get renderFilesPanel() { return renderFilesPanel; },
  get fileAnalyzeTriggers() { return fileAnalyzeTriggers; },
  };
}

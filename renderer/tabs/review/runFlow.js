import { planReviewEnabled, loadPlanContext, exportReview } from '../../lib/aiShared.js';
import { renderMarkdown } from '../../markdown.js';
import { createStreamPreview } from '../../lib/streamPreview.js';
import { newestOverallReview, renderCoverageNotices } from '../../lib/reviewGuards.js';

export function createRunFlow(context) {
  let projectEpoch = 0;
  let cleanupStream = () => {};
  context.bus.addEventListener('project:changed', () => {
    projectEpoch++;
    cleanupStream();
    context.pendingRun = null;
    context.currentResult = null;
    context.disposeChats();
    context.mdBox.textContent = '';
    context.coverageBox.textContent = '';
    context.setStatus(null);
    finishAttempt();
    context.startBtn.disabled = true;
    context.estimateBadge.style.display = 'none';
  });
  const showError = (message) => {
    const box = context.el('div', { class: 'review-error' });
    box.appendChild(context.el('div', { class: 'error-text' }, `分析失败：${message}`));
    const retry = context.el('button', { class: 'btn', type: 'button' }, '重试');
    retry.addEventListener('click', () => context.pendingRun ? resumePending() : runAnalysis());
    box.appendChild(retry);
    if (context.pendingRun) {
      context.setStatus(box);
      return;
    }
    // 一次性自定义要求重跑：仅本次生效，不写回设置
    const rerunForm = context.el('div', { class: 'explain-follow-form review-rerun-form' });
    const promptInput = context.el('input', {
      class: 'settings-input', type: 'text',
      placeholder: '临时自定义要求，可留空', spellcheck: 'false',
    });
    promptInput.value = (context.activePreset() && context.activePreset().customPrompt) || context.cachedCustomPrompt;
    const rerunBtn = context.el('button', { class: 'btn', type: 'button' }, '按此重跑');
    rerunBtn.addEventListener('click', () => runAnalysis(promptInput.value));
    promptInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') runAnalysis(promptInput.value);
    });
    rerunForm.appendChild(promptInput);
    rerunForm.appendChild(rerunBtn);
    box.appendChild(rerunForm);
    context.setStatus(box);
  };

  const finishAttempt = () => {
    context.disposeRunStatus();
    context.dialogResuming = false;
    activeCancel = null;
    context.running = false;
    context.startBtn.textContent = '开始 AI 分析';
    context.startBtn.classList.remove('btn-danger');
    context.startBtn.disabled = !!context.pendingRun || !context.state.changes?.files.length;
  };

  const handleRunError = (err) => {
    if (context.errText(err).includes('已被用户终止')) {
      context.pendingRun = null;
      context.mdBox.textContent = '';
      context.setStatus(context.el('div', { class: 'empty-hint' }, '已终止，可点击「开始 AI 分析」重新开始'));
    } else {
      showError(context.errText(err));
      context.notify('AI 分析失败', context.errText(err));
    }
  };

  const beginResume = (runId) => {
    context.running = true;
    activeCancel = () => {
      context.api.cancelRun(runId).catch((err) => context.toast('终止失败：' + context.errText(err), 'error'));
    };
    context.setStatus(context.mountRunStatus(runId, activeCancel));
    context.startBtn.disabled = false;
    context.startBtn.textContent = '终止运行';
    context.startBtn.classList.add('btn-danger');
  };

  const resumePending = async () => {
    if (context.running || !context.pendingRun) return;
    const { runId } = context.pendingRun;
    const origin = context.pendingRun;
    const epoch = projectEpoch;
    try {
      beginResume(runId);
      const result = await context.api.resumeRun(runId);
      await handleResult(result, origin);
    } catch (err) {
      if (context.pendingRun?.runId === runId) handleRunError(err);
    } finally {
      if (epoch === projectEpoch) finishAttempt();
    }
  };

  const handleResult = async (result, origin = context.pendingRun) => {
    if (!origin) return;
    if (origin.folder !== context.state.folder || context.pendingRun !== origin) {
      if (result && !result.paused && !result.failed) context.toast(`「${origin.folder.split(/[\\/]/).pop()}」的评审已完成，已保存到其历史`);
      return;
    }
    if (!result || typeof result !== 'object') {
      context.pendingRun = null;
      context.mdBox.textContent = '';
      context.setStatus(context.el('div', { class: 'empty-hint' },
        '该运行的检查点已不存在（可能已在别处继续或已结束），请重新开始分析'));
      return;
    }
    const { markdown, stats, perModel, paused, failed } = result;
    context.setStatus(null);
    context.disposeChats();
    context.mdBox.innerHTML = renderMarkdown(markdown);
    if (failed || paused) {
      const box = context.el('div', { class: 'review-error' });
      if (failed) {
        const stage = failed.stage === 'synthesis' ? '综合阶段失败'
          : `第 ${failed.batchIndex}/${failed.batchTotal} 批失败`;
        box.appendChild(context.el('div', { class: 'error-text' }, `${stage}：${failed.message}`));
        box.appendChild(context.el('div', { class: 'empty-hint' }, '已完成的批次已保留，可从失败处继续。'));
        const retry = context.el('button', { class: 'btn', type: 'button' }, '从失败处重试');
        retry.addEventListener('click', resumePending);
        box.appendChild(retry);
      } else {
        box.appendChild(context.el('div', { class: 'empty-hint' }, '已暂停，可在「运行详情」中继续'));
        box.appendChild(context.el('div', { class: 'empty-hint' }, '暂停的进度只保存在本次运行中，退出应用后将无法继续'));
        const resume = context.el('button', { class: 'btn', type: 'button' }, '继续');
        resume.addEventListener('click', resumePending);
        box.appendChild(resume);
      }
      const abandon = context.el('button', { class: 'btn', type: 'button' }, '放弃');
      abandon.addEventListener('click', async () => {
        abandon.disabled = true;
        try {
          await context.api.cancelRun(origin.runId);
          if (context.pendingRun !== origin) return;
          context.pendingRun = null;
          context.mdBox.textContent = '';
          context.setStatus(null);
          finishAttempt();
          context.refresh();
        } catch (err) {
          context.toast('放弃失败：' + context.errText(err), 'error');
          abandon.disabled = false;
        }
      });
      box.appendChild(abandon);
      context.setStatus(box);
      return;
    }
    // 最终成功后先解除关联，重复事件不会再次保存历史。
    context.pendingRun = null;
    if (Array.isArray(perModel) && perModel.length) {
      const det = context.el('details', { class: 'multi-raw' });
      det.appendChild(context.el('summary', {}, `各模型原始结果（${perModel.length}）`));
      for (const pm of perModel) {
        det.appendChild(context.el('h3', {}, pm.label + (pm.model ? ` · ${pm.model}` : '')));
        if (pm.markdown) {
          const node = context.el('div', { class: 'md' });
          node.innerHTML = renderMarkdown(pm.markdown);
          det.appendChild(node);
        } else {
          det.appendChild(context.el('div', { class: 'error-text' }, `失败：${pm.error || '未知错误'}`));
        }
      }
      context.mdBox.appendChild(det);
    }
    context.sectionFeedback = {};
    const entryTitle = (result.historyEntry && result.historyEntry.title) || origin.title;
    const reviewId = result.reviewId || (result.historyEntry && result.historyEntry.id) || '';
    renderCoverageNotices(context.el, context.coverageBox, result.coverageNotices || result.historyEntry?.coverageNotices);
    const completed = { title: entryTitle, markdown, stats, id: reviewId, folder: origin.folder };
    context.currentResult = completed;
    context.injectSectionTools(origin.folder, reviewId);
    context.mdBox.appendChild(context.statsLine(stats));
    context.mdBox.appendChild(context.exportGroup(markdown));
    const followUp = context.buildFollowUp(origin.folder, reviewId);
    if (followUp) context.mdBox.appendChild(followUp);
    if (Array.isArray(result.persistenceWarnings)) {
      for (const warning of result.persistenceWarnings) {
        context.toast(warning, 'error');
      }
    }
    if (Array.isArray(result.checklist)) {
      await context.findingsView.setFindings(result.checklist, origin.folder);
    }
    await context.findingsView.reloadFromStore(origin.folder);
    if (origin.folder !== context.state.folder) return;
    if (result.historyEntry) {
      context.historyView.upsertEntry(result.historyEntry, origin.folder);
    } else if (context.historyPanel.style.display !== 'none') {
      context.historyView.load();
    }
    context.notify('AI 分析完成', '多角度 Review 已生成');
  };

  context.bus.addEventListener('runs:changed', (event) => {
    // 恢复结果可能晚于跑道清理通知，必须等对应 promise/事件。
    if (!context.pendingRun || context.running || context.dialogResuming) return;
    const { runId } = context.pendingRun;
    if (event.detail.some((run) => run.runId === runId)) return;
    context.pendingRun = null;
    context.mdBox.textContent = '';
    context.setStatus(context.el('div', { class: 'empty-hint' }, '已终止，可点击「开始 AI 分析」重新开始'));
    finishAttempt();
  });

  context.bus.addEventListener('run:resuming', (event) => {
    const { runId } = event.detail;
    if (context.pendingRun?.runId !== runId || context.running) return;
    context.dialogResuming = true;
    beginResume(runId);
  });
  context.bus.addEventListener('run:resumed', async (event) => {
    const { runId, result } = event.detail;
    if (context.pendingRun?.runId !== runId || !context.dialogResuming) return;
    const epoch = projectEpoch;
    try {
      await handleResult(result);
    } catch (err) {
      if (epoch === projectEpoch) handleRunError(err);
    } finally {
      if (epoch === projectEpoch) finishAttempt();
    }
  });
  context.bus.addEventListener('run:resumeFailed', (event) => {
    if (context.pendingRun?.runId !== event.detail.runId || !context.dialogResuming) return;
    handleRunError(event.detail.error);
    finishAttempt();
  });

  const runAnalysis = async (overridePrompt) => {
    if (context.running || context.pendingRun || !context.state.changes || !context.state.changes.files.length) return;
    const multiModels = context.multiOn
      ? [...context.multiBoxes].filter(([, b]) => b.checked).map(([v]) => v)
      : [];
    if (context.multiOn && multiModels.length < 2) {
      context.toast('多模型评审请至少选择 2 个模型', 'error');
      return;
    }
    const override = typeof overridePrompt === 'string' ? overridePrompt.trim() : '';
    const epoch = projectEpoch;
    const folder = context.state.folder;
    const changes = context.state.changes;
    context.running = true;
    context.disposeChats();
    context.mdBox.textContent = '';
    context.coverageBox.textContent = '';
    context.sectionFeedback = {};
    context.currentResult = null;
    const skippedResources = context.state.changes.files.filter((f) => f.resource).length;
    if (skippedResources > 0) {
      context.toast(`已跳过 ${skippedResources} 个资源文件（图片/资源目录等不参与评审）`);
    }
    const runId = `run-${Date.now()}`;
    const runTitle = context.autoTitle();
    const origin = { runId, folder, title: runTitle };
    context.pendingRun = origin;
    const stream = createStreamPreview({ el: context.el, api: context.api, runId, parent: context.mdBox });
    cleanupStream = () => { stream.unsubscribe?.(); stream.streamBox.remove(); };
    activeCancel = () => {
      if (typeof context.api.cancelRun !== 'function') return;
      context.api.cancelRun(runId).catch((err) => context.toast('终止失败：' + context.errText(err), 'error'));
    };
    context.setStatus(context.mountRunStatus(runId, activeCancel));
    context.startBtn.textContent = '终止运行';
    context.startBtn.classList.add('btn-danger');
    try {
      /** @type {MultiReviewRunPayload} */
      const payload = {
        folder,
        files: changes.files,
        runId,
        title: runTitle,
        kind: 'review',
        planEnabled: planReviewEnabled(),
      };
      if (changes.snapshotId) {
        payload.snapshotId = changes.snapshotId;
      }
      const noiseLevelOverride = context.selectedNoiseOverride();
      if (noiseLevelOverride) payload.noiseLevelOverride = noiseLevelOverride;
      if (context.prevSwitch.checked && typeof context.api.listReviews === 'function') {
        try {
          const history = await context.api.listReviews(folder);
          const latest = newestOverallReview(Array.isArray(history) ? history : []);
          if (latest && typeof latest.markdown === 'string' && latest.markdown.trim()) {
            payload.previousReview = latest.markdown;
          }
        } catch { context.toast('读取上次评审失败，本次将不进行对比', 'error'); }
      }
      const preset = context.activePreset();
      if (preset && preset.id) {
        payload.presetId = preset.id;
        payload.presetName = preset.name || preset.id;
      }
      if (override) payload.customPromptOverride = override;
      else if (preset && typeof preset.customPrompt === 'string' && preset.customPrompt.trim()) {
        payload.customPromptOverride = preset.customPrompt;
      }
      if (preset && Array.isArray(preset.dimensions)) {
        const dims = preset.dimensions.map((d) => String(d || '').trim()).filter(Boolean);
        if (dims.length) payload.customDimensionsOverride = dims.join('\n');
      }
      const plan = await loadPlanContext(context.api, folder);
      if (plan) {
        if (plan.id) payload.planId = plan.id;
        payload.planTitle = plan.title;
        payload.planContext = plan.section;
      }
      if (multiModels.length) {
        payload.models = multiModels.map((b) => ({ backend: /** @type {ReviewModelResult['backend']} */ (b) }));
        payload.synthesizer = { backend: /** @type {ReviewModelResult['backend']} */ (context.synSelect.value) };
      }
      const result = multiModels.length
        ? await context.api.analyzeOverviewMulti(payload)
        : await context.api.analyzeOverview(payload);
      await handleResult(result, origin);
    } catch (err) {
      if (epoch !== projectEpoch) return;
      context.pendingRun = null;
      handleRunError(err);
    } finally {
      if (stream.unsubscribe) stream.unsubscribe();
      stream.streamBox.remove();
      if (epoch === projectEpoch) finishAttempt();
    }
  };

  /** @type {(() => void) | null} */
  let activeCancel = null;
  context.startBtn.addEventListener('click', () => {
    if (context.running && activeCancel) {
      activeCancel();
      return;
    }
    runAnalysis();
  });

  document.addEventListener('keydown', (ev) => {
    if (context.container.hidden) return;
    const target = /** @type {HTMLElement | null} */ (ev.target);
    if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) return;
    if (!ev.metaKey || ev.key !== 'Enter' || ev.shiftKey || ev.altKey || ev.ctrlKey) return;
    if (context.running && activeCancel) {
      ev.preventDefault();
      activeCancel();
      return;
    }
    if (context.running || context.startBtn.disabled) return;
    ev.preventDefault();
    context.startBtn.click();
  });

  context.bus.addEventListener('review:command', async (ev) => {
    const detail = /** @type {CustomEvent} */ (ev).detail || {};
    const action = detail.action;
    if (action === 'start') {
      context.switchMode('overall');
      if (!context.running && !context.startBtn.disabled) runAnalysis();
    } else if (action === 'stop') {
      if (context.running && activeCancel) activeCancel();
    } else if (action === 'toggle') {
      if (context.running && activeCancel) {
        activeCancel();
      } else {
        context.switchMode('overall');
        if (!context.running && !context.startBtn.disabled) runAnalysis();
      }
    } else if (action === 'export') {
      if (!context.currentResult || !context.currentResult.markdown) {
        context.toast('当前没有可导出的评审结果', 'info');
        return;
      }
      await exportReview(context.api, context.toast, context.errText, () => ({
          defaultName: context.defaultExportName('md'),
          content: context.currentResult.markdown,
          ext: 'md',
        }));
    } else if (action === 'history') {
      context.switchMode('history');
    } else if (action === 'nextFinding' || action === 'prevFinding') {
      context.switchMode('overall');
      context.bus.dispatchEvent(new CustomEvent('findings:jump', {
        detail: { direction: action === 'prevFinding' ? 'prev' : 'next' },
      }));
    }
  });

}

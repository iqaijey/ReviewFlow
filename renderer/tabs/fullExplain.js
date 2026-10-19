import { formatStats, formatRunEstimate, planReviewEnabled, loadPlanContext, changesTitle, defaultExportName as makeExportName, copyMarkdown, exportReview } from '../lib/aiShared.js';
import { setStatusBox } from '../lib/statusBox.js';
// 完整讲解：把当前改动按文件逐块讲透（流式预览 + 运行详情 + 终止）
import { renderMarkdown, renderMarkdownPage } from '../markdown.js';
import { createStreamPreview } from '../lib/streamPreview.js';
import { createRunStatus } from '../lib/runStatus.js';
import { createHistoryView } from '../lib/historyView.js';
import { createChatView } from '../lib/chatView.js';
import { renderCoverageNotices } from '../lib/reviewGuards.js';

export default {
  id: 'fullExplain',
  title: '完整讲解',

  mount(container, ctx) {
    const { el, bus, state, api, errText, notify, toast, emptyState } = ctx;

    const toolbar = el('div', { class: 'review-toolbar' });
    const hint = el('span', { class: 'stat-item' },
      '把当前全部改动按文件逐块讲透，内容较长、耗时较久');
    const estimateBadge = el('span', {
      class: 'run-estimate-badge',
      style: 'display:none',
    });
    const startBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '开始完整讲解');
    const historyBtn = el('button', { class: 'btn', type: 'button' }, '历史');
    const runLink = el('button', {
      class: 'run-link', type: 'button', title: '查看当前运行 / 暂停与继续',
      onClick: () => ctx.showRunDetails(),
    }, '运行详情');
    toolbar.appendChild(hint);
    toolbar.appendChild(estimateBadge);
    toolbar.appendChild(startBtn);
    toolbar.appendChild(historyBtn);
    toolbar.appendChild(runLink);
    container.appendChild(toolbar);

    const historyPanel = el('div', { style: 'display:none' });
    container.appendChild(historyPanel);

    const statusBox = el('div', { class: 'review-status' });
    const mdBox = el('div', { class: 'md review-result' });
    const coverageBox = el('div');
    container.appendChild(statusBox);
    container.appendChild(coverageBox);
    container.appendChild(mdBox);

    // 与多角度 Review 相同的时间 + 文件数格式
    const autoTitle = () => changesTitle(state.changes ? state.changes.files : []);

    const defaultExportName = () => makeExportName('fullexplain', 'html');

    const copyBtn = (markdown) => {
      const btn = el('button', { class: 'btn', type: 'button' }, '复制');
      btn.addEventListener('click', () => {
        copyMarkdown(markdown, toast);
      });
      return btn;
    };

    const exportHtmlBtn = (markdown) => {
      const btn = el('button', { class: 'btn', type: 'button' }, '导出 HTML');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          await exportReview(api, toast, errText, () => ({
            defaultName: defaultExportName(),
            content: renderMarkdownPage(`完整讲解 · ${autoTitle()}`, markdown),
            ext: 'html',
          }));
        } finally {
          btn.disabled = false;
        }
      });
      return btn;
    };

    /** @type {ReturnType<typeof createChatView> | null} */
    let activeChat = null;
    const disposeChat = () => { activeChat?.dispose(); activeChat = null; };
    const buildFollowUp = (folder, reviewId) => {
      disposeChat();
      if (!reviewId || typeof api.createChatThread !== 'function') return null;
      const chat = createChatView({
        el,
        api,
        bus,
        getFolder: () => state.folder,
        originFolder: folder,
        ensureThread: () => api.createChatThread({ folder, reviewId }),
        placeholder: '就这次讲解继续提问（⌘Enter 发送）…',
        label: '就本次讲解继续追问',
        toast,
        errText,
      });
      activeChat = chat;
      return chat.root;
    };

    const historyView = createHistoryView({
      container: historyPanel,
      el,
      api,
      bus,
      getFolder: () => state.folder,
      kind: 'full',
      emptyState,
      selectFolder: () => ctx.selectFolder(),
      toast,
      errText,
    });

    historyBtn.addEventListener('click', () => {
      const opening = historyPanel.style.display === 'none';
      historyPanel.style.display = opening ? '' : 'none';
      if (opening) {
        historyView.load();
      }
    });

    const setStatus = (node, fill) => setStatusBox(statusBox, node, fill);

    /** @type {{ dispose: () => void, root: HTMLElement } | null} */
    let activeRunStatus = null;
    const disposeRunStatus = () => {
      if (activeRunStatus) {
        activeRunStatus.dispose();
        activeRunStatus = null;
      }
    };
    const mountRunStatus = (runId, onCancel) => {
      disposeRunStatus();
      activeRunStatus = createRunStatus({
        el,
        api,
        bus,
        runId,
        label: 'AI 讲解中，请稍候…',
        showDetails: () => ctx.showRunDetails(),
        onCancel,
        toast,
        errText,
      });
      return activeRunStatus.root;
    };

    let running = false;
    /** @type {{ runId: string, folder: string, title: string } | null} */
    let pendingRun = null;
    let dialogResuming = false;
    let projectEpoch = 0;
    let cleanupStream = () => {};
    bus.addEventListener('project:changed', () => {
      projectEpoch++;
      cleanupStream();
      disposeChat();
      pendingRun = null;
      mdBox.textContent = '';
      coverageBox.textContent = '';
      historyPanel.textContent = '';
      setStatus(null);
      finishAttempt();
      startBtn.disabled = true;
      estimateSeq++;
      if (estimateTimer) clearTimeout(estimateTimer);
      estimateBadge.style.display = 'none';
    });

    const refresh = () => {
      if (pendingRun) return;
      if (!state.changes || !state.changes.files.length) {
        startBtn.disabled = true;
        estimateBadge.style.display = 'none';
        if (!mdBox.firstChild) {
          setStatus(emptyState('暂无可讲解的改动',
            '点击左下角「选择项目」选择项目文件夹，并确保存在改动'), true);
        }
        return;
      }
      startBtn.disabled = running || !!pendingRun;
      if (!running && !mdBox.firstChild) {
        setStatus(emptyState('准备就绪', '点击「开始完整讲解」逐块讲透当前改动'), true);
      }
    };

    /** @type {ReturnType<typeof setTimeout> | null} */
    let estimateTimer = null;
    let estimateSeq = 0;

    const runEstimateRefresh = async () => {
      const seq = ++estimateSeq;
      const folder = state.folder;
      const changes = state.changes;
      if (!folder || !changes || !Array.isArray(changes.files) || !changes.files.length || typeof api.estimateRun !== 'function') {
        estimateBadge.style.display = 'none';
        return;
      }
      try {
        const est = await api.estimateRun({
          folder,
          kind: 'full',
          snapshotId: changes.snapshotId || undefined,
          planEnabled: planReviewEnabled(),
        });
        if (seq !== estimateSeq || state.folder !== folder) return;
        const formatted = formatRunEstimate(est);
        estimateBadge.textContent = formatted.text;
        estimateBadge.title = formatted.tooltip;
        estimateBadge.style.display = '';
      } catch {
        if (seq !== estimateSeq || state.folder !== folder) return;
        estimateBadge.textContent = '无法估算';
        estimateBadge.title = '';
        estimateBadge.style.display = '';
      }
    };

    const scheduleEstimateRefresh = () => {
      if (estimateTimer) clearTimeout(estimateTimer);
      if (!state.folder || !state.changes || !state.changes.files.length) {
        estimateBadge.style.display = 'none';
        return;
      }
      estimateTimer = setTimeout(() => {
        estimateTimer = null;
        runEstimateRefresh();
      }, 400);
    };

    bus.addEventListener('settings:saved', () => {
      scheduleEstimateRefresh();
    });

    bus.addEventListener('plan:changed', () => {
      scheduleEstimateRefresh();
    });

    const finishAttempt = () => {
      disposeRunStatus();
      dialogResuming = false;
      activeCancel = null;
      running = false;
      startBtn.textContent = '开始完整讲解';
      startBtn.classList.remove('btn-danger');
      startBtn.disabled = !!pendingRun || !state.changes?.files.length;
    };

    const handleRunError = (err) => {
      if (errText(err).includes('已被用户终止')) {
        pendingRun = null;
        mdBox.textContent = '';
        setStatus(el('div', { class: 'empty-hint' }, '已终止，可点击「开始完整讲解」重新开始'));
      } else {
        const box = el('div', { class: 'review-error' });
        box.appendChild(el('div', { class: 'error-text' }, `讲解失败：${errText(err)}`));
        const retry = el('button', { class: 'btn', type: 'button' }, pendingRun ? '从失败处重试' : '重试');
        retry.addEventListener('click', () => (pendingRun ? resumePending() : run()));
        box.appendChild(retry);
        setStatus(box);
        notify('完整讲解失败', errText(err));
      }
    };

    const beginResume = (runId) => {
      running = true;
      activeCancel = () => {
        api.cancelRun(runId).catch((err) => toast('终止失败：' + errText(err), 'error'));
      };
      setStatus(mountRunStatus(runId, activeCancel));
      startBtn.disabled = false;
      startBtn.textContent = '终止运行';
      startBtn.classList.add('btn-danger');
    };

    const resumePending = async () => {
      if (running || !pendingRun) return;
      const { runId } = pendingRun;
      const origin = pendingRun;
      const epoch = projectEpoch;
      try {
        beginResume(runId);
        const result = await api.resumeRun(runId);
        await handleResult(result, origin);
      } catch (err) {
        if (pendingRun?.runId === runId) handleRunError(err);
      } finally {
        if (epoch === projectEpoch) finishAttempt();
      }
    };

    const handleResult = async (result, origin = pendingRun) => {
      if (!origin) return;
      if (origin.folder !== state.folder || pendingRun !== origin) {
        if (result && !result.paused && !result.failed) toast(`「${origin.folder.split(/[\\/]/).pop()}」的讲解已完成，已保存到其历史`);
        return;
      }
      if (!result || typeof result !== 'object') {
        pendingRun = null;
        mdBox.textContent = '';
        setStatus(el('div', { class: 'empty-hint' },
          '该运行的检查点已不存在（可能已在别处继续或已结束），请重新开始分析'));
        return;
      }
      const { markdown, stats, paused, failed } = result;
      setStatus(null);
      disposeChat();
      mdBox.innerHTML = renderMarkdown(markdown);
      if (failed || paused) {
        const box = el('div', { class: 'review-error' });
        if (failed) {
          const stage = failed.stage === 'synthesis' ? '综合阶段失败'
            : `第 ${failed.batchIndex}/${failed.batchTotal} 批失败`;
          box.appendChild(el('div', { class: 'error-text' }, `${stage}：${failed.message}`));
          box.appendChild(el('div', { class: 'empty-hint' }, '已完成的批次已保留，可从失败处继续。'));
          const retry = el('button', { class: 'btn', type: 'button' }, '从失败处重试');
          retry.addEventListener('click', resumePending);
          box.appendChild(retry);
        } else {
          box.appendChild(el('div', { class: 'empty-hint' }, '已暂停，可在「运行详情」中继续'));
          box.appendChild(el('div', { class: 'empty-hint' }, '暂停的进度只保存在本次运行中，退出应用后将无法继续'));
          const resume = el('button', { class: 'btn', type: 'button' }, '继续');
          resume.addEventListener('click', resumePending);
          box.appendChild(resume);
        }
        const abandon = el('button', { class: 'btn', type: 'button' }, '放弃');
        abandon.addEventListener('click', async () => {
          abandon.disabled = true;
          try {
            await api.cancelRun(origin.runId);
            if (pendingRun !== origin) return;
            pendingRun = null;
            mdBox.textContent = '';
            setStatus(null);
            finishAttempt();
            refresh();
          } catch (err) {
            toast('放弃失败：' + errText(err), 'error');
            abandon.disabled = false;
          }
        });
        box.appendChild(abandon);
        setStatus(box);
        return;
      }
      pendingRun = null;
      renderCoverageNotices(el, coverageBox, result.coverageNotices || result.historyEntry?.coverageNotices);
      const reviewId = result.reviewId || (result.historyEntry && result.historyEntry.id) || '';
      mdBox.appendChild(el('div', { class: 'ai-stats' }, formatStats(stats)));
      const btnGroup = el('div', { class: 'export-group' });
      btnGroup.appendChild(copyBtn(markdown));
      btnGroup.appendChild(exportHtmlBtn(markdown));
      mdBox.appendChild(btnGroup);
      const followUp = buildFollowUp(origin.folder, reviewId);
      if (followUp) mdBox.appendChild(followUp);
      if (Array.isArray(result.persistenceWarnings)) {
        for (const warning of result.persistenceWarnings) {
          toast(warning, 'error');
        }
      }
      if (result.historyEntry) {
        historyView.upsertEntry(result.historyEntry, origin.folder);
      } else if (historyPanel.style.display !== 'none') {
        historyView.load();
      }
      notify('完整讲解完成', '当前改动已讲解完毕');
    };

    bus.addEventListener('runs:changed', (event) => {
      // 恢复结果可能晚于跑道清理通知，必须等对应 promise/事件。
      if (!pendingRun || running || dialogResuming) return;
      const { runId } = pendingRun;
      if (event.detail.some((run) => run.runId === runId)) return;
      pendingRun = null;
      mdBox.textContent = '';
      setStatus(el('div', { class: 'empty-hint' }, '已终止，可点击「开始完整讲解」重新开始'));
      finishAttempt();
    });

    bus.addEventListener('run:resuming', (event) => {
      const { runId } = event.detail;
      if (pendingRun?.runId !== runId || running) return;
      dialogResuming = true;
      beginResume(runId);
    });
    bus.addEventListener('run:resumed', async (event) => {
      const { runId, result } = event.detail;
      if (pendingRun?.runId !== runId || !dialogResuming) return;
      const epoch = projectEpoch;
      try {
        await handleResult(result);
      } catch (err) {
        if (epoch === projectEpoch) handleRunError(err);
      } finally {
        if (epoch === projectEpoch) finishAttempt();
      }
    });
    bus.addEventListener('run:resumeFailed', (event) => {
      if (pendingRun?.runId !== event.detail.runId || !dialogResuming) return;
      handleRunError(event.detail.error);
      finishAttempt();
    });

    const run = async () => {
      if (running || pendingRun || !state.changes || !state.changes.files.length) return;
      running = true;
      const epoch = projectEpoch;
      const folder = state.folder;
      const changes = state.changes;
      disposeChat();
      mdBox.textContent = '';
      coverageBox.textContent = '';
      const runId = `run-${Date.now()}`;
      const runTitle = `完整讲解 · ${autoTitle()}`;
      const origin = { runId, folder, title: runTitle };
      pendingRun = origin;
      const stream = createStreamPreview({ el, api, runId, parent: mdBox });
      cleanupStream = () => { stream.unsubscribe?.(); stream.streamBox.remove(); };
      activeCancel = () => {
        if (typeof api.cancelRun === 'function') api.cancelRun(runId).catch((err) => toast('终止失败：' + errText(err), 'error'));
      };
      setStatus(mountRunStatus(runId, activeCancel));
      startBtn.textContent = '终止运行';
      startBtn.classList.add('btn-danger');
      try {
        /** @type {ReviewRunPayload} */
        const payload = {
          folder,
          files: changes.files,
          runId,
          title: runTitle,
          kind: 'full',
          planEnabled: planReviewEnabled(),
        };
        if (changes.snapshotId) {
          payload.snapshotId = changes.snapshotId;
        }
        const plan = await loadPlanContext(api, folder);
        if (plan) {
          if (plan.id) payload.planId = plan.id;
          payload.planTitle = plan.title;
          payload.planContext = plan.section;
        }
        await handleResult(await api.explainFull(payload), origin);
      } catch (err) {
        if (epoch !== projectEpoch) return;
        pendingRun = null;
        handleRunError(err);
      } finally {
        if (stream.unsubscribe) stream.unsubscribe();
        stream.streamBox.remove();
        if (epoch === projectEpoch) finishAttempt();
      }
    };

    /** @type {(() => void) | null} */
    let activeCancel = null;
    startBtn.addEventListener('click', () => {
      if (running && activeCancel) {
        activeCancel();
        return;
      }
      run();
    });

    bus.addEventListener('changes:loaded', () => {
      refresh();
      scheduleEstimateRefresh();
      // 保留已有讲解结果，只提示可能过期
      if (mdBox.firstChild && !pendingRun) {
        setStatus(el('div', { class: 'empty-hint' },
          '改动已更新，以下讲解可能已过期，可点击「开始完整讲解」重新生成'));
      }
      if (historyPanel.style.display !== 'none') {
        historyView.load();
      }
    });

    refresh();
    scheduleEstimateRefresh();
  },
};

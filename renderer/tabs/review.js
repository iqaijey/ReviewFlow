import { createResultTools } from './review/resultTools.js';
import { createToolbar } from './review/toolbar.js';
import { createEstimate } from './review/estimate.js';
import { createRunFlow } from './review/runFlow.js';
import { createFileCards } from './review/fileCards.js';
import { setStatusBox } from '../lib/statusBox.js';

// 多角度 Review：整体分析 / 逐文件 / 历史 三种模式

import { createRunStatus } from '../lib/runStatus.js';
import { createFindingsView } from '../lib/findingsView.js';
import { createHistoryView } from '../lib/historyView.js';

export default {
  id: 'review',
  title: '多角度 Review',

  mount(container, ctx) {
    const { el, bus, state, api, errText, notify, toast, emptyState, workspaceState } = ctx;

    const context = {
      get el() { return el; },
      get api() { return api; },
      get toast() { return toast; },
      get errText() { return errText; },
      get state() { return state; },
      get bus() { return bus; },
      get mdBox() { return mdBox; },
      get coverageBox() { return coverageBox; },
      get findSection() { return findSection; },
      get scheduleEstimateRefresh() { return estimate.scheduleEstimateRefresh; },
      get planHint() { return planHint; },
      get rehydrateFileAnalyses() { return fileCards.rehydrateFileAnalyses; },
      get ctx() { return ctx; },
      get overallPanel() { return overallPanel; },
      get estimateBadge() { return toolbar.estimateBadge; },
      get multiOn() { return toolbar.multiOn; },
      set multiOn(value) { toolbar.multiOn = value; },
      get multiBoxes() { return toolbar.multiBoxes; },
      get selectedNoiseOverride() { return toolbar.selectedNoiseOverride; },
      get synSelect() { return toolbar.synSelect; },
      get fileCardControllers() { return fileCards.fileCardControllers; },
      get pendingRun() { return pendingRun; },
      set pendingRun(value) { pendingRun = value; },
      get setStatus() { return setStatus; },
      get activePreset() { return toolbar.activePreset; },
      get cachedCustomPrompt() { return toolbar.cachedCustomPrompt; },
      set cachedCustomPrompt(value) { toolbar.cachedCustomPrompt = value; },
      get disposeRunStatus() { return disposeRunStatus; },
      get dialogResuming() { return dialogResuming; },
      set dialogResuming(value) { dialogResuming = value; },
      get running() { return running; },
      set running(value) { running = value; },
      get startBtn() { return toolbar.startBtn; },
      get notify() { return notify; },
      get mountRunStatus() { return mountRunStatus; },
      get refresh() { return refresh; },
      get sectionFeedback() { return resultTools.sectionFeedback; },
      set sectionFeedback(value) { resultTools.sectionFeedback = value; },
      get currentResult() { return resultTools.currentResult; },
      set currentResult(value) { resultTools.currentResult = value; },
      get injectSectionTools() { return resultTools.injectSectionTools; },
      get statsLine() { return resultTools.statsLine; },
      get exportGroup() { return resultTools.exportGroup; },
      get buildFollowUp() { return resultTools.buildFollowUp; },
      get disposeChats() { return resultTools.disposeChats; },
      get findingsView() { return findingsView; },
      get historyView() { return historyView; },
      get historyPanel() { return historyPanel; },
      get autoTitle() { return resultTools.autoTitle; },
      get prevSwitch() { return toolbar.prevSwitch; },
      get container() { return container; },
      get switchMode() { return switchMode; },
      get defaultExportName() { return resultTools.defaultExportName; },
      get filesPanel() { return filesPanel; },
      get emptyState() { return emptyState; },
    };

    // 顶部方案参照提示条，内容由 refreshPlanHint 填充
    const planHint = el('div', {
      class: 'stat-item',
      style: 'display:none; font-size:12px; margin-bottom:6px;',
    });
    container.appendChild(planHint);

    // ---------- 分段切换 ----------
    const seg = el('div', { class: 'seg-control' });
    const overallPanel = el('div', { class: 'seg-panel' });
    const filesPanel = el('div', { class: 'seg-panel', style: 'display:none' });
    const historyPanel = el('div', { class: 'seg-panel', style: 'display:none' });
    const panels = { overall: overallPanel, files: filesPanel, history: historyPanel };
    const segBtns = {};
    const switchMode = (mode, { persist = true } = {}) => {
      const normalized = mode === 'files' || mode === 'per-file'
        ? 'files'
        : mode === 'history'
          ? 'history'
          : 'overall';
      for (const [id, btn] of Object.entries(segBtns)) {
        btn.classList.toggle('active', id === normalized);
      }
      for (const [id, panel] of Object.entries(panels)) {
        panel.style.display = id === normalized ? '' : 'none';
      }
      if (persist && workspaceState && state.folder) {
        workspaceState.updateProject(state.folder, { reviewMode: normalized });
      }
      if (normalized === 'history') loadHistory();
    };
    for (const [id, label] of [['overall', '整体分析'], ['files', '逐文件'], ['history', '历史']]) {
      const btn = el('button', { class: 'seg-btn', type: 'button' }, label);
      btn.addEventListener('click', () => switchMode(id));
      segBtns[id] = btn;
      seg.appendChild(btn);
    }
    segBtns.overall.classList.add('active');
    container.appendChild(seg);
    container.appendChild(overallPanel);
    container.appendChild(filesPanel);
    container.appendChild(historyPanel);

    const resultTools = createResultTools(context);

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
        label: 'AI 分析中，请稍候…',
        showDetails: () => ctx.showRunDetails(),
        onCancel,
        toast,
        errText,
      });
      return activeRunStatus.root;
    };

    const toolbar = createToolbar(context);

    const statusBox = el('div', { class: 'review-status' });
    const checklistBox = el('div', { style: 'display:none' });
    const coverageBox = el('div');
    const mdBox = el('div', { class: 'md review-result' });
    overallPanel.appendChild(statusBox);
    overallPanel.appendChild(coverageBox);
    overallPanel.appendChild(checklistBox);
    overallPanel.appendChild(mdBox);

    const findingsView = createFindingsView({
      container: checklistBox,
      el,
      api,
      bus,
      getFolder: () => state.folder,
      toast,
      errText,
      showRunDetails: () => ctx.showRunDetails(),
    });
    /** @type {string | null} */
    let checklistFolder = state.folder;
    if (state.folder) {
      findingsView.reloadFromStore(state.folder);
    }

    // 在已渲染的 markdown 中按标题文字定位小节
    const findSection = (dim) => {
      for (const h of mdBox.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
        if (h.textContent.includes(dim)) return h;
      }
      return null;
    };

    let running = false;
    /** @type {{ runId: string, folder: string, title: string } | null} */
    let pendingRun = null;
    let dialogResuming = false;

    const setStatus = (node, fill) => setStatusBox(statusBox, node, fill);

    const refresh = () => {
      if (pendingRun) return;
      if (!state.changes || !state.changes.files.length) {
        toolbar.startBtn.disabled = true;
        toolbar.startBtn.textContent = '开始 AI 分析';
        toolbar.estimateBadge.style.display = 'none';
        setStatus(emptyState('暂无可评审的改动',
          '点击左下角「选择项目」选择项目文件夹，并确保存在未提交的改动'), true);
        return;
      }
      toolbar.startBtn.disabled = running || !!pendingRun;
      if (!running && !mdBox.firstChild) {
        setStatus(emptyState('准备就绪', '点击「开始 AI 分析」生成多角度评审报告'), true);
      }
    };

    const estimate = createEstimate(context);

    createRunFlow(context);

    const fileCards = createFileCards(context);

    const historyView = createHistoryView({
      container: historyPanel,
      el,
      api,
      bus,
      getFolder: () => state.folder,
      kind: 'review',
      emptyState,
      selectFolder: () => ctx.selectFolder(),
      toast,
      errText,
      onEntryUpdated: (updated) => {
        if (resultTools.currentResult && resultTools.currentResult.id === updated.id) {
          resultTools.currentResult.title = updated.title;
        }
      },
    });
    const loadHistory = () => historyView.load();
    bus.addEventListener('project:changed', () => {
      findingsView.clear();
      fileCards.renderFilesPanel();
      historyPanel.textContent = '';
    });

    bus.addEventListener('agent:changed', (ev) => {
      const change = /** @type {CustomEvent<AgentChange>} */ (ev).detail;
      if (!state.folder) return;
      if (change.scopes.includes('findings')) findingsView.reloadFromStore(state.folder);
      if (change.scopes.includes('history') && historyPanel.style.display !== 'none') loadHistory();
    });

    bus.addEventListener('plan:changed', () => {
      toolbar.refreshPlanHint();
      fileCards.rehydrateFileAnalyses();
      estimate.scheduleEstimateRefresh();
    });

    bus.addEventListener('changes:loaded', () => {
      refresh();
      fileCards.renderFilesPanel();
      toolbar.refreshPlanHint();
      estimate.scheduleEstimateRefresh();
      if (state.folder !== checklistFolder) {
        checklistFolder = state.folder;
        if (workspaceState && state.folder) {
          const ws = workspaceState.getProject(state.folder);
          switchMode(ws.reviewMode || 'overall', { persist: false });
        }
        findingsView.reloadFromStore(state.folder);
      }
      if (historyPanel.style.display !== 'none') {
        historyView.load();
      }
      if (mdBox.firstChild && !pendingRun) {
        setStatus(el('div', { class: 'empty-hint' },
          '改动已更新，以下分析结果可能已过期，可点击「开始 AI 分析」重新生成'));
      }
    });

    // 「改动总览」文件项的 AI 按钮跳转过来后，切到逐文件模式并自动分析该文件
    bus.addEventListener('file:analyze:ready', () => {
      const file = state.pendingAnalyzeFile;
      if (!file) return;
      state.pendingAnalyzeFile = null;
      switchMode('files');
      const trigger = fileCards.fileAnalyzeTriggers.get(file);
      if (trigger) trigger();
    });

    if (workspaceState && state.folder) {
      const ws = workspaceState.getProject(state.folder);
      switchMode(ws.reviewMode || 'overall', { persist: false });
    }
    refresh();
    fileCards.renderFilesPanel();
    estimate.scheduleEstimateRefresh();
  },
};

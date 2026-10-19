import { mountSplitter } from './overview/splitter.js';
import { createEffectiveRules } from './overview/effectiveRules.js';
import { createSelection } from './overview/selection.js';
import { createStats } from './overview/stats.js';
import { createSourceSelector } from './overview/sourceSelector.js';
import { createFileList } from './overview/fileList.js';
import { createDiffView } from './overview/diffView.js';
import { createNavigation } from './overview/navigation.js';
import { createLineInteraction } from './overview/lineInteraction.js';
// 改动总览：基准选择 + 搜索 + 文件列表 + diff 视图，选中后显式点击操作条或 ⌘E 派发 'line:select'
import { MIN_FILE_LIST_WIDTH, computeFileFingerprint, buildChangesSearchIndex } from '../lib/overviewPerf.js';

const WORKTREE_MODES = new Set(['staged', 'unstaged', 'untracked']);

const fallbackFileFingerprint = computeFileFingerprint;

export default {
  id: 'overview',
  title: '改动总览',

  mount(container, ctx) {
    const { el, bus, state, api, errText, toast, emptyState, workspaceState } = ctx;

    const context = {
      get state() { return state; },
      get api() { return api; },
      get effectiveRulesBtn() { return effectiveRulesBtn; },
      get toast() { return toast; },
      get errText() { return errText; },
      get updateCollapseAllBtn() { return updateCollapseAllBtn; },
      get el() { return el; },
      get pendingSelection() { return pendingSelection; },
      set pendingSelection(value) {
        pendingSelection = value;
        bus.dispatchEvent(new CustomEvent('explain:invalidate'));
      },
      get selectionBar() { return selectionBar; },
      get explainSelectionBtn() { return explainSelectionBtn; },
      get selectionSummary() { return selectionSummary; },
      get diffView() { return diffView; },
      get currentSelectedCpos() { return diffController.currentSelectedCpos; },
      set currentSelectedCpos(value) { diffController.currentSelectedCpos = value; },
      get currentFocusedCpos() { return diffController.currentFocusedCpos; },
      get setFocusedCpos() { return diffController.setFocusedCpos; },
      get fileList() { return fileList; },
      get bus() { return bus; },
      get clearSelectionBtn() { return clearSelectionBtn; },
      get countReadFiles() { return countReadFiles; },
      get readMarkers() { return readMarkers; },
      set readMarkers(value) { readMarkers = value; },
      get persistProjectPatch() { return persistProjectPatch; },
      get renderFileList() { return fileListController.renderFileList; },
      get readStatEl() { return readStatEl; },
      set readStatEl(value) { readStatEl = value; },
      get statsBar() { return statsBar; },
      get semanticsNote() { return semanticsNote; },
      get limitsBanner() { return limitsBanner; },
      get baseSelect() { return baseSelect; },
      get branchInfo() { return branchInfo; },
      set branchInfo(value) { branchInfo = value; },
      get ctx() { return ctx; },
      get clearAllSelection() { return selection.clearAllSelection; },
      get customBaseInput() { return customBaseInput; },
      get isFileRead() { return isFileRead; },
      get classSel() { return selection.classSel; },
      get classKey() { return selection.classKey; },
      get classLabel() { return selection.classLabel; },
      get toggleClass() { return selection.toggleClass; },
      get updateReadStat() { return stats.updateReadStat; },
      get lastDiffFile() { return lastDiffFile; },
      set lastDiffFile(value) { lastDiffFile = value; },
      get scrollPositions() { return scrollPositions; },
      set scrollPositions(value) { scrollPositions = value; },
      get renderDiff() { return diffController.renderDiff; },
      get applySearchHighlight() { return applySearchHighlight; },
      get searchIndex() { return searchIndex; },
      set searchIndex(value) { searchIndex = value; },
      get searchQuery() { return searchQuery; },
      set searchQuery(value) { searchQuery = value; },
      get lastDiffRows() { return lastDiffRows; },
      set lastDiffRows(value) { lastDiffRows = value; },
      get applySearchHighlightInScope() { return applySearchHighlightInScope; },
      get isHunkCollapsed() { return isHunkCollapsed; },
      get setHunkCollapsed() { return setHunkCollapsed; },
      get syncSelectionBar() { return selection.syncSelectionBar; },
      get emptyState() { return emptyState; },
      get searchTimer() { return searchTimer; },
      set searchTimer(value) { searchTimer = value; },
      get searchInput() { return searchInput; },
      get ensureFileItemRendered() { return fileListController.ensureFileItemRendered; },
      get fileItems() { return fileListController.fileItems; },
      set fileItems(value) { fileListController.fileItems = value; },
      get selectFile() { return fileListController.selectFile; },
      get renderHunkSliceUpTo() { return diffController.renderHunkSliceUpTo; },
      get filteredFiles() { return fileListController.filteredFiles; },
      set filteredFiles(value) { fileListController.filteredFiles = value; },
      get switchingBase() { return sourceSelector.switchingBase; },
      set switchingBase(value) { sourceSelector.switchingBase = value; },
      get hideCustomBaseInput() { return sourceSelector.hideCustomBaseInput; },
      get applyBase() { return sourceSelector.applyBase; },
      get ensureHunksRenderedThrough() { return diffController.ensureHunksRenderedThrough; },
      get currentHunkStartCpos() { return diffController.currentHunkStartCpos; },
      set currentHunkStartCpos(value) { diffController.currentHunkStartCpos = value; },
      get clearLineSelectionDOM() { return selection.clearLineSelectionDOM; },
      get container() { return container; },
      get triggerExplicitExplain() { return selection.triggerExplicitExplain; },
    };

    const statsBar = el('div', { class: 'overview-stats' });

    // 工具栏：基准下拉 + 自定义输入（替换下拉显示）+ 搜索框
    const toolbar = el('div', { class: 'overview-toolbar' });
    const baseSelect = el('select', { class: 'base-select' });
    const customBaseInput = el('input', {
      class: 'base-select custom-base-input', type: 'text',
      placeholder: '如 main...HEAD 或 commit sha，回车确认', spellcheck: 'false',
    });
    customBaseInput.style.display = 'none';
    const searchInput = el('input', {
      class: 'search-input', type: 'text',
      placeholder: '搜索文件路径或 diff 内容…', spellcheck: 'false',
    });
    toolbar.appendChild(el('span', { class: 'toolbar-label' }, '基准'));
    toolbar.appendChild(baseSelect);
    toolbar.appendChild(customBaseInput);
    const semanticsNote = el('span', {
      class: 'source-semantics-note',
      hidden: 'hidden',
    });
    toolbar.appendChild(semanticsNote);
    toolbar.appendChild(searchInput);
    // 对当前选中文件的所有 hunk 一键折叠/展开
    const collapseAllBtn = el('button', { class: 'btn', type: 'button' }, '全部折叠');
    collapseAllBtn.disabled = true;
    toolbar.appendChild(collapseAllBtn);
    const effectiveRulesBtn = /** @type {HTMLButtonElement} */ (el('button', {
      class: 'btn',
      type: 'button',
      title: '查看当前选中文件生效的 .reviewflow.md 规则',
    }, '生效规则'));
    effectiveRulesBtn.disabled = true;
    toolbar.appendChild(effectiveRulesBtn);

    const limitsBanner = el('div', {
      class: 'overview-limits-banner',
      role: 'status',
      hidden: 'hidden',
    });

    const body = el('div', { class: 'overview-body' });
    const fileList = el('div', {
      class: 'file-list',
      role: 'listbox',
      'aria-label': '改动文件列表',
    });
    const splitter = el('div', {
      class: 'splitter',
      role: 'separator',
      tabindex: '0',
      'aria-orientation': 'vertical',
      'aria-label': '调整文件列表宽度',
      'aria-valuemin': String(MIN_FILE_LIST_WIDTH),
      'aria-valuemax': '600',
      'aria-valuenow': '300',
    });
    const diffView = el('div', { class: 'diff-view' });
    body.appendChild(fileList);
    body.appendChild(splitter);
    body.appendChild(diffView);
    container.appendChild(statsBar);

    mountSplitter({ body, splitter, fileList, api, toast, errText });
    container.appendChild(toolbar);
    container.appendChild(limitsBanner);
    container.appendChild(body);

    // 无项目/无改动时：隐藏统计条与双栏，只显示一个居中的空状态
    const emptyHost = el('div', { class: 'overview-empty', style: 'display: none' });
    container.appendChild(emptyHost);

    // diff 底部紧凑显式解析操作条（选区或类选中存在时显示）
    const selectionBar = el('div', {
      class: 'diff-selection-bar',
      role: 'region',
      'aria-label': '待解析选区操作',
      hidden: 'hidden',
    });
    const selectionSummary = el('span', {
      class: 'diff-selection-summary',
      'aria-live': 'polite',
      'aria-atomic': 'true',
    }, '');
    const selectionActions = el('div', { class: 'diff-selection-actions' });
    const explainSelectionBtn = /** @type {HTMLButtonElement} */ (el('button', {
      class: 'btn btn-primary diff-selection-btn',
      type: 'button',
      'aria-label': '解析选区（⌘E）',
    }, '解析选区（⌘E）'));
    const clearSelectionBtn = /** @type {HTMLButtonElement} */ (el('button', {
      class: 'btn diff-selection-btn',
      type: 'button',
      'aria-label': '清除选区',
    }, '清除'));
    selectionActions.appendChild(explainSelectionBtn);
    selectionActions.appendChild(clearSelectionBtn);
    selectionBar.appendChild(selectionSummary);
    selectionBar.appendChild(selectionActions);

    /** @type {Record<string, string>} 已读标记：path -> diffFingerprint */
    let readMarkers = {};
    /** @type {Record<string, string[]>} 折叠的 hunk：path -> hunk.header[] */
    let collapsedHunks = {};
    /** @type {Record<string, number>} 各文件 diff 滚动位置：path -> scrollTop */
    let scrollPositions = {};
    let knownFolder = null;
    let searchQuery = '';
    /** @type {HTMLElement | null} */
    let readStatEl = null;
    /** @type {{ current: string, branches: string[] }} */
    let branchInfo = { current: '', branches: [] };
    /** @type {any} */
    let lastDiffFile = null; // 上次渲染 diff 的文件，用于重渲染时恢复滚动与选中行
    let lastDiffRows = [];
    /** @type {any} 待解析的选区（未触发 AI 请求） */
    let pendingSelection = null;

    const persistProjectPatch = (patch) => {
      if (!workspaceState || !state.folder) return;
      workspaceState.updateProject(state.folder, patch);
    };

    const isFileRead = (file) => {
      if (!file || !file.path) return false;
      const savedFp = readMarkers[file.path];
      if (!savedFp) return false;
      return savedFp === fallbackFileFingerprint(file);
    };

    const countReadFiles = (files) => {
      if (!Array.isArray(files)) return 0;
      let count = 0;
      for (const f of files) {
        if (isFileRead(f)) count += 1;
      }
      return count;
    };

    const isHunkCollapsed = (filePath, header) => {
      const list = collapsedHunks[filePath];
      return Array.isArray(list) && list.includes(header);
    };

    const setHunkCollapsed = (filePath, header, shouldCollapse) => {
      const prev = Array.isArray(collapsedHunks[filePath]) ? [...collapsedHunks[filePath]] : [];
      const idx = prev.indexOf(header);
      if (shouldCollapse && idx < 0) prev.push(header);
      else if (!shouldCollapse && idx >= 0) prev.splice(idx, 1);
      if (prev.length) collapsedHunks[filePath] = prev;
      else delete collapsedHunks[filePath];
      persistProjectPatch({ collapsedHunks: { ...collapsedHunks } });
    };

    // 无选中文件（或文件无 hunk）时禁用；全部已折叠时切换为「全部展开」
    const updateCollapseAllBtn = () => {
      const file = state.selectedFile;
      const hunks = file && Array.isArray(file.hunks) ? file.hunks : [];
      collapseAllBtn.disabled = !hunks.length;
      effectiveRulesBtn.disabled = !(state.folder && file && file.path);
      const allCollapsed = hunks.length > 0 &&
        hunks.every((hk) => isHunkCollapsed(file.path, hk.header));
      collapseAllBtn.textContent = allCollapsed ? '全部展开' : '全部折叠';
    };
    collapseAllBtn.addEventListener('click', () => {
      const file = state.selectedFile;
      if (!file || !file.hunks.length) return;
      const allCollapsed = file.hunks.every((hk) => isHunkCollapsed(file.path, hk.header));
      if (allCollapsed) {
        delete collapsedHunks[file.path];
      } else {
        collapsedHunks[file.path] = file.hunks.map((hk) => hk.header);
      }
      persistProjectPatch({ collapsedHunks: { ...collapsedHunks } });
      diffController.renderDiff(file);
      applySearchHighlight(false);
    });

    createEffectiveRules(context);

    const showEmpty = (text, sub, hideChrome) => {
      fileListController.cancelFileListLazy();
      diffController.cancelDiffLazy();
      statsBar.style.display = 'none';
      body.style.display = 'none';
      toolbar.style.display = hideChrome ? 'none' : '';
      if (hideChrome) {
        semanticsNote.hidden = true;
        limitsBanner.hidden = true;
      }
      collapseAllBtn.disabled = true;
      effectiveRulesBtn.disabled = true;
      lastDiffFile = null;
      lastDiffRows = [];
      emptyHost.style.display = '';
      emptyHost.textContent = '';
      // 未选项目时给出直接入口，不用去角落找按钮
      const action = state.folder ? null
        : { label: '选择项目', onClick: () => ctx.selectFolder() };
      emptyHost.appendChild(emptyState(text, sub, action));
    };

    const selection = createSelection(context);

    const stats = createStats(context);

    const sourceSelector = createSourceSelector(context);

    // ---------- 搜索 ----------
    /** @type {import('../lib/overviewPerf.js').ChangesSearchIndex | null} */
    let searchIndex = null;

    const applySearchHighlightInScope = (rootEl, scrollToFirst) => {
      if (!searchQuery) return null;
      /** @type {Element | null} */
      let first = null;
      for (const content of rootEl.querySelectorAll('.diff-line .line-content')) {
        if (!content.textContent || !content.textContent.toLowerCase().includes(searchQuery)) continue;
        const row = content.closest('.diff-line');
        if (!row) continue;
        row.classList.add('line-match');
        if (!first) first = row;
      }
      if (scrollToFirst && first) first.scrollIntoView({ block: 'center' });
      return first;
    };

    const applySearchHighlight = (scrollToFirst) => {
      diffView.querySelectorAll('.diff-line.line-match')
        .forEach((n) => n.classList.remove('line-match'));
      if (!searchQuery) return;
      applySearchHighlightInScope(diffView, scrollToFirst);
    };

    // 输入防抖：每次击键都全量重建文件列表 + 扫描 diff，大 diff 下会卡顿
    let searchTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
    searchInput.addEventListener('input', () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchTimer = null;
        const rawText = searchInput.value;
        searchQuery = rawText.trim().toLowerCase();
        persistProjectPatch({ searchText: rawText });
        fileListController.renderFileList(state.changes);
        applySearchHighlight(true);
      }, 150);
    });

    const fileListController = createFileList(context);

    const diffController = createDiffView(context);

    const syncFromProjectWorkspace = (folder) => {
      if (!workspaceState || !folder) {
        readMarkers = {};
        collapsedHunks = {};
        scrollPositions = {};
        searchInput.value = '';
        searchQuery = '';
        return null;
      }
      const ws = workspaceState.getProject(folder);
      readMarkers = { ...(ws.readMarkers || {}) };
      collapsedHunks = {};
      for (const [k, v] of Object.entries(ws.collapsedHunks || {})) {
        if (Array.isArray(v)) collapsedHunks[k] = [...v];
      }
      scrollPositions = { ...(ws.scrollPositions || {}) };
      searchInput.value = ws.searchText || '';
      searchQuery = (ws.searchText || '').trim().toLowerCase();
      return ws;
    };

    const render = () => {
      let restoredSelectedPath = null;
      if (state.folder !== knownFolder) {
        knownFolder = state.folder;
        selection.classSel.clear();
        pendingSelection = null;
        state.selAnchor = null;
        const ws = syncFromProjectWorkspace(state.folder);
        restoredSelectedPath = ws ? ws.selectedFilePath : null;
        sourceSelector.refreshBranches();
      }
      sourceSelector.rebuildBaseOptions();
      const changes = state.changes;
      searchIndex = changes ? buildChangesSearchIndex(changes) : null;
      if (!changes) {
        showEmpty('请先选择项目文件夹', '点击左下角「选择项目」开始', true);
        return;
      }
      const paths = new Set(changes.files.map((file) => file.path));
      const selectedLine = state.selectedLine;
      if (selectedLine && (
        (selectedLine.file && !paths.has(selectedLine.file.path)) ||
        (selectedLine.segments && selectedLine.segments.some((seg) =>
          seg.file && !paths.has(seg.file.path)))
      )) state.selectedLine = null;
      if (pendingSelection && (
        (pendingSelection.file && !paths.has(pendingSelection.file.path)) ||
        (pendingSelection.segments && pendingSelection.segments.some((seg) =>
          seg.file && !paths.has(seg.file.path)))
      )) {
        pendingSelection = null;
      }

      const currentPath = (state.selectedFile && state.selectedFile.path)
        || restoredSelectedPath
        || (workspaceState && state.folder ? workspaceState.getProject(state.folder).selectedFilePath : null);
      const file = changes.files.find((f) => f.path === currentPath)
        || changes.files[0] || null;
      state.selectedFile = file;
      if (file) {
        persistProjectPatch({ selectedFilePath: file.path });
      }
      stats.renderSemanticsNote(changes);
      stats.renderLimitsBanner(changes);
      if (!changes.files.length) {
        const hasModeOrBase = Boolean(state.base || WORKTREE_MODES.has(state.sourceMode));
        showEmpty(hasModeOrBase ? '该基准下没有改动' : '当前没有未提交的改动',
          hasModeOrBase ? '换个基准试试，或回到「未提交改动」' : '工作区当前是干净的');
        return;
      }
      statsBar.style.display = '';
      toolbar.style.display = '';
      body.style.display = '';
      emptyHost.style.display = 'none';
      stats.renderStats(changes);
      fileListController.renderFileList(changes);
      diffController.renderDiff(file);
      applySearchHighlight(false);
    };

    showEmpty(state.folder ? '当前没有未提交的改动' : '请先选择项目文件夹',
      state.folder ? '工作区当前是干净的' : '点击左下角「选择项目」开始', !state.folder);
    sourceSelector.rebuildBaseOptions();
    bus.addEventListener('changes:loaded', render);
    bus.addEventListener('project:changed', () => {
      selection.clearAllSelection();
      diffController.renderDiff(null);
      render();
    });

    createNavigation(context);

    createLineInteraction(context);

  },
};

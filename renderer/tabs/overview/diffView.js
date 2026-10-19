import { INITIAL_DIFF_ROW_BUDGET, CHUNK_DIFF_ROW_BUDGET, computeFileFingerprint, computeDiffHunkOffsets, planHunkRenderBatch, estimateRequiredRowsForScroll } from '../../lib/overviewPerf.js';

export function createDiffView(context) {
  // ---------- diff 视图（按 hunk 渐进懒渲染 + 折叠按需构建） ----------
  let restoringScroll = false;
  /** @type {number | null} */
  let diffChunkRaf = null;
  /** @type {IntersectionObserver | null} */
  let diffSentinelObserver = null;
  /** @type {HTMLElement | null} */
  let diffSentinel = null;
  let renderedHunkCount = 0;
  /** @type {number[]} */
  let currentHunkStartCpos = [];
  /** @type {Set<number>} */
  let currentSelectedCpos = new Set();
  let currentFocusedCpos = 0;

  const setFocusedCpos = (pos) => {
    const total = context.lastDiffRows ? context.lastDiffRows.length : 0;
    if (!total) {
      currentFocusedCpos = 0;
      return null;
    }
    const clamped = Math.max(0, Math.min(total - 1, Number(pos) || 0));
    const visible = (entry) => entry?.row && context.diffView.contains(entry.row)
      && !entry.row.closest('.hunk-collapsed, [hidden]');
    const target = visible(context.lastDiffRows[clamped]) ? clamped
      : context.lastDiffRows.findIndex(visible);
    context.lastDiffRows.forEach((entry) => entry?.row?.setAttribute('tabindex', '-1'));
    currentFocusedCpos = target >= 0 ? target : clamped;
    const nextEntry = context.lastDiffRows[currentFocusedCpos];
    if (target >= 0 && nextEntry && nextEntry.row) {
      nextEntry.row.setAttribute('tabindex', '0');
      return nextEntry.row;
    }
    return null;
  };

  const cancelDiffLazy = () => {
    if (diffChunkRaf != null) {
      cancelAnimationFrame(diffChunkRaf);
      diffChunkRaf = null;
    }
    if (diffSentinelObserver) {
      diffSentinelObserver.disconnect();
      diffSentinelObserver = null;
    }
    if (diffSentinel) {
      diffSentinel.remove();
      diffSentinel = null;
    }
  };

  context.diffView.addEventListener('scroll', () => {
    if (restoringScroll || !context.lastDiffFile || !context.lastDiffFile.path) return;
    context.scrollPositions[context.lastDiffFile.path] = Math.round(context.diffView.scrollTop);
    context.persistProjectPatch({ scrollPositions: { ...context.scrollPositions } });
  }, { passive: true });

  const populateHunkLines = (file, hunk, hunkIndex, table) => {
    if (table.dataset.populated === '1') return;
    table.dataset.populated = '1';
    let cpos = currentHunkStartCpos[hunkIndex] || 0;
    const frag = document.createDocumentFragment();
    (hunk.lines || []).forEach((line, lineIndex) => {
      const isChangedLine = line.type === 'add' || line.type === 'del';
      const row = context.el('div', {
        class: `diff-line line-${line.type}`,
        role: isChangedLine ? 'option' : undefined,
        'aria-selected': isChangedLine ? 'false' : undefined,
      });
      row.dataset.lref = `${hunkIndex}:${lineIndex}`;
      const lineNoCell = (text) => context.el('span', {
        class: 'line-no line-no-copy',
        title: isChangedLine ? '点击复制该行 · 上下拖动框选多行解析' : '点击复制该行',
      }, text);
      row.appendChild(lineNoCell(line.oldLine == null ? '' : String(line.oldLine)));
      row.appendChild(lineNoCell(line.newLine == null ? '' : String(line.newLine)));
      row.appendChild(context.el('span', { class: 'line-content' }, line.content));
      if (isChangedLine) {
        const pos = cpos;
        cpos += 1;
        row.classList.add('line-clickable');
        row.dataset.cpos = String(pos);
        row.setAttribute('tabindex', pos === currentFocusedCpos ? '0' : '-1');
        if (currentSelectedCpos.has(pos)) {
          row.classList.add('line-selected');
          row.setAttribute('aria-selected', 'true');
        }
        context.lastDiffRows[pos] = { row, hunkIndex, line, lineIndex };
      }
      frag.appendChild(row);
    });
    table.appendChild(frag);
    if (context.searchQuery) {
      context.applySearchHighlightInScope(table, false);
    }
  };

  const buildHunkBox = (file, hunk, hunkIndex) => {
    const hunkCollapsed = context.isHunkCollapsed(file.path, hunk.header);
    const hunkBox = context.el('div', {
      class: 'diff-hunk',
      dataset: { hunkIndex: String(hunkIndex) },
    });
    if (hunkCollapsed) hunkBox.classList.add('hunk-collapsed');
    const header = context.el('button', {
      class: 'hunk-header',
      type: 'button',
      'aria-expanded': hunkCollapsed ? 'false' : 'true',
    });
    const arrow = context.el('span', { class: 'hunk-arrow', 'aria-hidden': 'true' }, hunkCollapsed ? '▸' : '▾');
    header.appendChild(arrow);
    header.appendChild(document.createTextNode(' ' + hunk.header));
    const table = context.el('div', {
      class: 'diff-lines',
      role: 'listbox',
      'aria-multiselectable': 'true',
    });
    if (!hunkCollapsed) {
      populateHunkLines(file, hunk, hunkIndex, table);
    }
    header.addEventListener('click', () => {
      const nowCollapsed = !context.isHunkCollapsed(file.path, hunk.header);
      context.setHunkCollapsed(file.path, hunk.header, nowCollapsed);
      hunkBox.classList.toggle('hunk-collapsed', nowCollapsed);
      arrow.textContent = nowCollapsed ? '▸' : '▾';
      header.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
      if (!nowCollapsed) {
        populateHunkLines(file, hunk, hunkIndex, table);
      }
      setFocusedCpos(currentFocusedCpos);
      context.updateCollapseAllBtn();
    });
    hunkBox.appendChild(header);
    hunkBox.appendChild(table);
    return hunkBox;
  };

  const renderHunkSliceUpTo = (file, targetEndHunkIndex) => {
    if (!file || !Array.isArray(file.hunks)) return;
    const total = file.hunks.length;
    const end = Math.min(total, Math.max(renderedHunkCount, targetEndHunkIndex));
    if (end <= renderedHunkCount) return;
    const frag = document.createDocumentFragment();
    for (let i = renderedHunkCount; i < end; i += 1) {
      frag.appendChild(buildHunkBox(file, file.hunks[i], i));
    }
    if (diffSentinel && diffSentinel.parentNode === context.diffView) {
      context.diffView.insertBefore(frag, diffSentinel);
    } else if (context.selectionBar.parentNode === context.diffView) {
      context.diffView.insertBefore(frag, context.selectionBar);
    } else {
      context.diffView.appendChild(frag);
    }
    renderedHunkCount = end;
    setFocusedCpos(currentFocusedCpos);
    if (renderedHunkCount >= total) {
      cancelDiffLazy();
    }
  };

  const ensureHunksRenderedThrough = (file, targetHunkIndex, expandTarget = false) => {
    if (!file || !Array.isArray(file.hunks) || targetHunkIndex < 0) return;
    const clampedIdx = Math.min(file.hunks.length - 1, targetHunkIndex);
    if (clampedIdx >= renderedHunkCount) {
      renderHunkSliceUpTo(file, clampedIdx + 1);
    }
    if (expandTarget) {
      const hunk = file.hunks[clampedIdx];
      const hunkBox = /** @type {HTMLElement | null} */ (
        context.diffView.querySelector(`.diff-hunk[data-hunk-index="${clampedIdx}"]`)
      );
      if (hunk && hunkBox) {
        if (context.isHunkCollapsed(file.path, hunk.header)) {
          context.setHunkCollapsed(file.path, hunk.header, false);
          hunkBox.classList.remove('hunk-collapsed');
          const headerBtn = hunkBox.querySelector('.hunk-header');
          const arrow = hunkBox.querySelector('.hunk-arrow');
          if (headerBtn) headerBtn.setAttribute('aria-expanded', 'true');
          if (arrow) arrow.textContent = '▾';
          context.updateCollapseAllBtn();
        }
        const table = /** @type {HTMLElement | null} */ (hunkBox.querySelector('.diff-lines'));
        if (table) populateHunkLines(file, hunk, clampedIdx, table);
      }
    }
    setFocusedCpos(currentFocusedCpos);
  };

  const renderDiff = (file) => {
    cancelDiffLazy();
    if (!file) {
      context.diffView.textContent = '';
      context.lastDiffFile = null;
      context.lastDiffRows = [];
      renderedHunkCount = 0;
      currentHunkStartCpos = [];
      currentSelectedCpos = new Set();
      currentFocusedCpos = 0;
      context.updateCollapseAllBtn();
      context.syncSelectionBar();
      return;
    }
    // 同一文件重渲染时保留滚动位置和选中行（按 clickableRows 中的 pos）；
    // 切换到其他文件时从存储的 scrollPositions 恢复
    const sameFile = context.lastDiffFile != null && context.lastDiffFile.path === file.path;
    const savedScroll = sameFile
      ? context.diffView.scrollTop
      : (context.scrollPositions[file.path] || 0);
    const savedFocusedCpos = sameFile ? currentFocusedCpos : 0;
    currentSelectedCpos = new Set();
    if (sameFile) {
      context.lastDiffRows.forEach((r, idx) => {
        if (r && r.row && r.row.classList.contains('line-selected')) {
          currentSelectedCpos.add(idx);
        }
      });
    }
    context.diffView.textContent = '';
    renderedHunkCount = 0;
    if (!file.hunks || !file.hunks.length) {
      context.diffView.appendChild(context.emptyState('该文件没有可展示的 diff 内容'));
      context.lastDiffFile = file;
      context.lastDiffRows = [];
      currentHunkStartCpos = [];
      currentFocusedCpos = 0;
      context.updateCollapseAllBtn();
      context.syncSelectionBar();
      return;
    }

    const offsets = computeDiffHunkOffsets(file);
    currentHunkStartCpos = offsets.hunkStartCpos;
    context.lastDiffFile = file;
    context.lastDiffRows = new Array(offsets.totalClickable);
    currentFocusedCpos = offsets.totalClickable > 0
      ? Math.max(0, Math.min(offsets.totalClickable - 1, savedFocusedCpos))
      : 0;

    const viewportH = context.diffView.clientHeight || 800;
    const requiredRowsForScroll = estimateRequiredRowsForScroll(savedScroll, viewportH);
    let maxSelectedHunk = -1;
    if (offsets.totalClickable > 0) {
      for (let hi = 0; hi < currentHunkStartCpos.length; hi += 1) {
        if (currentHunkStartCpos[hi] <= currentFocusedCpos) maxSelectedHunk = hi;
      }
    }
    if (currentSelectedCpos.size > 0) {
      const maxPos = Math.max(...currentSelectedCpos);
      for (let hi = 0; hi < currentHunkStartCpos.length; hi += 1) {
        if (currentHunkStartCpos[hi] <= maxPos && hi > maxSelectedHunk) maxSelectedHunk = hi;
      }
    }

    const initialPlan = planHunkRenderBatch({
      hunks: file.hunks,
      startHunkIndex: 0,
      rowBudget: INITIAL_DIFF_ROW_BUDGET,
      minTargetHunkIndex: maxSelectedHunk,
      minTargetRows: requiredRowsForScroll,
      isHunkCollapsed: (header) => context.isHunkCollapsed(file.path, header),
    });

    diffSentinel = context.el('div', { class: 'diff-lazy-sentinel', 'aria-hidden': 'true' });
    context.diffView.appendChild(diffSentinel);
    context.diffView.appendChild(context.selectionBar);

    renderHunkSliceUpTo(file, initialPlan.endHunkIndex);
    if (offsets.totalClickable > 0 && !context.lastDiffRows[currentFocusedCpos]) {
      const firstPopulated = context.lastDiffRows.findIndex(Boolean);
      if (firstPopulated >= 0) {
        setFocusedCpos(firstPopulated);
      }
    }

    if (savedScroll > 0 && renderedHunkCount < file.hunks.length) {
      while (
        renderedHunkCount < file.hunks.length
        && context.diffView.scrollHeight > 0
        && context.diffView.scrollHeight < savedScroll + viewportH
      ) {
        const nextPlan = planHunkRenderBatch({
          hunks: file.hunks,
          startHunkIndex: renderedHunkCount,
          rowBudget: CHUNK_DIFF_ROW_BUDGET,
          isHunkCollapsed: (header) => context.isHunkCollapsed(file.path, header),
        });
        renderHunkSliceUpTo(file, nextPlan.endHunkIndex);
      }
    }

    context.syncSelectionBar();

    // 恢复重渲染前或跨会话持久化的滚动位置
    restoringScroll = true;
    context.diffView.scrollTop = savedScroll;
    restoringScroll = false;

    if (renderedHunkCount < file.hunks.length) {
      const scheduleNextChunk = () => {
        diffChunkRaf = null;
        if (context.lastDiffFile !== file || renderedHunkCount >= file.hunks.length) return;
        const batch = planHunkRenderBatch({
          hunks: file.hunks,
          startHunkIndex: renderedHunkCount,
          rowBudget: CHUNK_DIFF_ROW_BUDGET,
          isHunkCollapsed: (header) => context.isHunkCollapsed(file.path, header),
        });
        renderHunkSliceUpTo(file, batch.endHunkIndex);
        if (renderedHunkCount < file.hunks.length) {
          diffChunkRaf = requestAnimationFrame(scheduleNextChunk);
        }
      };
      if (typeof IntersectionObserver === 'function' && diffSentinel) {
        diffSentinelObserver = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && context.lastDiffFile === file && renderedHunkCount < file.hunks.length) {
              const batch = planHunkRenderBatch({
                hunks: file.hunks,
                startHunkIndex: renderedHunkCount,
                rowBudget: CHUNK_DIFF_ROW_BUDGET,
                isHunkCollapsed: (header) => context.isHunkCollapsed(file.path, header),
              });
              renderHunkSliceUpTo(file, batch.endHunkIndex);
            }
          }
        }, { root: context.diffView, rootMargin: '300px 0px' });
        diffSentinelObserver.observe(diffSentinel);
      }
      diffChunkRaf = requestAnimationFrame(scheduleNextChunk);
    }

    context.updateCollapseAllBtn();
  };

  return {
  get renderDiff() { return renderDiff; },
  get cancelDiffLazy() { return cancelDiffLazy; },
  get currentSelectedCpos() { return currentSelectedCpos; },
  set currentSelectedCpos(value) { currentSelectedCpos = value; },
  get currentFocusedCpos() { return currentFocusedCpos; },
  get setFocusedCpos() { return setFocusedCpos; },
  get renderHunkSliceUpTo() { return renderHunkSliceUpTo; },
  get ensureHunksRenderedThrough() { return ensureHunksRenderedThrough; },
  get currentHunkStartCpos() { return currentHunkStartCpos; },
  set currentHunkStartCpos(value) { currentHunkStartCpos = value; },
  };
}

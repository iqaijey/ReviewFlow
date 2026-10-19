import { computeFileFingerprint } from '../../lib/overviewPerf.js';

export function createLineInteraction(context) {
  // ---------- diff 行交互：事件委托（行号列拖拽框选 vs 代码文本原生复制）----------
  const ensureClickableRangeRendered = (a, b) => {
    const file = context.lastDiffFile;
    if (!file || !Array.isArray(file.hunks) || !context.currentHunkStartCpos.length) return;
    const maxPos = Math.max(a, b);
    let targetHunk = 0;
    for (let hi = 0; hi < context.currentHunkStartCpos.length; hi += 1) {
      if (context.currentHunkStartCpos[hi] <= maxPos) targetHunk = hi;
    }
    for (let hi = Math.min(a, b) >= 0 ? 0 : 0; hi <= targetHunk; hi += 1) {
      const startCpos = context.currentHunkStartCpos[hi] || 0;
      const nextCpos = hi + 1 < context.currentHunkStartCpos.length
        ? context.currentHunkStartCpos[hi + 1]
        : context.lastDiffRows.length;
      if (nextCpos > Math.min(a, b) && startCpos <= maxPos) {
        context.ensureHunksRenderedThrough(file, hi, true);
      }
    }
  };

  const highlightRange = (a, b) => {
    ensureClickableRangeRendered(a, b);
    context.clearLineSelectionDOM();
    context.currentSelectedCpos = new Set();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
      context.currentSelectedCpos.add(i);
      const item = context.lastDiffRows[i];
      if (item && item.row) {
        item.row.classList.add('line-selected');
        item.row.setAttribute('aria-selected', 'true');
      }
    }
  };

  const syncPendingFromSelectedSet = () => {
    const file = context.lastDiffFile;
    if (!file) return;
    if (context.classSel.size) {
      context.classSel.clear();
      context.fileList.querySelectorAll('.class-chip.active').forEach((chip) => {
        chip.classList.remove('active');
        chip.setAttribute('aria-pressed', 'false');
      });
    }
    const sorted = [...context.currentSelectedCpos].sort((a, b) => a - b);
    if (!sorted.length) {
      context.pendingSelection = null;
      context.clearLineSelectionDOM();
      context.syncSelectionBar();
      return;
    }
    ensureClickableRangeRendered(sorted[0], sorted[sorted.length - 1]);
    context.clearLineSelectionDOM();
    context.currentSelectedCpos = new Set(sorted);
    const picked = [];
    for (const pos of sorted) {
      const item = context.lastDiffRows[pos];
      if (item && item.row) {
        item.row.classList.add('line-selected');
        item.row.setAttribute('aria-selected', 'true');
        picked.push(item);
      }
    }
    if (!picked.length) {
      context.pendingSelection = null;
      context.syncSelectionBar();
      return;
    }
    if (picked.length === 1) {
      const r = picked[0];
      context.pendingSelection = {
        file,
        hunkIndex: r.hunkIndex,
        line: r.line,
        lineIndex: r.lineIndex,
      };
    } else {
      const segments = [];
      for (const r of picked) {
        let seg = segments.find((s) => s.hunkIndex === r.hunkIndex);
        if (!seg) {
          seg = { file, hunkIndex: r.hunkIndex, hunk: file.hunks[r.hunkIndex], lines: [] };
          segments.push(seg);
        }
        seg.lines.push(r.line);
      }
      context.pendingSelection = { file, segments };
    }
    context.syncSelectionBar();
  };

  const selectRange = (a, b) => {
    const file = context.lastDiffFile;
    if (!file) return;
    if (context.classSel.size) {
      context.classSel.clear();
      context.fileList.querySelectorAll('.class-chip.active').forEach((chip) => {
        chip.classList.remove('active');
        chip.setAttribute('aria-pressed', 'false');
      });
    }
    highlightRange(a, b);
    const picked = context.lastDiffRows.slice(Math.min(a, b), Math.max(a, b) + 1).filter(Boolean);
    const segments = [];
    for (const r of picked) {
      let seg = segments.find((s) => s.hunkIndex === r.hunkIndex);
      if (!seg) {
        seg = { file, hunkIndex: r.hunkIndex, hunk: file.hunks[r.hunkIndex], lines: [] };
        segments.push(seg);
      }
      seg.lines.push(r.line);
    }
    context.pendingSelection = { file, segments };
    context.syncSelectionBar();
  };

  const selectSingle = (r) => {
    if (!r || !context.lastDiffFile) return;
    if (context.classSel.size) {
      context.classSel.clear();
      context.fileList.querySelectorAll('.class-chip.active').forEach((chip) => {
        chip.classList.remove('active');
        chip.setAttribute('aria-pressed', 'false');
      });
    }
    context.clearLineSelectionDOM();
    const cpos = Number(r.row.dataset.cpos);
    if (Number.isFinite(cpos) && typeof context.setFocusedCpos === 'function') {
      context.setFocusedCpos(cpos);
    }
    context.currentSelectedCpos = Number.isFinite(cpos) ? new Set([cpos]) : new Set();
    r.row.classList.add('line-selected');
    r.row.setAttribute('aria-selected', 'true');
    context.pendingSelection = {
      file: context.lastDiffFile,
      hunkIndex: r.hunkIndex,
      line: r.line,
      lineIndex: r.lineIndex,
    };
    context.syncSelectionBar();
  };

  const focusChangedRowAt = (targetPos) => {
    const total = context.lastDiffRows ? context.lastDiffRows.length : 0;
    if (!total || !context.lastDiffFile) return null;
    const clamped = Math.max(0, Math.min(total - 1, targetPos));
    ensureClickableRangeRendered(clamped, clamped);
    const row = typeof context.setFocusedCpos === 'function'
      ? context.setFocusedCpos(clamped)
      : (context.lastDiffRows[clamped] && context.lastDiffRows[clamped].row);
    if (row) {
      if (typeof row.scrollIntoView === 'function') {
        row.scrollIntoView({ block: 'nearest' });
      }
      if (typeof row.focus === 'function') {
        row.focus();
      }
    }
    return row;
  };

  /** @type {{ start: number, end: number, moved: boolean } | null} */
  let gutterDrag = null;
  /** @type {{ x: number, y: number, pos: number, alt: boolean } | null} */
  let contentPointer = null;
  let suppressNextLineCopyClick = false;
  window.addEventListener('blur', () => {
    gutterDrag = null;
    contentPointer = null;
  });

  context.diffView.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return;
    const target = /** @type {HTMLElement | null} */ (ev.target);
    if (!target || target.closest('.diff-selection-bar')) return;
    const rowEl = /** @type {HTMLElement | null} */ (target.closest('.diff-line'));
    if (!rowEl || !context.lastDiffFile) return;

    const inGutter = Boolean(target.closest('.line-no-copy'));
    if (inGutter) {
      if (rowEl.dataset.cpos == null) return;
      // 行号列按下：支持上下拖动框选多行改动，未移动则交由 click 复制该行
      ev.preventDefault();
      const pos = Number(rowEl.dataset.cpos);
      const file = context.lastDiffFile;
      if (ev.altKey && context.state.selAnchor && context.state.selAnchor.file === file) {
        suppressNextLineCopyClick = true;
        selectRange(context.state.selAnchor.pos, pos);
        return;
      }
      gutterDrag = { start: pos, end: pos, moved: false };
      const onUp = () => {
        document.removeEventListener('mouseup', onUp);
        if (!gutterDrag) return;
        const { start, end, moved } = gutterDrag;
        gutterDrag = null;
        if (moved) {
          suppressNextLineCopyClick = true;
          context.state.selAnchor = { file, pos: start };
          if (typeof context.setFocusedCpos === 'function') {
            context.setFocusedCpos(end);
          }
          selectRange(start, end);
        }
      };
      document.addEventListener('mouseup', onUp);
      return;
    }

    // 代码正文区域：允许浏览器原生拖动选字复制（不调 preventDefault）；
    // 若只是点击（未拖动产生文字选区），则在 mouseup 时选中该改动行（或 ⌥+点击扩选范围）
    if (rowEl.dataset.cpos == null) return;
    const pos = Number(rowEl.dataset.cpos);
    contentPointer = { x: ev.clientX, y: ev.clientY, pos, alt: ev.altKey };
    const file = context.lastDiffFile;
    const onUp = (/** @type {MouseEvent} */ upEv) => {
      document.removeEventListener('mouseup', onUp);
      if (!contentPointer) return;
      const { x, y, pos: startPos, alt } = contentPointer;
      contentPointer = null;
      const dist = Math.hypot(upEv.clientX - x, upEv.clientY - y);
      const nativeSel = window.getSelection();
      if (dist > 4 && nativeSel && !nativeSel.isCollapsed && String(nativeSel).length > 0) {
        // 用户在代码内拖动选中了文本，保持原生文字选区供 ⌘C 复制
        return;
      }
      if (alt && context.state.selAnchor && context.state.selAnchor.file === file) {
        if (typeof context.setFocusedCpos === 'function') {
          context.setFocusedCpos(startPos);
        }
        selectRange(context.state.selAnchor.pos, startPos);
      } else {
        context.state.selAnchor = { file, pos: startPos };
        selectSingle(context.lastDiffRows[startPos]);
      }
    };
    document.addEventListener('mouseup', onUp);
  });

  context.diffView.addEventListener('mouseover', (ev) => {
    if (!gutterDrag) return;
    const target = /** @type {HTMLElement | null} */ (ev.target);
    const rowEl = /** @type {HTMLElement | null} */ (target && target.closest('.diff-line'));
    if (!rowEl || rowEl.dataset.cpos == null) return;
    const pos = Number(rowEl.dataset.cpos);
    if (pos !== gutterDrag.end) {
      gutterDrag.moved = true;
      gutterDrag.end = pos;
      highlightRange(gutterDrag.start, pos);
    }
  });

  // 行号列点击复制该行内容（若刚完成行号拖拽框选则跳过复制）
  context.diffView.addEventListener('click', (ev) => {
    const target = /** @type {HTMLElement | null} */ (ev.target);
    const cell = /** @type {HTMLElement | null} */ (target && target.closest('.line-no-copy'));
    if (!cell || !context.lastDiffFile) return;
    if (suppressNextLineCopyClick) {
      suppressNextLineCopyClick = false;
      return;
    }
    const rowEl = cell.closest('.diff-line');
    if (!(rowEl instanceof HTMLElement) || !rowEl.dataset.lref) return;
    const [hunkIndex, lineIndex] = rowEl.dataset.lref.split(':').map(Number);
    const line = context.lastDiffFile.hunks[hunkIndex] && context.lastDiffFile.hunks[hunkIndex].lines[lineIndex];
    if (!line) return;
    navigator.clipboard.writeText(line.content)
      .then(() => { if (context.toast) context.toast('已复制该行'); })
      .catch(() => context.toast('复制失败，请重试', 'error'));
  });

  context.diffView.addEventListener('focusin', (ev) => {
    const target = /** @type {HTMLElement | null} */ (ev.target);
    if (!target || !target.classList || !target.classList.contains('line-clickable')) return;
    const pos = Number(target.dataset.cpos);
    if (Number.isFinite(pos) && typeof context.setFocusedCpos === 'function') {
      context.setFocusedCpos(pos);
    }
  });

  context.diffView.addEventListener('keydown', (ev) => {
    if (document.querySelector('.modal-overlay, .palette-overlay')) return;
    const target = /** @type {HTMLElement | null} */ (ev.target);
    if (!target || !target.classList || !target.classList.contains('line-clickable')) return;
    if (!context.lastDiffFile || !context.lastDiffRows.length) return;
    const curPos = Number.isFinite(Number(target.dataset.cpos))
      ? Number(target.dataset.cpos)
      : (context.currentFocusedCpos || 0);
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      ev.preventDefault();
      const step = ev.key === 'ArrowDown' ? 1 : -1;
      const nextPos = Math.max(0, Math.min(context.lastDiffRows.length - 1, curPos + step));
      if (ev.shiftKey) {
        if (!context.state.selAnchor || context.state.selAnchor.file !== context.lastDiffFile) {
          context.state.selAnchor = { file: context.lastDiffFile, pos: curPos };
        }
        focusChangedRowAt(nextPos);
        selectRange(context.state.selAnchor.pos, nextPos);
      } else {
        focusChangedRowAt(nextPos);
      }
      return;
    }
    if (ev.key === ' ' && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      ev.preventDefault();
      const nextSet = new Set(context.currentSelectedCpos);
      if (nextSet.has(curPos)) {
        nextSet.delete(curPos);
      } else {
        nextSet.add(curPos);
        context.state.selAnchor = { file: context.lastDiffFile, pos: curPos };
      }
      context.currentSelectedCpos = nextSet;
      syncPendingFromSelectedSet();
      return;
    }
    if (ev.key === 'Enter' && !ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey) {
      ev.preventDefault();
      if (!context.pendingSelection && context.lastDiffRows[curPos]) {
        context.state.selAnchor = { file: context.lastDiffFile, pos: curPos };
        selectSingle(context.lastDiffRows[curPos]);
      }
      if (context.pendingSelection) {
        context.triggerExplicitExplain();
      }
    }
  });

  // 键盘流：⌘E 解析选区、Escape 清除选区、j/k 上下移动文件、⌘F 聚焦搜索（仅本 tab 可见时）
  document.addEventListener('keydown', (ev) => {
    if (context.container.hidden) return;
    // 存在弹窗/命令面板时不抢占快捷键
    if (document.querySelector('.modal-overlay, .palette-overlay')) return;
    const t = /** @type {HTMLElement | null} */ (ev.target);
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (ev.metaKey && !ev.shiftKey && !ev.altKey && !ev.ctrlKey && ev.key.toLowerCase() === 'e') {
      if (context.pendingSelection) {
        ev.preventDefault();
        context.triggerExplicitExplain();
      }
      return;
    }
    if (ev.metaKey && !ev.shiftKey && !ev.altKey && !ev.ctrlKey && ev.key.toLowerCase() === 'f') {
      ev.preventDefault();
      context.searchInput.focus();
      context.searchInput.select();
      return;
    }
    if (ev.key === 'Escape' && !ev.metaKey && !ev.ctrlKey && !ev.altKey && !typing) {
      if (context.pendingSelection || context.currentSelectedCpos.size || context.diffView.querySelector('.line-selected, [aria-selected="true"]')) {
        ev.preventDefault();
        context.clearAllSelection();
      }
      return;
    }
    if (typing || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    if (ev.key !== 'j' && ev.key !== 'k') return;
    if (!context.filteredFiles.length) return;
    ev.preventDefault();
    const idx = context.state.selectedFile ? context.filteredFiles.indexOf(context.state.selectedFile) : -1;
    const next = ev.key === 'j'
      ? Math.min(context.filteredFiles.length - 1, (idx < 0 ? -1 : idx) + 1)
      : Math.max(0, (idx < 0 ? context.filteredFiles.length : idx) - 1);
    const nextFile = context.filteredFiles[next];
    if (!nextFile) return;
    context.ensureFileItemRendered(nextFile);
    const nextEntry = context.fileItems.find((x) => x.file === nextFile);
    context.selectFile(nextFile, nextEntry ? nextEntry.item : undefined);
  });

  // 搜索框内 Esc：清空并失焦
  context.searchInput.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (context.searchInput.value) {
      context.searchInput.value = '';
      context.searchInput.dispatchEvent(new Event('input'));
    }
    context.searchInput.blur();
  });

  return { syncPendingFromSelectedSet };
}

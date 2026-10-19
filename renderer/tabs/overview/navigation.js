import { computeFileFingerprint, matchesFileSearch, findNextUnreadFile } from '../../lib/overviewPerf.js';

const WORKTREE_MODES = new Set(['staged', 'unstaged', 'untracked']);

export function createNavigation(context) {
  // ⌘K 面板「跳转文件」：选中文件、渲染 diff、滚动到列表项
  context.bus.addEventListener('file:jump', (ev) => {
    const path = ev.detail;
    const target = (context.state.changes && Array.isArray(context.state.changes.files))
      ? context.state.changes.files.find((f) => f && f.path === path)
      : null;
    if (!target) return;
    if (context.searchQuery && !matchesFileSearch(context.searchIndex, target, context.searchQuery)) {
      if (context.searchTimer) {
        clearTimeout(context.searchTimer);
        context.searchTimer = null;
      }
      context.searchInput.value = '';
      context.searchQuery = '';
      context.persistProjectPatch({ searchText: '' });
      context.renderFileList(context.state.changes);
    }
    context.ensureFileItemRendered(target);
    const entry = context.fileItems.find((x) => x.file === target);
    context.selectFile(target, entry ? entry.item : undefined);
  });

  const stepSelectedFileHunk = (direction) => {
    const file = context.state.selectedFile;
    if (!file || !Array.isArray(file.hunks) || !file.hunks.length) return;
    context.renderHunkSliceUpTo(file, file.hunks.length);
    const headers = /** @type {HTMLElement[]} */ ([...context.diffView.querySelectorAll('.diff-hunk > .hunk-header')]);
    if (!headers.length) return;
    const activeEl = document.activeElement;
    const focusedIdx = activeEl instanceof HTMLElement ? headers.indexOf(activeEl) : -1;
    let nextIdx = 0;
    if (focusedIdx >= 0) {
      nextIdx = direction > 0
        ? (focusedIdx + 1) % headers.length
        : (focusedIdx - 1 + headers.length) % headers.length;
    } else {
      const viewTop = context.diffView.getBoundingClientRect().top;
      if (direction > 0) {
        const found = headers.findIndex((h) => h.getBoundingClientRect().top > viewTop + 12);
        nextIdx = found >= 0 ? found : 0;
      } else {
        let found = -1;
        for (let i = headers.length - 1; i >= 0; i -= 1) {
          if (headers[i].getBoundingClientRect().top < viewTop - 4) {
            found = i;
            break;
          }
        }
        nextIdx = found >= 0 ? found : headers.length - 1;
      }
    }
    const targetHeader = headers[nextIdx];
    if (targetHeader) {
      targetHeader.scrollIntoView({ block: 'nearest' });
      targetHeader.focus();
    }
  };

  const jumpToNextUnreadFile = () => {
    const allFiles = context.state.changes && Array.isArray(context.state.changes.files) ? context.state.changes.files : [];
    if (!allFiles.length) {
      context.toast('没有未读文件', 'info');
      return;
    }
    const pool = context.filteredFiles.length ? context.filteredFiles : allFiles;
    let nextFile = findNextUnreadFile(pool, context.state.selectedFile, context.readMarkers);
    if (!nextFile && pool !== allFiles) {
      nextFile = findNextUnreadFile(allFiles, context.state.selectedFile, context.readMarkers);
      if (nextFile && context.searchQuery) {
        if (context.searchTimer) {
          clearTimeout(context.searchTimer);
          context.searchTimer = null;
        }
        context.searchInput.value = '';
        context.searchQuery = '';
        context.persistProjectPatch({ searchText: '' });
        context.renderFileList(context.state.changes);
      }
    }
    if (!nextFile) {
      context.toast('没有未读文件', 'info');
      return;
    }
    context.ensureFileItemRendered(nextFile);
    const entry = context.fileItems.find((x) => x.file === nextFile);
    context.selectFile(nextFile, entry ? entry.item : undefined);
    if (entry && entry.item) {
      entry.item.focus();
    }
  };

  context.bus.addEventListener('overview:command', (ev) => {
    const detail = /** @type {CustomEvent} */ (ev).detail || {};
    const action = detail.action;
    if (action === 'nextHunk') {
      stepSelectedFileHunk(1);
    } else if (action === 'prevHunk') {
      stepSelectedFileHunk(-1);
    } else if (action === 'nextUnread') {
      jumpToNextUnreadFile();
    } else if (action === 'setSource') {
      const mode = String(detail.mode || '');
      if (!context.state.folder || context.switchingBase) return;
      if (mode === 'uncommitted') {
        context.hideCustomBaseInput(false);
        context.applyBase('');
      } else if (WORKTREE_MODES.has(mode)) {
        context.hideCustomBaseInput(false);
        context.applyBase(mode);
      }
    }
  });

  const clearJumpHighlight = () => {
    context.diffView.querySelectorAll('.diff-line.line-jump-target')
      .forEach((n) => n.classList.remove('line-jump-target'));
  };

  const resolveJumpRefs = (file, location) => {
    const side = location.side === 'old' ? 'old' : 'new';
    const lineProp = side === 'old' ? 'oldLine' : 'newLine';
    const hunks = Array.isArray(file.hunks) ? file.hunks : [];
    const flat = [];
    hunks.forEach((hunk, hunkIndex) => {
      (hunk.lines || []).forEach((line, lineIndex) => {
        if (Number.isSafeInteger(line[lineProp])) {
          flat.push({ hunkIndex, lineIndex, lineNo: line[lineProp], content: String(line.content || '') });
        }
      });
    });

    const anchor = location.anchor && Array.isArray(location.anchor.target) && location.anchor.target.length
      ? location.anchor
      : null;

    if (location.startLine != null) {
      const startLine = location.startLine;
      const endLine = location.endLine != null && location.endLine >= startLine
        ? location.endLine
        : startLine;
      const exact = flat.filter((r) => r.lineNo >= startLine && r.lineNo <= endLine);
      if (exact.some((r) => r.lineNo === startLine)) {
        if (!anchor || anchor.target.every((t, idx) => exact[idx] && exact[idx].content === t)) {
          return exact.map((r) => ({ hunkIndex: r.hunkIndex, lineIndex: r.lineIndex }));
        }
      }
    }

    if (!anchor) return [];
    const targetLen = anchor.target.length;
    const before = Array.isArray(anchor.before) ? anchor.before : [];
    const after = Array.isArray(anchor.after) ? anchor.after : [];
    const candidates = [];
    for (let i = 0; i + targetLen <= flat.length; i += 1) {
      const slice = flat.slice(i, i + targetLen);
      if (!anchor.target.every((t, idx) => slice[idx].content === t)) continue;
      const beforeOk = before.every((b, idx) => {
        const pos = i - before.length + idx;
        return pos >= 0 && flat[pos] && flat[pos].content === b;
      });
      const afterOk = after.every((a, idx) => {
        const pos = i + targetLen + idx;
        return pos < flat.length && flat[pos] && flat[pos].content === a;
      });
      candidates.push({ refs: slice.map((r) => ({ hunkIndex: r.hunkIndex, lineIndex: r.lineIndex })), contextMatch: beforeOk && afterOk });
    }
    if (candidates.length === 1) return candidates[0].refs;
    const withContext = candidates.filter((c) => c.contextMatch);
    if (withContext.length === 1) return withContext[0].refs;
    return [];
  };

  context.bus.addEventListener('diff:jump:ready', (ev) => {
    const detail = /** @type {CustomEvent} */ (ev).detail || {};
    const location = detail.location;
    clearJumpHighlight();
    if (!context.state.changes || !Array.isArray(context.state.changes.files) || !location || !location.path) {
      context.toast('位置已变化/当前 diff 不含此行', 'info');
      return;
    }
    const targetFile = context.state.changes.files.find((f) =>
      f && (f.path === location.path || f.oldPath === location.path));
    if (!targetFile) {
      context.toast('位置已变化/当前 diff 不含此行', 'info');
      return;
    }
    if (context.searchQuery && !matchesFileSearch(context.searchIndex, targetFile, context.searchQuery)) {
      if (context.searchTimer) {
        clearTimeout(context.searchTimer);
        context.searchTimer = null;
      }
      context.searchInput.value = '';
      context.searchQuery = '';
      context.persistProjectPatch({ searchText: '' });
      context.renderFileList(context.state.changes);
    }
    context.ensureFileItemRendered(targetFile);
    const entry = context.fileItems.find((x) => x.file === targetFile);
    context.selectFile(targetFile, entry ? entry.item : undefined);

    const refs = resolveJumpRefs(targetFile, location);
    if (!refs.length) {
      context.toast('位置已变化/当前 diff 不含此行', 'info');
      return;
    }
    for (const { hunkIndex } of refs) {
      context.ensureHunksRenderedThrough(targetFile, hunkIndex, true);
    }
    /** @type {HTMLElement | null} */
    let firstRow = null;
    for (const { hunkIndex, lineIndex } of refs) {
      const row = /** @type {HTMLElement | null} */ (
        context.diffView.querySelector(`.diff-line[data-lref="${hunkIndex}:${lineIndex}"]`)
      );
      if (row) {
        row.classList.add('line-jump-target');
        if (!firstRow) firstRow = row;
      }
    }
    if (!firstRow) {
      context.toast('位置已变化/当前 diff 不含此行', 'info');
      return;
    }
    firstRow.scrollIntoView({ block: 'center' });
  });

}

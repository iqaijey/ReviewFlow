import { FILE_LIST_INCREMENTAL_THRESHOLD, FILE_LIST_INITIAL_BATCH, FILE_LIST_BATCH_SIZE, computeFileFingerprint, filterFilesWithIndex } from '../../lib/overviewPerf.js';

const STATUS_LABEL = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R' };

const fallbackFileFingerprint = computeFileFingerprint;

export function createFileList(context) {
  // ---------- 文件列表 ----------
  /** @type {{ file: any, item: HTMLElement }[]} 当前渲染的有序文件项，供 j/k 键盘导航与 ⌘K 跳转复用 */
  let fileItems = [];
  /** @type {any[]} */
  let filteredFiles = [];
  let renderedFileCount = 0;
  /** @type {number | null} */
  let fileListChunkRaf = null;
  /** @type {IntersectionObserver | null} */
  let fileListObserver = null;
  /** @type {HTMLElement | null} */
  let fileListSentinel = null;

  const cancelFileListLazy = () => {
    if (fileListChunkRaf != null) {
      cancelAnimationFrame(fileListChunkRaf);
      fileListChunkRaf = null;
    }
    if (fileListObserver) {
      fileListObserver.disconnect();
      fileListObserver = null;
    }
    if (fileListSentinel) {
      fileListSentinel.remove();
      fileListSentinel = null;
    }
  };

  const buildFileRowElement = (file) => {
    const isRead = context.isFileRead(file);
    const isActive = context.state.selectedFile === file;
    const item = context.el('div', {
      class: 'file-item',
      role: 'option',
      tabindex: isActive ? '0' : '-1',
      'aria-selected': isActive ? 'true' : 'false',
    });
    if (isRead) item.classList.add('file-read');
    if (file.excluded) item.classList.add('file-excluded');
    if (isActive) item.classList.add('active');
    item.appendChild(context.el('span', { class: `status-badge status-${file.status}` },
      STATUS_LABEL[file.status] || file.status));
    const info = context.el('div', { class: 'file-item-info' });
    const slash = file.path.lastIndexOf('/');
    const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
    const dir = slash >= 0 ? file.path.slice(0, slash + 1) : '';
    info.appendChild(context.el('div', { class: 'file-name', title: file.path }, name));
    if (dir) info.appendChild(context.el('div', { class: 'file-dir', title: file.path }, dir));
    const changedClasses = (file.classes || []).filter((c) => c.changed);
    if (changedClasses.length) {
      const chips = context.el('div', { class: 'file-changed-names' });
      for (const c of changedClasses) {
        const isChipActive = context.classSel.has(context.classKey(file, c));
        const chip = context.el('button', {
          class: `class-chip${isChipActive ? ' active' : ''}`,
          type: 'button',
          title: '点击选择该类/函数（可多选，按 ⌘E 解析）',
          'aria-pressed': isChipActive ? 'true' : 'false',
        }, context.classLabel(c));
        chip.addEventListener('click', (ev) => {
          ev.stopPropagation();
          context.toggleClass(file, c, chip);
        });
        chips.appendChild(chip);
      }
      info.appendChild(chips);
    }
    item.appendChild(info);
    if (file.excluded) {
      const reason = file.excludedBy
        ? `匹配排除规则：${file.excludedBy}（不参与 AI 评审）`
        : '已按规则排除（不参与 AI 评审）';
      item.appendChild(context.el('span', {
        class: 'excluded-badge',
        title: reason,
      }, '已排除'));
      const aiBtn = /** @type {HTMLButtonElement} */ (context.el('button', {
        class: 'read-btn',
        type: 'button',
        disabled: 'disabled',
        title: reason,
      }, 'AI'));
      item.appendChild(aiBtn);
    } else if (file.resource) {
      item.appendChild(context.el('span', {
        class: 'status-badge', title: '资源文件不参与 AI 评审',
      }, '资源'));
    } else {
      const aiBtn = context.el('button', {
        class: 'read-btn', type: 'button', title: '在「多角度 Review」中逐文件分析',
      }, 'AI');
      aiBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        context.state.pendingAnalyzeFile = file;
        context.bus.dispatchEvent(new CustomEvent('file:analyze'));
      });
      item.appendChild(aiBtn);
    }
    const readBtn = context.el('button', { class: 'read-btn', type: 'button' },
      isRead ? '取消已读' : '已读');
    readBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (context.isFileRead(file)) delete context.readMarkers[file.path];
      else context.readMarkers[file.path] = fallbackFileFingerprint(file);
      context.persistProjectPatch({ readMarkers: { ...context.readMarkers } });
      const nowRead = context.isFileRead(file);
      item.classList.toggle('file-read', nowRead);
      readBtn.textContent = nowRead ? '取消已读' : '已读';
      context.updateReadStat();
    });
    item.appendChild(readBtn);
    item.addEventListener('click', () => {
      selectFile(file, item);
    });
    item.addEventListener('keydown', (ev) => {
      if (ev.target !== item) return;
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        selectFile(file, item);
        item.focus();
        return;
      }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        const curIdx = filteredFiles.indexOf(file);
        if (curIdx < 0) return;
        const nextIdx = ev.key === 'ArrowDown'
          ? Math.min(filteredFiles.length - 1, curIdx + 1)
          : Math.max(0, curIdx - 1);
        const nextFile = filteredFiles[nextIdx];
        if (!nextFile) return;
        ensureFileItemRendered(nextFile);
        const nextEntry = fileItems.find((x) => x.file === nextFile);
        selectFile(nextFile, nextEntry ? nextEntry.item : undefined);
        if (nextEntry && nextEntry.item) {
          nextEntry.item.focus();
        }
      }
    });
    return item;
  };

  const appendFileListSlice = (endIdx) => {
    const targetEnd = Math.min(filteredFiles.length, Math.max(renderedFileCount, endIdx));
    if (targetEnd <= renderedFileCount) return;
    const frag = document.createDocumentFragment();
    for (let i = renderedFileCount; i < targetEnd; i += 1) {
      const file = filteredFiles[i];
      const item = buildFileRowElement(file);
      fileItems.push({ file, item });
      frag.appendChild(item);
    }
    if (fileListSentinel && fileListSentinel.parentNode === context.fileList) {
      context.fileList.insertBefore(frag, fileListSentinel);
    } else {
      context.fileList.appendChild(frag);
    }
    renderedFileCount = targetEnd;
    if (renderedFileCount >= filteredFiles.length) {
      cancelFileListLazy();
    }
  };

  const ensureFileItemRendered = (file) => {
    if (!file) return;
    const existing = fileItems.find((x) => x.file === file);
    if (existing) return;
    const idx = filteredFiles.indexOf(file);
    if (idx >= 0 && idx >= renderedFileCount) {
      appendFileListSlice(idx + FILE_LIST_BATCH_SIZE);
    }
  };

  const selectFile = (file, item) => {
    if (context.lastDiffFile && context.lastDiffFile.path) {
      context.scrollPositions[context.lastDiffFile.path] = Math.round(context.diffView.scrollTop);
    }
    context.state.selectedFile = file;
    context.persistProjectPatch({
      selectedFilePath: file ? file.path : null,
      scrollPositions: { ...context.scrollPositions },
    });
    ensureFileItemRendered(file);
    context.fileList.querySelectorAll('.file-item.active').forEach((n) => {
      n.classList.remove('active');
      n.setAttribute('aria-selected', 'false');
      n.setAttribute('tabindex', '-1');
    });
    const node = item || (fileItems.find((x) => x.file === file) || {}).item;
    if (node) {
      node.classList.add('active');
      node.setAttribute('aria-selected', 'true');
      node.setAttribute('tabindex', '0');
      node.scrollIntoView({ block: 'nearest' });
    }
    if (context.pendingSelection && !context.pendingSelection.classSelection && context.pendingSelection.file !== file) {
      context.pendingSelection = null;
      context.state.selAnchor = null;
    }
    context.renderDiff(file);
    context.applySearchHighlight(false);
  };

  const renderFileList = (changes) => {
    cancelFileListLazy();
    context.fileList.textContent = '';
    fileItems = [];
    filteredFiles = [];
    renderedFileCount = 0;
    if (!changes || !Array.isArray(changes.files)) return;
    filteredFiles = filterFilesWithIndex(context.searchIndex, changes.files, context.searchQuery);
    if (!filteredFiles.length) return;

    const total = filteredFiles.length;
    if (total <= FILE_LIST_INCREMENTAL_THRESHOLD) {
      appendFileListSlice(total);
    } else {
      const selectedIdx = context.state.selectedFile ? filteredFiles.indexOf(context.state.selectedFile) : -1;
      const firstBatchEnd = Math.max(
        FILE_LIST_INITIAL_BATCH,
        selectedIdx >= 0 ? selectedIdx + 20 : 0,
      );
      fileListSentinel = context.el('div', { class: 'file-list-sentinel', 'aria-hidden': 'true' });
      context.fileList.appendChild(fileListSentinel);
      appendFileListSlice(firstBatchEnd);

      if (renderedFileCount < total) {
        if (typeof IntersectionObserver === 'function') {
          fileListObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) {
                appendFileListSlice(renderedFileCount + FILE_LIST_BATCH_SIZE);
              }
            }
          }, { root: context.fileList, rootMargin: '200px 0px' });
          if (fileListSentinel) fileListObserver.observe(fileListSentinel);
        }
        const pumpFileChunk = () => {
          fileListChunkRaf = null;
          if (renderedFileCount >= filteredFiles.length) return;
          appendFileListSlice(renderedFileCount + FILE_LIST_BATCH_SIZE);
          if (renderedFileCount < filteredFiles.length) {
            fileListChunkRaf = requestAnimationFrame(pumpFileChunk);
          }
        };
        fileListChunkRaf = requestAnimationFrame(pumpFileChunk);
      }
    }

    if (fileItems.length && !fileItems.some((x) => x.file === context.state.selectedFile)) {
      fileItems[0].item.setAttribute('tabindex', '0');
    }
  };

  return {
  get cancelFileListLazy() { return cancelFileListLazy; },
  get renderFileList() { return renderFileList; },
  get ensureFileItemRendered() { return ensureFileItemRendered; },
  get fileItems() { return fileItems; },
  set fileItems(value) { fileItems = value; },
  get selectFile() { return selectFile; },
  get filteredFiles() { return filteredFiles; },
  set filteredFiles(value) { filteredFiles = value; },
  };
}

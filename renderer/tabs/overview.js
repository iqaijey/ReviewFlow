// 改动总览：基准选择 + 搜索 + 文件列表 + diff 视图，点击行派发 'line:select'
const STATUS_LABEL = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R' };
const CUSTOM_BASE = '__custom__';
const COMMITS_BASE = '__commits__';

export default {
  id: 'overview',
  title: '改动总览',

  mount(container, ctx) {
    const { el, bus, state, api, errText, toast } = ctx;

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
    toolbar.appendChild(searchInput);
    // 对当前选中文件的所有 hunk 一键折叠/展开
    const collapseAllBtn = el('button', { class: 'btn', type: 'button' }, '全部折叠');
    collapseAllBtn.disabled = true;
    toolbar.appendChild(collapseAllBtn);

    const body = el('div', { class: 'overview-body' });
    const fileList = el('div', { class: 'file-list' });
    const splitter = el('div', { class: 'splitter' });
    const diffView = el('div', { class: 'diff-view' });
    body.appendChild(fileList);
    body.appendChild(splitter);
    body.appendChild(diffView);
    container.appendChild(statsBar);

    // 拖动分隔条调整文件列表宽度，持久化到设置文件
    const MIN_LIST_W = 160;
    fileList.style.width = '300px';
    api.getSettings().then((s) => {
      if (s && Number(s.overviewWidth) >= MIN_LIST_W) {
        fileList.style.width = `${Number(s.overviewWidth)}px`;
      }
    }).catch(() => {});
    splitter.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      splitter.classList.add('active');
      const startX = ev.clientX;
      const startW = fileList.getBoundingClientRect().width;
      const onMove = (e) => {
        const max = body.getBoundingClientRect().width - 240;
        const w = Math.min(Math.max(startW + e.clientX - startX, MIN_LIST_W), max);
        fileList.style.width = `${w}px`;
      };
      const onUp = () => {
        splitter.classList.remove('active');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const w = Math.round(fileList.getBoundingClientRect().width);
        api.saveSettings({ overviewWidth: w }).catch(() => {});
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    container.appendChild(toolbar);
    container.appendChild(body);

    const readSet = new Set(); // 已读文件（按 path），切换项目时清空
    let collapsed = new Set(); // 折叠的 hunk，key = `${file.path}#${hunkIndex}`
    let knownFolder = null;
    let searchQuery = '';
    /** @type {HTMLElement | null} */
    let readStatEl = null;
    let branchInfo = { current: '', branches: [] };
    /** @type {any} */
    let lastDiffFile = null; // 上次渲染 diff 的文件，用于重渲染时恢复滚动与选中行
    let lastDiffRows = [];

    // 无选中文件（或文件无 hunk）时禁用；全部已折叠时切换为「全部展开」
    const updateCollapseAllBtn = () => {
      const file = state.selectedFile;
      const hunks = file && Array.isArray(file.hunks) ? file.hunks : [];
      collapseAllBtn.disabled = !hunks.length;
      const allCollapsed = hunks.length > 0 &&
        hunks.every((_, i) => collapsed.has(`${file.path}#${i}`));
      collapseAllBtn.textContent = allCollapsed ? '全部展开' : '全部折叠';
    };
    collapseAllBtn.addEventListener('click', () => {
      const file = state.selectedFile;
      if (!file || !file.hunks.length) return;
      const allCollapsed = file.hunks.every((_, i) => collapsed.has(`${file.path}#${i}`));
      file.hunks.forEach((_, i) => {
        const key = `${file.path}#${i}`;
        if (allCollapsed) collapsed.delete(key);
        else collapsed.add(key);
      });
      renderDiff(file);
      applySearchHighlight(false);
    });

    const showEmpty = (text) => {
      statsBar.textContent = '';
      fileList.textContent = '';
      diffView.textContent = '';
      collapseAllBtn.disabled = true;
      lastDiffFile = null;
      lastDiffRows = [];
      const hint = el('div', { class: 'empty-hint' });
      hint.innerHTML =
        '<svg class="empty-icon" width="44" height="44" viewBox="0 0 24 24" fill="none" ' +
        'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>' +
        '<path d="M18 9a9 9 0 0 1-9 9"/></svg>' +
        `<div></div>`;
      hint.lastElementChild.textContent = text;
      diffView.appendChild(hint);
    };

    // ---------- 按类选择（逐句解析用） ----------
    const classSel = new Map(); // key: `${file.path}#${name}#${startLine}` → { file, cls }
    const classKey = (file, c) => `${file.path}#${c.name}#${c.startLine}`;

    const classLabel = (c) => (c.kind === 'class' ? `class ${c.name}` : `${c.name}()`);

    // 类范围内的改动行（add/del），newLine 优先、del 行退回 oldLine 近似判断
    const classChangedLines = (file, c) => {
      const inRange = (n) => n != null && n >= c.startLine && n <= c.endLine;
      const segs = [];
      for (const hunk of file.hunks) {
        const lines = hunk.lines.filter((l) =>
          (l.type === 'add' || l.type === 'del') &&
          (inRange(l.newLine) || inRange(l.oldLine)));
        if (lines.length) segs.push({ hunk, lines });
      }
      return segs;
    };

    const dispatchClassSelection = () => {
      if (!classSel.size) return;
      const segments = [];
      for (const { file, cls } of classSel.values()) {
        for (const seg of classChangedLines(file, cls)) {
          segments.push({
            file,
            classInfo: cls,
            hunk: {
              header: `${classLabel(cls)} · ${file.path}:${cls.startLine}-${cls.endLine}`,
              lines: seg.hunk.lines,
            },
            lines: seg.lines,
          });
        }
      }
      if (!segments.length) return;
      state.selectedLine = { classSelection: true, segments };
      bus.dispatchEvent(new CustomEvent('line:select', { detail: state.selectedLine }));
    };

    const toggleClass = (file, c, chip) => {
      const key = classKey(file, c);
      if (classSel.has(key)) {
        classSel.delete(key);
        chip.classList.remove('active');
      } else {
        classSel.set(key, { file, cls: c });
        chip.classList.add('active');
      }
      dispatchClassSelection();
    };

    const updateReadStat = () => {
      if (readStatEl) readStatEl.textContent = `已读 ${readSet.size}`;
    };

    const renderStats = (changes) => {
      const files = changes.files;
      const classCount = files.reduce(
        (n, f) => n + f.classes.filter((c) => c.changed).length, 0);
      let add = 0, del = 0;
      for (const f of files)
        for (const h of f.hunks)
          for (const l of h.lines) {
            if (l.type === 'add') add++;
            else if (l.type === 'del') del++;
          }
      statsBar.textContent = '';
      statsBar.appendChild(el('span', { class: 'stat-item' }, `共 ${files.length} 个文件改动`));
      statsBar.appendChild(el('span', { class: 'stat-item' }, `${classCount} 个类/函数受影响`));
      statsBar.appendChild(el('span', { class: 'stat-item stat-add' }, `+${add}`));
      statsBar.appendChild(el('span', { class: 'stat-item stat-del' }, `-${del}`));
      readStatEl = el('span', { class: 'stat-item stat-read' }, `已读 ${readSet.size}`);
      statsBar.appendChild(readStatEl);
      statsBar.appendChild(el('span', { class: 'stat-item stat-hint' },
        '点击改动行 AI 解析 · 拖动或 ⌥+点击框选多行 · 点击类名按类解析'));
    };

    // ---------- 基准选择 ----------
    const rebuildBaseOptions = () => {
      baseSelect.textContent = '';
      baseSelect.appendChild(el('option', { value: '', text: '未提交改动' }));
      for (const name of branchInfo.branches) {
        baseSelect.appendChild(el('option', {
          value: name,
          text: name === branchInfo.current ? `${name} ✓` : name,
        }));
      }
      // 自定义 ref 不在分支列表中时单独展示
      const known = ['', ...branchInfo.branches];
      if (state.base && !known.includes(state.base)) {
        baseSelect.appendChild(el('option', { value: state.base, text: state.base }));
      }
      baseSelect.appendChild(el('option', { value: CUSTOM_BASE, text: '自定义…' }));
      baseSelect.appendChild(el('option', { value: COMMITS_BASE, text: '按提交选择…' }));
      baseSelect.value = state.base || '';
    };

    const refreshBranches = async () => {
      if (!state.folder || typeof api.getBranches !== 'function') {
        branchInfo = { current: '', branches: [] };
        rebuildBaseOptions();
        return;
      }
      try {
        branchInfo = await api.getBranches(state.folder);
      } catch {
        branchInfo = { current: '', branches: [] };
      }
      rebuildBaseOptions();
    };

    let switchingBase = false;
    const applyChanges = async (options, baseLabel, failPrefix) => {
      switchingBase = true;
      baseSelect.disabled = true;
      try {
        const result = await api.getChanges(state.folder, options);
        state.base = baseLabel;
        state.changes = result;
        state.changesFp = ctx.changesFingerprint(result);
        state.selectedFile = null;
        state.selectedLine = null;
        bus.dispatchEvent(new CustomEvent('changes:loaded', { detail: result }));
      } catch (err) {
        alert(`${failPrefix}：${errText(err)}`);
      } finally {
        switchingBase = false;
        baseSelect.disabled = false;
        rebuildBaseOptions();
      }
    };
    const applyBase = async (base) => {
      if (base === '') base = null;
      await applyChanges({ base }, base, '切换基准失败');
    };
    const applyCommits = async (shas) => {
      const label = shas.length === 1 ? `提交 ${shas[0].slice(0, 7)}` : `${shas.length} 个提交`;
      await applyChanges({ commits: shas }, label, '加载提交改动失败');
    };

    // 提交选择器：勾选若干 commit 查看它们的改动
    const openCommitPicker = async () => {
      rebuildBaseOptions(); // 先回退下拉显示
      let commits = [];
      try {
        commits = await api.getCommits(state.folder);
      } catch (err) {
        alert('获取提交列表失败：' + errText(err));
        return;
      }
      if (!commits.length) {
        alert('该仓库没有提交记录');
        return;
      }
      const overlay = el('div', { class: 'modal-overlay' });
      const panel = el('div', { class: 'commit-modal' });
      panel.appendChild(el('div', { class: 'commit-modal-title' }, '选择要查看的提交（可多选）'));
      const list = el('div', { class: 'commit-list' });
      const selected = new Set();
      const countEl = el('span', { class: 'commit-count' }, '已选 0 个');
      for (const c of commits) {
        const row = el('label', { class: 'commit-row' });
        const cb = el('input', { type: 'checkbox' });
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(c.sha);
          else selected.delete(c.sha);
          countEl.textContent = `已选 ${selected.size} 个`;
        });
        const main = el('div', { class: 'commit-main' });
        main.appendChild(el('div', { class: 'commit-subject' }, c.subject));
        main.appendChild(el('div', { class: 'commit-meta' },
          `${c.short} · ${c.author} · ${c.date}`));
        row.appendChild(cb);
        row.appendChild(main);
        list.appendChild(row);
      }
      const footer = el('div', { class: 'commit-modal-footer' });
      const cancelBtn = el('button', { class: 'btn', type: 'button' }, '取消');
      const okBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '确定');
      footer.appendChild(countEl);
      footer.appendChild(cancelBtn);
      footer.appendChild(okBtn);
      panel.appendChild(list);
      panel.appendChild(footer);
      overlay.appendChild(panel);
      const close = () => overlay.remove();
      overlay.addEventListener('click', (ev) => {
        if (ev.target === overlay) close();
      });
      cancelBtn.addEventListener('click', close);
      okBtn.addEventListener('click', () => {
        if (!selected.size) {
          close();
          return;
        }
        // git log 为新→旧，按时间正序传入让合并 diff 更自然
        const shas = commits.filter((c) => selected.has(c.sha)).map((c) => c.sha).reverse();
        close();
        applyCommits(shas);
      });
      document.body.appendChild(overlay);
    };

    // Electron 不支持 window.prompt，自定义基准用内联输入
    const showCustomBaseInput = () => {
      baseSelect.style.display = 'none';
      customBaseInput.style.display = '';
      customBaseInput.value = state.base || '';
      customBaseInput.focus();
    };
    const hideCustomBaseInput = (revert) => {
      customBaseInput.style.display = 'none';
      baseSelect.style.display = '';
      if (revert) rebuildBaseOptions();
    };
    customBaseInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        const value = customBaseInput.value.trim();
        hideCustomBaseInput(false);
        if (value && !switchingBase) applyBase(value);
        else rebuildBaseOptions();
      } else if (ev.key === 'Escape') {
        hideCustomBaseInput(true);
      }
    });
    customBaseInput.addEventListener('blur', () => {
      if (customBaseInput.style.display !== 'none') hideCustomBaseInput(true);
    });

    baseSelect.addEventListener('change', () => {
      if (switchingBase || !state.folder) return;
      const base = baseSelect.value;
      if (base === CUSTOM_BASE) {
        showCustomBaseInput();
        return;
      }
      if (base === COMMITS_BASE) {
        openCommitPicker();
        return;
      }
      applyBase(base);
    });

    // ---------- 搜索 ----------
    const applySearchHighlight = (scrollToFirst) => {
      diffView.querySelectorAll('.diff-line.line-match')
        .forEach((n) => n.classList.remove('line-match'));
      if (!searchQuery) return;
      /** @type {Element | null} */
      let first = null;
      for (const content of diffView.querySelectorAll('.diff-line .line-content')) {
        if (!content.textContent.toLowerCase().includes(searchQuery)) continue;
        const row = content.closest('.diff-line');
        row.classList.add('line-match');
        if (!first) first = row;
      }
      if (scrollToFirst && first) first.scrollIntoView({ block: 'center' });
    };

    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value.trim().toLowerCase();
      renderFileList(state.changes);
      applySearchHighlight(true);
    });

    // ---------- 文件列表 ----------
    const renderFileList = (changes) => {
      fileList.textContent = '';
      if (!changes) return;
      changes.files.forEach((file) => {
        if (searchQuery && !file.path.toLowerCase().includes(searchQuery)) return;
        const isRead = readSet.has(file.path);
        const item = el('div', { class: 'file-item' });
        if (isRead) item.classList.add('file-read');
        if (state.selectedFile === file) item.classList.add('active');
        item.appendChild(el('span', { class: `status-badge status-${file.status}` },
          STATUS_LABEL[file.status] || file.status));
        const info = el('div', { class: 'file-item-info' });
        const slash = file.path.lastIndexOf('/');
        const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
        const dir = slash >= 0 ? file.path.slice(0, slash + 1) : '';
        info.appendChild(el('div', { class: 'file-name', title: file.path }, name));
        if (dir) info.appendChild(el('div', { class: 'file-dir', title: file.path }, dir));
        const changedClasses = file.classes.filter((c) => c.changed);
        if (changedClasses.length) {
          const chips = el('div', { class: 'file-changed-names' });
          for (const c of changedClasses) {
            const chip = el('button', {
              class: 'class-chip', type: 'button', title: '点击按类解析（可多选）',
            }, classLabel(c));
            if (classSel.has(classKey(file, c))) chip.classList.add('active');
            chip.addEventListener('click', (ev) => {
              ev.stopPropagation();
              toggleClass(file, c, chip);
            });
            chips.appendChild(chip);
          }
          info.appendChild(chips);
        }
        item.appendChild(info);
        const aiBtn = el('button', {
          class: 'read-btn', type: 'button', title: '在「多角度 Review」中逐文件分析',
        }, 'AI');
        aiBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          state.pendingAnalyzeFile = file;
          bus.dispatchEvent(new CustomEvent('file:analyze'));
        });
        item.appendChild(aiBtn);
        const readBtn = el('button', { class: 'read-btn', type: 'button' },
          isRead ? '取消已读' : '已读');
        readBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (readSet.has(file.path)) readSet.delete(file.path);
          else readSet.add(file.path);
          const nowRead = readSet.has(file.path);
          item.classList.toggle('file-read', nowRead);
          readBtn.textContent = nowRead ? '取消已读' : '已读';
          updateReadStat();
        });
        item.appendChild(readBtn);
        item.addEventListener('click', () => {
          state.selectedFile = file;
          fileList.querySelectorAll('.file-item.active')
            .forEach((n) => n.classList.remove('active'));
          item.classList.add('active');
          renderDiff(file);
          applySearchHighlight(false);
        });
        fileList.appendChild(item);
      });
    };

    // ---------- diff 视图 ----------
    const renderDiff = (file) => {
      // 同一文件重渲染时保留滚动位置和选中行（按 clickableRows 中的 pos）；
      // 按 path 判断，changes:loaded 后 file 对象已换新但仍是同一文件
      const sameFile = lastDiffFile != null && lastDiffFile.path === file.path;
      const savedScroll = sameFile ? diffView.scrollTop : 0;
      /** @type {number | null} */
      let savedPos = null;
      if (sameFile) {
        const idx = lastDiffRows.findIndex((r) => r.row.classList.contains('line-selected'));
        if (idx >= 0) savedPos = idx;
      }
      diffView.textContent = '';
      if (!file.hunks.length) {
        diffView.appendChild(el('div', { class: 'empty-hint' }, '该文件没有可展示的 diff 内容'));
        lastDiffFile = file;
        lastDiffRows = [];
        updateCollapseAllBtn();
        return;
      }
      const clickableRows = [];
      file.hunks.forEach((hunk, hunkIndex) => {
        const key = `${file.path}#${hunkIndex}`;
        const hunkBox = el('div', { class: 'diff-hunk' });
        if (collapsed.has(key)) hunkBox.classList.add('hunk-collapsed');
        const header = el('div', { class: 'hunk-header' });
        const arrow = el('span', { class: 'hunk-arrow' }, collapsed.has(key) ? '▸' : '▾');
        header.appendChild(arrow);
        header.appendChild(document.createTextNode(' ' + hunk.header));
        header.addEventListener('click', () => {
          if (collapsed.has(key)) collapsed.delete(key);
          else collapsed.add(key);
          const nowCollapsed = collapsed.has(key);
          hunkBox.classList.toggle('hunk-collapsed', nowCollapsed);
          arrow.textContent = nowCollapsed ? '▸' : '▾';
          updateCollapseAllBtn();
        });
        hunkBox.appendChild(header);
        const table = el('div', { class: 'diff-lines' });
        hunk.lines.forEach((line, lineIndex) => {
          const row = el('div', { class: `diff-line line-${line.type}` });
          // 点击行号复制该行内容，不触发行选中
          const lineNoCell = (text) => {
            const cell = el('span', { class: 'line-no line-no-copy' }, text);
            cell.addEventListener('mousedown', (ev) => ev.stopPropagation());
            cell.addEventListener('click', (ev) => {
              ev.stopPropagation();
              navigator.clipboard.writeText(line.content)
                .then(() => { if (toast) toast('已复制该行'); })
                .catch(() => { /* 剪贴板不可用时静默 */ });
            });
            return cell;
          };
          row.appendChild(lineNoCell(line.oldLine == null ? '' : String(line.oldLine)));
          row.appendChild(lineNoCell(line.newLine == null ? '' : String(line.newLine)));
          row.appendChild(el('span', { class: 'line-content' }, line.content));
          if (line.type === 'add' || line.type === 'del') {
            row.classList.add('line-clickable');
            clickableRows.push({ row, hunkIndex, line, lineIndex });
          }
          table.appendChild(row);
        });
        hunkBox.appendChild(table);
        diffView.appendChild(hunkBox);
      });

      // 选择交互：单击选中单行；拖动经过多行快速框选；⌥+点击从锚点框选
      const clearSelected = () => {
        diffView.querySelectorAll('.diff-line.line-selected')
          .forEach((n) => n.classList.remove('line-selected'));
      };
      const highlightRange = (a, b) => {
        clearSelected();
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
          clickableRows[i].row.classList.add('line-selected');
        }
      };
      const dispatchRange = (a, b) => {
        const picked = clickableRows.slice(Math.min(a, b), Math.max(a, b) + 1);
        highlightRange(a, b);
        const segments = [];
        for (const r of picked) {
          let seg = segments.find((s) => s.hunkIndex === r.hunkIndex);
          if (!seg) {
            seg = { hunkIndex: r.hunkIndex, hunk: file.hunks[r.hunkIndex], lines: [] };
            segments.push(seg);
          }
          seg.lines.push(r.line);
        }
        const detail = { file, segments };
        state.selectedLine = detail;
        bus.dispatchEvent(new CustomEvent('line:select', { detail }));
      };
      const dispatchSingle = (r) => {
        clearSelected();
        r.row.classList.add('line-selected');
        const detail = { file, hunkIndex: r.hunkIndex, line: r.line, lineIndex: r.lineIndex };
        state.selectedLine = detail;
        bus.dispatchEvent(new CustomEvent('line:select', { detail }));
      };

      /** @type {{ start: number, end: number, alt: boolean } | null} */
      let drag = null;
      clickableRows.forEach((r, pos) => {
        r.row.addEventListener('mousedown', (ev) => {
          if (ev.button !== 0) return;
          ev.preventDefault(); // 阻止浏览器原生文字选中
          drag = { start: pos, end: pos, alt: ev.altKey };
          highlightRange(pos, pos);
          const onUp = () => {
            document.removeEventListener('mouseup', onUp);
            if (!drag) return;
            const { start, end, alt } = drag;
            drag = null;
            if (end !== start) {
              state.selAnchor = { file, pos: start };
              dispatchRange(start, end);
            } else if (alt && state.selAnchor && state.selAnchor.file === file) {
              dispatchRange(state.selAnchor.pos, start);
            } else {
              state.selAnchor = { file, pos: start };
              dispatchSingle(clickableRows[start]);
            }
          };
          document.addEventListener('mouseup', onUp);
        });
        r.row.addEventListener('mouseenter', () => {
          if (!drag) return;
          drag.end = pos;
          highlightRange(drag.start, pos);
        });
      });

      // 恢复重渲染前的滚动位置和选中行
      diffView.scrollTop = savedScroll;
      if (savedPos != null && savedPos < clickableRows.length) {
        clickableRows[savedPos].row.classList.add('line-selected');
      }
      lastDiffFile = file;
      lastDiffRows = clickableRows;
      updateCollapseAllBtn();
    };

    const render = () => {
      if (state.folder !== knownFolder) {
        knownFolder = state.folder;
        readSet.clear();
        classSel.clear();
        collapsed = new Set();
        refreshBranches();
      }
      const changes = state.changes;
      if (!changes) {
        showEmpty('请先选择项目文件夹');
        return;
      }
      if (!changes.files.length) {
        showEmpty(state.base ? '该基准下没有改动' : '当前没有未提交的改动');
        return;
      }
      renderStats(changes);
      const file = state.selectedFile && changes.files.includes(state.selectedFile)
        ? state.selectedFile
        : changes.files[0];
      state.selectedFile = file;
      renderFileList(changes);
      renderDiff(file);
      applySearchHighlight(false);
    };

    showEmpty(state.folder ? '当前没有未提交的改动' : '请先选择项目文件夹');
    rebuildBaseOptions();
    bus.addEventListener('changes:loaded', render);
  },
};

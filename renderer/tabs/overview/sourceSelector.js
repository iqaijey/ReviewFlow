import { computeFileFingerprint } from '../../lib/overviewPerf.js';
import { trapDialogFocus, restoreDialogFocus } from '../../lib/dialog.js';
import { createRequestGuard } from '../../lib/requestGuard.js';

const CUSTOM_BASE = '__custom__';

const COMMITS_BASE = '__commits__';

const WORKTREE_MODES = new Set(['staged', 'unstaged', 'untracked']);

export function createSourceSelector(context) {
  const sourceGuard = context.ctx.changesGuard || createRequestGuard(() => context.state.folder);
  const branchGuard = createRequestGuard(() => context.state.folder);
  sourceGuard.onBegin(() => {
    switchingBase = false;
    context.baseSelect.disabled = false;
  });
  /** @type {(() => void) | null} */
  let closePicker = null;
  context.bus.addEventListener('project:changed', () => {
    if (!context.ctx.changesGuard) sourceGuard.invalidate();
    branchGuard.invalidate();
    closePicker?.();
    switchingBase = false;
    context.baseSelect.disabled = false;
  });
  // ---------- 基准选择 ----------
  const rebuildBaseOptions = () => {
    context.baseSelect.textContent = '';
    context.baseSelect.appendChild(context.el('option', { value: '', text: '未提交改动' }));
    context.baseSelect.appendChild(context.el('option', { value: 'staged', text: '已暂存改动' }));
    context.baseSelect.appendChild(context.el('option', { value: 'unstaged', text: '未暂存改动' }));
    context.baseSelect.appendChild(context.el('option', { value: 'untracked', text: '仅未跟踪文件' }));
    for (const name of context.branchInfo.branches) {
      context.baseSelect.appendChild(context.el('option', {
        value: name,
        text: name === context.branchInfo.current ? `${name} ✓` : name,
      }));
    }
    // 自定义 ref 不在分支列表中时单独展示
    const known = ['', 'staged', 'unstaged', 'untracked', ...context.branchInfo.branches];
    if (context.state.base && !known.includes(context.state.base)) {
      context.baseSelect.appendChild(context.el('option', { value: context.state.base, text: context.state.base }));
    }
    context.baseSelect.appendChild(context.el('option', { value: CUSTOM_BASE, text: '自定义…' }));
    context.baseSelect.appendChild(context.el('option', { value: COMMITS_BASE, text: '按提交选择…' }));
    if (context.state.base) {
      context.baseSelect.value = context.state.base;
    } else if (WORKTREE_MODES.has(context.state.sourceMode)) {
      context.baseSelect.value = context.state.sourceMode;
    } else {
      context.baseSelect.value = '';
    }
  };

  const refreshBranches = async () => {
    const request = branchGuard.begin();
    if (!context.state.folder || typeof context.api.getBranches !== 'function') {
      context.branchInfo = { current: '', branches: [] };
      rebuildBaseOptions();
      return;
    }
    try {
      const branches = await context.api.getBranches(request.folder);
      if (!request.isCurrent()) return;
      context.branchInfo = branches;
    } catch {
      if (!request.isCurrent()) return;
      context.branchInfo = { current: '', branches: [] };
    }
    rebuildBaseOptions();
  };

  let switchingBase = false;
  const applyChanges = async (options, baseLabel, failPrefix) => {
    closePicker?.();
    const request = sourceGuard.begin();
    const releaseSource = sourceGuard.holdSource();
    switchingBase = true;
    context.baseSelect.disabled = true;
    try {
      const result = await context.api.getChanges(request.folder, options);
      if (!request.isCurrent()) return;
      const resolvedMode = String((result && result.source && result.source.mode) || options.mode || 'uncommitted');
      context.state.sourceMode = /** @type {ReviewMode} */ (resolvedMode);
      context.state.base = baseLabel;
      context.state.commits = options.commits || null;
      context.state.changes = result;
      context.state.changesFp = context.ctx.changesFingerprint(result);
      context.state.selectedFile = null;
      context.state.selectedLine = null;
      context.clearAllSelection();
      context.persistProjectPatch({
        source: {
          mode: resolvedMode,
          base: context.state.base || null,
          commits: context.state.commits || null,
        },
        selectedFilePath: null,
      });
      context.bus.dispatchEvent(new CustomEvent('changes:loaded', { detail: result }));
    } catch (err) {
      if (!request.isCurrent()) return;
      context.toast(`${failPrefix}：${context.errText(err)}`, 'error');
    } finally {
      releaseSource();
      if (!request.isCurrent()) return;
      switchingBase = false;
      context.baseSelect.disabled = false;
      rebuildBaseOptions();
    }
  };
  /**
   * @param {string | null} base
   * @param {ReviewMode} [mode]
   */
  const applyBase = async (base, mode) => {
    if (base === '' || base === 'uncommitted') {
      await applyChanges({ mode: 'uncommitted', base: null }, null, '切换基准失败');
      return;
    }
    if (!mode && base && WORKTREE_MODES.has(base)) {
      const worktreeMode = /** @type {ReviewMode} */ (base);
      await applyChanges({ mode: worktreeMode, base: null }, null, '切换基准失败');
      return;
    }
    /** @type {ReviewMode} */
    const resolvedMode = !base
      ? 'uncommitted'
      : mode || (context.branchInfo.branches.includes(base) ? 'branch' : 'ref');
    await applyChanges({ mode: resolvedMode, base }, base, '切换基准失败');
  };
  const applyCommits = async (shas) => {
    const label = shas.length === 1 ? `提交 ${shas[0].slice(0, 7)}` : `${shas.length} 个提交`;
    await applyChanges({ mode: 'commits', commits: shas }, label, '加载提交改动失败');
  };

  // 提交选择器：勾选若干 commit 查看它们的改动
  const openCommitPicker = async () => {
    closePicker?.();
    const request = sourceGuard.begin();
    const openerEl = document.activeElement instanceof HTMLElement ? document.activeElement : context.baseSelect;
    rebuildBaseOptions(); // 先回退下拉显示
    let commits = [];
    try {
      commits = await context.api.getCommits(request.folder);
      if (!request.isCurrent()) return;
    } catch (err) {
      if (!request.isCurrent()) return;
      context.toast('获取提交列表失败：' + context.errText(err), 'error');
      return;
    }
    if (!commits.length) {
      context.toast('该仓库没有提交记录', 'error');
      return;
    }
    const titleId = `commit-modal-title-${Date.now()}`;
    const overlay = context.el('div', { class: 'modal-overlay' });
    const panel = context.el('div', {
      class: 'commit-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      tabindex: '-1',
    });
    panel.appendChild(context.el('div', { class: 'commit-modal-title', id: titleId }, '选择要查看的提交（可多选）'));
    const list = context.el('div', { class: 'commit-list', tabindex: '-1' });
    const selected = new Set();
    const countEl = context.el('span', { class: 'commit-count' }, '已选 0 个');
    /** @type {HTMLInputElement | null} */
    let firstCheckbox = null;
    for (const c of commits) {
      const row = context.el('label', { class: 'commit-row' });
      const cb = /** @type {HTMLInputElement} */ (context.el('input', { type: 'checkbox' }));
      if (!firstCheckbox) firstCheckbox = cb;
      cb.addEventListener('change', () => {
        if (cb.checked) selected.add(c.sha);
        else selected.delete(c.sha);
        countEl.textContent = `已选 ${selected.size} 个`;
      });
      const main = context.el('div', { class: 'commit-main' });
      main.appendChild(context.el('div', { class: 'commit-subject' }, c.subject));
      main.appendChild(context.el('div', { class: 'commit-meta' },
        `${c.short} · ${c.author} · ${c.date}`));
      row.appendChild(cb);
      row.appendChild(main);
      list.appendChild(row);
    }
    const footer = context.el('div', { class: 'commit-modal-footer' });
    const cancelBtn = context.el('button', { class: 'btn', type: 'button' }, '取消');
    const okBtn = context.el('button', { class: 'btn btn-primary', type: 'button' }, '确定');
    footer.appendChild(countEl);
    footer.appendChild(cancelBtn);
    footer.appendChild(okBtn);
    panel.appendChild(list);
    panel.appendChild(footer);
    overlay.appendChild(panel);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      if (closePicker === close) closePicker = null;
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      restoreDialogFocus(openerEl, context.baseSelect);
    };
    closePicker = close;
    const onKeyDown = (/** @type {KeyboardEvent} */ ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        close();
        return;
      }
      trapDialogFocus(panel, ev);
    };
    document.addEventListener('keydown', onKeyDown, true);
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) close();
    });
    cancelBtn.addEventListener('click', close);
    okBtn.addEventListener('click', () => {
      if (closed || !request.isCurrent()) return;
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
    if (firstCheckbox) {
      firstCheckbox.focus();
    } else {
      list.focus();
    }
  };

  // Electron 不支持 window.prompt，自定义基准用内联输入
  const showCustomBaseInput = () => {
    context.baseSelect.style.display = 'none';
    context.customBaseInput.style.display = '';
    context.customBaseInput.value = context.state.base || '';
    context.customBaseInput.focus();
  };
  const hideCustomBaseInput = (revert) => {
    context.customBaseInput.style.display = 'none';
    context.baseSelect.style.display = '';
    if (revert) rebuildBaseOptions();
  };
  context.customBaseInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      const value = context.customBaseInput.value.trim();
      hideCustomBaseInput(false);
      if (value && !switchingBase) applyBase(value, 'ref');
      else rebuildBaseOptions();
    } else if (ev.key === 'Escape') {
      hideCustomBaseInput(true);
    }
  });
  context.customBaseInput.addEventListener('blur', () => {
    if (context.customBaseInput.style.display !== 'none') hideCustomBaseInput(true);
  });

  context.baseSelect.addEventListener('change', () => {
    if (switchingBase || !context.state.folder) return;
    const base = context.baseSelect.value;
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

  return {
  get refreshBranches() { return refreshBranches; },
  get rebuildBaseOptions() { return rebuildBaseOptions; },
  get switchingBase() { return switchingBase; },
  set switchingBase(value) { switchingBase = value; },
  get hideCustomBaseInput() { return hideCustomBaseInput; },
  get applyBase() { return applyBase; },
  };
}

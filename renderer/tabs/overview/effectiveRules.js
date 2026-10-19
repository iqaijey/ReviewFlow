import { computeFileFingerprint } from '../../lib/overviewPerf.js';
import { trapDialogFocus, restoreDialogFocus } from '../../lib/dialog.js';

export function createEffectiveRules(context) {
  const openEffectiveRulesModal = async () => {
    const file = context.state.selectedFile;
    if (!context.state.folder || !file || !file.path || typeof context.api.getEffectiveRules !== 'function') return;
    const returnFocusEl = /** @type {HTMLElement | null} */ (document.activeElement) || context.effectiveRulesBtn;
    context.effectiveRulesBtn.disabled = true;
    let result;
    try {
      result = await context.api.getEffectiveRules({ folder: context.state.folder, paths: [file.path] });
    } catch (err) {
      context.toast('读取生效规则失败：' + context.errText(err), 'error');
      return;
    } finally {
      context.updateCollapseAllBtn();
    }
    const titleId = 'effective-rules-dialog-title';
    const overlay = context.el('div', { class: 'modal-overlay effective-rules-overlay' });
    const dialog = context.el('div', {
      class: 'effective-rules-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      tabindex: '-1',
    });
    const head = context.el('div', { class: 'effective-rules-head' });
    head.appendChild(context.el('div', {
      class: 'effective-rules-title',
      id: titleId,
      title: file.path,
    }, `生效规则 · ${file.path}`));
    const closeBtn = /** @type {HTMLButtonElement} */ (context.el('button', {
      class: 'btn run-close',
      type: 'button',
    }, '关闭'));
    head.appendChild(closeBtn);
    dialog.appendChild(head);

    const modalBody = context.el('div', { class: 'effective-rules-body' });
    const ruleFiles = result && Array.isArray(result.files) ? result.files : [];
    modalBody.appendChild(context.el('div', { class: 'effective-rules-section-title' },
      `参与的 .reviewflow.md 文件（${ruleFiles.length} 个，共 ${result ? result.totalChars : 0} 字）`));
    const filesBox = context.el('div', { class: 'effective-rules-files' });
    if (!ruleFiles.length) {
      filesBox.appendChild(context.el('div', { class: 'settings-hint' }, '当前路径未匹配到任何 .reviewflow.md 规则文件'));
    } else {
      for (const rf of ruleFiles) {
        const row = context.el('div', { class: 'effective-rules-file-row' });
        row.appendChild(context.el('span', { class: 'effective-rules-file-path', title: rf.path }, rf.path));
        row.appendChild(context.el('span', { class: 'effective-rules-file-chars' }, `${rf.chars} 字`));
        const badgeStatus = !rf.included
          ? { text: '未包含', cls: 'is-omitted' }
          : rf.truncated
            ? { text: '已截断', cls: 'is-truncated' }
            : { text: '已包含', cls: 'is-included' };
        row.appendChild(context.el('span', { class: `effective-rules-badge ${badgeStatus.cls}` }, badgeStatus.text));
        filesBox.appendChild(row);
      }
    }
    modalBody.appendChild(filesBox);

    modalBody.appendChild(context.el('div', { class: 'effective-rules-section-title' },
      `注入文本${result && result.truncated ? '（已截断）' : ''}`));
    modalBody.appendChild(context.el('pre', { class: 'effective-rules-text' },
      result && result.text ? result.text : '（无注入规则文本）'));
    dialog.appendChild(modalBody);
    overlay.appendChild(dialog);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      restoreDialogFocus(returnFocusEl, context.effectiveRulesBtn);
    };
    const onKeyDown = (/** @type {KeyboardEvent} */ ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        close();
        return;
      }
      trapDialogFocus(dialog, ev);
    };
    document.addEventListener('keydown', onKeyDown, true);
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) close();
    });
    closeBtn.addEventListener('click', close);
    document.body.appendChild(overlay);
    closeBtn.focus();
  };
  context.effectiveRulesBtn.addEventListener('click', openEffectiveRulesModal);

}

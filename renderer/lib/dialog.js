// 共享无障碍确认弹窗：role="dialog", aria-modal="true", 焦点捕获, Esc 取消, 关闭后还原焦点
let dialogSeq = 0;

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** @param {HTMLElement} node */
export function isDialogControlVisible(node) {
  if (!node.getClientRects().length || node.closest('[hidden], [aria-hidden="true"]')) return false;
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement && !parent.open) {
      const summary = parent.querySelector(':scope > summary');
      if (!summary?.contains(node)) return false;
    }
  }
  return getComputedStyle(node).visibility !== 'hidden';
}

/**
 * 捕获对话框内的 Tab 焦点循环。
 * @param {HTMLElement} container
 * @param {KeyboardEvent} ev
 */
export function trapDialogFocus(container, ev) {
  if (ev.key !== 'Tab') return;
  const focusables = /** @type {HTMLElement[]} */ (
    [...container.querySelectorAll(FOCUSABLE_SELECTOR)]
      .filter((node) => node instanceof HTMLElement && isDialogControlVisible(node))
  );
  if (!focusables.length) {
    ev.preventDefault();
    container.focus();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (ev.shiftKey) {
    if (active === first || !container.contains(active)) {
      ev.preventDefault();
      last.focus();
    }
  } else if (active === last || !container.contains(active)) {
    ev.preventDefault();
    first.focus();
  }
}

/**
 * @param {HTMLElement | null | undefined} opener
 * @param {(() => HTMLElement | null | undefined) | HTMLElement | null} [fallback]
 */
export function restoreDialogFocus(opener, fallback = null) {
  if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
    opener.focus();
    return;
  }
  const candidate = typeof fallback === 'function' ? fallback() : fallback;
  if (candidate && typeof candidate.focus === 'function' && document.contains(candidate)) {
    if (candidate.tabIndex < 0 && !candidate.hasAttribute('tabindex')) {
      candidate.tabIndex = -1;
    }
    candidate.focus();
  }
}

/**
 * 打开无障碍确认对话框。
 * @param {{
 *   title?: string,
 *   message: string,
 *   confirmText?: string,
 *   cancelText?: string,
 *   danger?: boolean,
 * }} options
 * @returns {Promise<boolean>}
 */
export function confirmDialog({
  title = '请确认',
  message,
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
}) {
  return new Promise((resolve) => {
    const id = ++dialogSeq;
    const titleId = `confirm-dialog-title-${id}`;
    const descId = `confirm-dialog-desc-${id}`;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'findings-dialog confirm-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', titleId);
    dialog.setAttribute('aria-describedby', descId);
    dialog.tabIndex = -1;

    const head = document.createElement('div');
    head.className = 'commit-modal-title';
    head.id = titleId;
    head.textContent = title;

    const body = document.createElement('div');
    body.className = 'findings-dialog-body';
    const desc = document.createElement('div');
    desc.id = descId;
    desc.textContent = message;
    body.appendChild(desc);

    const footer = document.createElement('div');
    footer.className = 'commit-modal-footer';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.textContent = cancelText;

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';
    confirmBtn.textContent = confirmText;

    footer.appendChild(cancelBtn);
    footer.appendChild(confirmBtn);
    dialog.appendChild(head);
    dialog.appendChild(body);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);

    let settled = false;
    const finish = (/** @type {boolean} */ result) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      if (opener && document.contains(opener) && typeof opener.focus === 'function') {
        opener.focus();
      }
      resolve(result);
    };

    const onKeyDown = (/** @type {KeyboardEvent} */ ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
        return;
      }
      trapDialogFocus(dialog, ev);
    };

    cancelBtn.addEventListener('click', () => finish(false));
    confirmBtn.addEventListener('click', () => finish(true));
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) finish(false);
    });

    document.addEventListener('keydown', onKeyDown, true);
    document.body.appendChild(overlay);
    if (danger) {
      cancelBtn.focus();
    } else {
      confirmBtn.focus();
    }
  });
}

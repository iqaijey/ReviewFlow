

import { trapDialogFocus, restoreDialogFocus } from '../dialog.js';

export function createDialogs(context) {
  /** @type {HTMLElement | null} */
  let activeOverlay = null;
  /** @type {((ev: KeyboardEvent) => void) | null} */
  let activeKeyHandler = null;
  let disposeActive = () => {};
  context.bus.addEventListener('project:changed', () => closeActiveDialog(null));

  /**
   * @param {HTMLElement | null} opener
   * @param {string | null} findingId
   * @param {string | null} suggestionId
   * @param {string | null} openerText
   */
  function findReplacementFocus(opener, findingId, suggestionId, openerText) {
    if (opener && document.contains(opener)) return opener;
    const root = context.container;
    if (!root) return null;
    if (findingId) {
      const row = [...root.querySelectorAll('.finding-row')].find(
        (node) => node instanceof HTMLElement && node.dataset && node.dataset.findingId === findingId,
      );
      if (row instanceof HTMLElement) {
        if (openerText) {
          const sameBtn = [...row.querySelectorAll('button:not([disabled])')].find(
            (b) => b instanceof HTMLElement && b.textContent === openerText,
          );
          if (sameBtn instanceof HTMLElement) return sameBtn;
        }
        const firstControl = row.querySelector('button:not([disabled]), input:not([disabled])');
        if (firstControl instanceof HTMLElement) return firstControl;
        return row;
      }
    }
    if (suggestionId) {
      const card = [...root.querySelectorAll('.rule-suggestion-item')].find(
        (node) => node instanceof HTMLElement && node.dataset && node.dataset.suggestionId === suggestionId,
      );
      if (card instanceof HTMLElement) {
        const btn = card.querySelector('button:not([disabled])');
        if (btn instanceof HTMLElement) return btn;
        return card;
      }
    }
    const listContainer = root.querySelector('.findings-list, .rule-suggestions-box, .findings-panel');
    if (listContainer instanceof HTMLElement) return listContainer;
    return root;
  }

  /**
   * @param {HTMLElement | null} returnFocusEl
   * @param {(() => HTMLElement | null | undefined) | null} [fallbackFn]
   */
  function closeActiveDialog(returnFocusEl, fallbackFn = null) {
    disposeActive();
    disposeActive = () => {};
    if (activeKeyHandler) {
      document.removeEventListener('keydown', activeKeyHandler, true);
      activeKeyHandler = null;
    }
    if (activeOverlay) {
      activeOverlay.remove();
      activeOverlay = null;
    }
    if (returnFocusEl || fallbackFn) {
      restoreDialogFocus(returnFocusEl, fallbackFn);
    }
  }

  /**
   * @param {{ title: string, opener: HTMLElement | null, findingId?: string | null, wide?: boolean, build: (body: HTMLElement, footer: HTMLElement, close: () => void, lifecycle: { isActive: () => boolean, onDispose: (dispose: () => void) => void }) => HTMLElement | null }} spec
   */
  function openAccessibleDialog({ title, opener, findingId = null, wide = false, build }) {
    closeActiveDialog(null);
    const resolvedFindingId = findingId
      || (opener && typeof opener.closest === 'function'
        ? (/** @type {HTMLElement | null} */ (opener.closest('.finding-row')))?.dataset?.findingId || null
        : null);
    const resolvedSuggestionId = opener && typeof opener.closest === 'function'
      ? (/** @type {HTMLElement | null} */ (opener.closest('.rule-suggestion-item')))?.dataset?.suggestionId || null
      : null;
    const openerText = opener ? opener.textContent : null;
    const titleId = `findings-dialog-title-${Date.now()}`;
    const overlay = context.el('div', { class: 'modal-overlay' });
    const dialog = context.el('div', {
      class: `findings-dialog${wide ? ' findings-dialog-wide' : ''}`,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      tabindex: '-1',
    });
    const head = context.el('div', { class: 'commit-modal-title', id: titleId }, title);
    const body = context.el('div', { class: 'findings-dialog-body' });
    const footer = context.el('div', { class: 'commit-modal-footer' });
    dialog.appendChild(head);
    dialog.appendChild(body);
    dialog.appendChild(footer);
    overlay.appendChild(dialog);

    const close = () => { if (activeOverlay !== overlay) return; closeActiveDialog(
      opener,
      () => findReplacementFocus(opener, resolvedFindingId, resolvedSuggestionId, openerText),
    ); };
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) close();
    });
    const onKeyDown = (/** @type {KeyboardEvent} */ ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        close();
        return;
      }
      trapDialogFocus(dialog, ev);
    };
    activeOverlay = overlay;
    const disposers = new Set();
    disposeActive = () => { for (const dispose of disposers) dispose(); disposers.clear(); };
    activeKeyHandler = onKeyDown;
    document.addEventListener('keydown', onKeyDown, true);

    const initialFocus = build(body, footer, close, {
      isActive: () => activeOverlay === overlay,
      onDispose: (dispose) => disposers.add(dispose),
    });
    document.body.appendChild(overlay);
    if (initialFocus && typeof initialFocus.focus === 'function') {
      initialFocus.focus();
    } else {
      dialog.focus();
    }
  }

  return {
    get openAccessibleDialog() { return openAccessibleDialog; },
  };
}

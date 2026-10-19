import { DISMISSAL_REASON_OPTIONS } from './shared.js';

export function createStatus(context) {
  /**
   * @param {Finding} item
   * @param {FindingStatus} status
   * @param {{ reason: DismissalReason, note?: string } | undefined} [dismissal]
   * @returns {Promise<boolean>}
   */
  async function mutateStatus(item, status, dismissal = undefined) {
    const folder = context.getFolder();
    if (!folder || context.savingIds.has(item.id)) return false;
    context.savingIds.add(item.id);
    context.render();
    try {
      /** @type {ChecklistStatusPayload} */
      const payload = {
        folder,
        id: item.id,
        status,
        expectedUpdatedAt: item.updatedAt,
      };
      if (dismissal) payload.dismissal = dismissal;
      const updated = await context.api.checklistSetStatus(payload);
      if (context.getFolder() !== folder) return false;
      context.findings = Array.isArray(updated) ? updated : context.findings;
      await context.refreshSuggestions(folder);
      return true;
    } catch (err) {
      if (context.getFolder() !== folder) return false;
      context.toast('问题状态保存失败：' + context.errText(err), 'error');
      await context.reloadFromStore(folder);
      return false;
    } finally {
      if (context.getFolder() === folder) {
        context.savingIds.delete(item.id);
        context.render();
      }
    }
  }

  /**
   * @param {Finding} item
   * @param {HTMLElement} opener
   */
  function openDismissDialog(item, opener) {
    context.openAccessibleDialog({
      title: '标记为不处理',
      opener,
      findingId: item.id,
      build: (body, footer, close) => {
        body.appendChild(context.el('div', { class: 'settings-hint' }, `问题：${item.text}`));
        const reasonGroup = context.el('div', {
          class: 'findings-reason-list',
          role: 'radiogroup',
          'aria-label': '不处理原因',
        });
        /** @type {Record<string, HTMLInputElement>} */
        const radios = {};
        let selectedReason = /** @type {DismissalReason} */ (item.dismissal?.reason || 'false_positive');
        for (const [value, label] of DISMISSAL_REASON_OPTIONS) {
          const id = `dismiss-reason-${value}`;
          const radio = /** @type {HTMLInputElement} */ (context.el('input', {
            type: 'radio',
            name: 'dismiss-reason',
            id,
            value,
          }));
          if (value === selectedReason) radio.checked = true;
          radios[value] = radio;
          const row = context.el('label', { class: 'findings-reason-option', for: id });
          row.appendChild(radio);
          row.appendChild(context.el('span', {}, label));
          reasonGroup.appendChild(row);
        }
        body.appendChild(reasonGroup);

        const noteId = 'dismiss-note-input';
        const noteLabel = context.el('label', { class: 'settings-label', for: noteId }, '补充说明（选「其他」时必填，最多 500 字）');
        const noteInput = /** @type {HTMLTextAreaElement} */ (context.el('textarea', {
          id: noteId,
          class: 'settings-input findings-dialog-textarea',
          maxlength: '500',
          placeholder: '说明原因、前置校验位置或设计考量…',
          spellcheck: 'false',
        }));
        noteInput.value = item.dismissal?.note || '';
        const errorEl = context.el('div', { class: 'findings-error-inline', style: 'display:none' });
        body.appendChild(noteLabel);
        body.appendChild(noteInput);
        body.appendChild(errorEl);

        for (const [value, radio] of Object.entries(radios)) {
          radio.addEventListener('change', () => {
            if (radio.checked) {
              selectedReason = /** @type {DismissalReason} */ (value);
              errorEl.style.display = 'none';
            }
          });
        }

        const cancelBtn = /** @type {HTMLButtonElement} */ (context.el('button', { class: 'btn', type: 'button', onClick: close }, '取消'));
        const confirmBtn = /** @type {HTMLButtonElement} */ (context.el('button', {
          class: 'btn btn-primary',
          type: 'button',
        }, '确认不处理'));

        confirmBtn.addEventListener('click', async () => {
          const note = noteInput.value.trim();
          if (note.length > 500) {
            errorEl.textContent = '补充说明最多 500 字';
            errorEl.style.display = '';
            return;
          }
          if (selectedReason === 'other' && !note) {
            errorEl.textContent = '选择「其他」时必须填写补充说明';
            errorEl.style.display = '';
            noteInput.focus();
            return;
          }
          confirmBtn.disabled = true;
          cancelBtn.disabled = true;
          const ok = await mutateStatus(item, 'wontfix', { reason: selectedReason, note });
          if (ok) {
            close();
          } else {
            close();
          }
        });

        footer.appendChild(cancelBtn);
        footer.appendChild(confirmBtn);
        return radios[selectedReason] || radios.false_positive;
      },
    });
  }

  return {
    get mutateStatus() { return mutateStatus; },
    get openDismissDialog() { return openDismissDialog; },
  };
}

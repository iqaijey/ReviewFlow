

export function createRuleSuggestions(context) {
  /**
   * @param {RuleSuggestion} suggestion
   * @param {HTMLElement} opener
   */
  function openRuleAppendDialog(suggestion, opener) {
    const folder = context.getFolder();
    if (!folder) return;

    context.openAccessibleDialog({
      title: '追加评审约定到 .reviewflow.md',
      opener,
      wide: true,
      build: (body, footer, close) => {
        const snippetId = 'rule-append-snippet';
        body.appendChild(context.el('label', { class: 'settings-label', for: snippetId }, '规则片段（可编辑，预览后确认写入）'));
        const snippetInput = /** @type {HTMLTextAreaElement} */ (context.el('textarea', {
          id: snippetId,
          class: 'settings-input findings-dialog-textarea findings-dialog-textarea-mono',
          spellcheck: 'false',
        }));
        snippetInput.value = suggestion.snippet || '';
        body.appendChild(snippetInput);

        const previewHead = context.el('div', { class: 'findings-header' });
        previewHead.appendChild(context.el('span', { class: 'settings-label' }, '写入后 .reviewflow.md 全文预览'));
        const refreshPreviewBtn = /** @type {HTMLButtonElement} */ (context.el('button', {
          class: 'btn finding-action-btn',
          type: 'button',
        }, '刷新预览'));
        previewHead.appendChild(refreshPreviewBtn);
        body.appendChild(previewHead);

        const warningBox = context.el('div', {
          class: 'findings-warning-banner',
          style: 'display:none',
        }, '警告：追加后 .reviewflow.md 超出提示词注入的 4000 字上限，超出部分在 AI 评审时会被截断，可能无法完整生效。');
        body.appendChild(warningBox);

        const previewPre = context.el('pre', { class: 'findings-preview-box' }, '正在生成预览…');
        body.appendChild(previewPre);

        const errorEl = context.el('div', { class: 'findings-error-inline', style: 'display:none' });
        body.appendChild(errorEl);

        const cancelBtn = /** @type {HTMLButtonElement} */ (context.el('button', { class: 'btn', type: 'button', onClick: close }, '取消'));
        const confirmBtn = /** @type {HTMLButtonElement} */ (context.el('button', {
          class: 'btn btn-primary',
          type: 'button',
        }, '确认追加到 .reviewflow.md'));
        confirmBtn.disabled = true;

        /** @type {string | null} */
        let currentPreviewId = null;
        let previewLoading = false;

        const runPreview = async () => {
          if (context.getFolder() !== folder) { close(); return; }
          const snippet = snippetInput.value.trim();
          if (!snippet) {
            currentPreviewId = null;
            confirmBtn.disabled = true;
            errorEl.textContent = '规则内容不能为空';
            errorEl.style.display = '';
            return;
          }
          previewLoading = true;
          refreshPreviewBtn.disabled = true;
          confirmBtn.disabled = true;
          errorEl.style.display = 'none';
          try {
            const res = await context.api.previewRuleAppend({
              folder,
              suggestionId: suggestion.id,
              snippet,
            });
            if (context.getFolder() !== folder) { close(); return; }
            currentPreviewId = res.previewId;
            previewPre.textContent = res.resultingText || '';
            warningBox.style.display = res.truncatedByPromptLimit ? '' : 'none';
            confirmBtn.disabled = false;
          } catch (err) {
            currentPreviewId = null;
            previewPre.textContent = '';
            warningBox.style.display = 'none';
            errorEl.textContent = '预览失败：' + context.errText(err);
            errorEl.style.display = '';
          } finally {
            previewLoading = false;
            refreshPreviewBtn.disabled = false;
          }
        };

        snippetInput.addEventListener('input', () => {
          currentPreviewId = null;
          confirmBtn.disabled = true;
          errorEl.textContent = '已修改规则片段，请先点击「刷新预览」再确认追加';
          errorEl.style.display = '';
        });

        refreshPreviewBtn.addEventListener('click', () => {
          if (!previewLoading) runPreview();
        });

        confirmBtn.addEventListener('click', async () => {
          if (!currentPreviewId || previewLoading || context.getFolder() !== folder) return;
          confirmBtn.disabled = true;
          refreshPreviewBtn.disabled = true;
          errorEl.style.display = 'none';
          try {
            const res = await context.api.appendProjectRule({
              folder,
              previewId: currentPreviewId,
              confirmed: true,
            });
            if (context.getFolder() !== folder) { close(); return; }
            if (res && Array.isArray(res.persistenceWarnings)) {
              for (const w of res.persistenceWarnings) {
                context.toast(w, 'info');
              }
            }
            context.toast('已追加规则到 .reviewflow.md', 'success');
            await context.refreshSuggestions(folder);
            if (context.getFolder() !== folder) return;
            context.render();
            close();
          } catch (err) {
            const msg = context.errText(err);
            errorEl.textContent = '追加失败：' + msg;
            errorEl.style.display = '';
            context.toast('追加规则失败：' + msg, 'error');
            await runPreview();
          }
        });

        footer.appendChild(cancelBtn);
        footer.appendChild(confirmBtn);
        runPreview();
        return snippetInput;
      },
    });
  }

  return {
    get openRuleAppendDialog() { return openRuleAppendDialog; },
  };
}

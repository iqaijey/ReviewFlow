import { createRunStatus } from '../runStatus.js';

export function createPatchDialogs(context) {
  let projectEpoch = 0;
  context.bus.addEventListener('project:changed', () => { projectEpoch++; });
  /**
   * @param {string} msg
   */
  function isBackendUnsupportedMessage(msg) {
    return msg.includes('仅支持 API 或只读 Codex') || msg.includes('交接提示词');
  }

  /**
   * @param {string} diffText
   */
  function renderUnifiedDiff(diffText) {
    const box = context.el('div', { class: 'diff-view fix-patch-diff' });
    const lines = String(diffText || '').split('\n');
    for (const rawLine of lines) {
      if (rawLine.startsWith('@@')) {
        box.appendChild(context.el('div', { class: 'diff-hunk-header' }, rawLine));
        continue;
      }
      if (rawLine.startsWith('diff --git') || rawLine.startsWith('index ') || rawLine.startsWith('--- ') || rawLine.startsWith('+++ ')) {
        box.appendChild(context.el('div', { class: 'fix-patch-diff-meta' }, rawLine));
        continue;
      }
      const isAdd = rawLine.startsWith('+');
      const isDel = rawLine.startsWith('-');
      const lineClass = isAdd ? 'line-add' : isDel ? 'line-del' : 'line-context';
      const content = isAdd || isDel || rawLine.startsWith(' ') ? rawLine.slice(1) : rawLine;
      const lineEl = context.el('div', { class: `diff-line ${lineClass}` });
      lineEl.appendChild(context.el('span', { class: 'line-content' }, content));
      box.appendChild(lineEl);
    }
    return box;
  }

  /**
   * @param {string[]} findingIds
   * @param {HTMLElement | null} opener
   */
  async function openHandoffDialog(findingIds, opener) {
    const folder = context.getFolder();
    const epoch = projectEpoch;
    if (!folder || typeof context.api.getHandoffPrompt !== 'function') return;
    if (!findingIds.length) {
      context.toast('没有可复制的未关闭问题', 'info');
      return;
    }
    try {
      const res = await context.api.getHandoffPrompt({ folder, findingIds });
      if (epoch !== projectEpoch || context.getFolder() !== folder) return;
      context.openAccessibleDialog({
        title: `复制修复任务（${findingIds.length} 条问题）`,
        opener,
        wide: true,
        build: (body, footer, close) => {
          const headRow = context.el('div', { class: 'findings-header' });
          headRow.appendChild(context.el('span', { class: 'settings-label' }, '修复任务提示词（Markdown）'));
          const copyPromptBtn = /** @type {HTMLButtonElement} */ (context.el('button', {
            class: 'btn btn-primary finding-action-btn',
            type: 'button',
            onClick: () => {
              navigator.clipboard.writeText(res.markdown || '')
                .then(() => context.toast('已复制修复任务提示词到剪贴板', 'success'))
                .catch(() => context.toast('复制失败，请手动复制', 'error'));
            },
          }, '复制提示词'));
          headRow.appendChild(copyPromptBtn);
          body.appendChild(headRow);

          const promptPre = context.el('pre', { class: 'findings-preview-box fix-handoff-prompt' }, res.markdown || '');
          body.appendChild(promptPre);

          const cmdWarning = context.el('div', {
            class: 'findings-warning-banner fix-handoff-warning',
          }, '请在终端自行运行，ReviewFlow 不会执行');
          body.appendChild(cmdWarning);

          const cmdList = context.el('div', { class: 'fix-handoff-commands' });
          for (const cmd of Array.isArray(res.commands) ? res.commands : []) {
            const cmdRow = context.el('div', { class: 'fix-handoff-cmd-row' });
            cmdRow.appendChild(context.el('span', { class: 'fix-handoff-cmd-label' }, cmd.label || '命令'));
            cmdRow.appendChild(context.el('code', { class: 'run-cmd fix-handoff-cmd-code' }, cmd.command || ''));
            const copyCmdBtn = context.el('button', {
              class: 'btn finding-action-btn',
              type: 'button',
              onClick: () => {
                navigator.clipboard.writeText(cmd.command || '')
                  .then(() => context.toast(`已复制 ${cmd.label || '命令'}`, 'success'))
                  .catch(() => context.toast('复制命令失败，请手动复制', 'error'));
              },
            }, '复制命令');
            cmdRow.appendChild(copyCmdBtn);
            cmdList.appendChild(cmdRow);
          }
          body.appendChild(cmdList);

          const closeBtn = /** @type {HTMLButtonElement} */ (context.el('button', {
            class: 'btn',
            type: 'button',
            onClick: close,
          }, '关闭'));
          footer.appendChild(closeBtn);
          return copyPromptBtn;
        },
      });
    } catch (err) {
      if (epoch !== projectEpoch || context.getFolder() !== folder) return;
      context.toast('生成修复任务失败：' + context.errText(err), 'error');
    }
  }

  /**
   * @param {Finding} item
   * @param {FixPatchPreview} initialPreview
   * @param {HTMLElement | null} opener
   * @param {string} initialExtra
   */
  function openPatchDialog(item, initialPreview, opener, initialExtra = '') {
    const folder = context.getFolder();
    const epoch = projectEpoch;
    if (!folder) return;
    let currentPreview = initialPreview;
    let busy = false;
    let confirmingApply = false;

    context.openAccessibleDialog({
      title: '预览与应用修复补丁',
      opener,
      findingId: item.id,
      wide: true,
      build: (body, footer, close, lifecycle) => {
        body.appendChild(context.el('div', { class: 'settings-hint' }, `问题：${item.text}`));

        const filesSection = context.el('div', { class: 'fix-patch-files' });
        const checkBanner = context.el('div', { class: 'fix-patch-check' });
        const diffHost = context.el('div', { class: 'fix-patch-diff-host' });

        const extraId = `fix-extra-instruction-${item.id}`;
        const extraLabel = context.el('label', { class: 'settings-label', for: extraId }, '补充要求（可选，用于重新生成）');
        const extraInput = /** @type {HTMLTextAreaElement} */ (context.el('textarea', {
          id: extraId,
          class: 'settings-input findings-dialog-textarea',
          maxlength: '8000',
          placeholder: '例如：保持某函数签名不变、改用现有工具函数…',
          spellcheck: 'false',
        }));
        extraInput.value = initialExtra;

        const regenStatusHost = context.el('div', { class: 'fix-dialog-status-host', style: 'display:none' });
        const confirmBox = context.el('div', { class: 'findings-warning-banner fix-apply-confirm-box', style: 'display:none' });
        const errorEl = context.el('div', { class: 'findings-error-inline', style: 'display:none' });

        body.appendChild(filesSection);
        body.appendChild(checkBanner);
        body.appendChild(diffHost);
        body.appendChild(extraLabel);
        body.appendChild(extraInput);
        body.appendChild(regenStatusHost);
        body.appendChild(confirmBox);
        body.appendChild(errorEl);

        const cancelBtn = /** @type {HTMLButtonElement} */ (context.el('button', {
          class: 'btn',
          type: 'button',
          onClick: close,
        }, '关闭'));
        const regenBtn = /** @type {HTMLButtonElement} */ (context.el('button', {
          class: 'btn',
          type: 'button',
        }, '重新生成'));
        const applyBtn = /** @type {HTMLButtonElement} */ (context.el('button', {
          class: 'btn btn-primary',
          type: 'button',
        }, '应用到工作区'));

        const renderPreviewContent = () => {
          filesSection.textContent = '';
          const filesList = Array.isArray(currentPreview.files) ? currentPreview.files : [];
          if (filesList.length) {
            for (const f of filesList) {
              const fileChip = context.el('div', { class: 'fix-patch-file-item' });
              fileChip.appendChild(context.el('span', { class: 'fix-patch-file-path' }, f.path));
              fileChip.appendChild(context.el('span', { class: 'stat-add' }, `+${f.additions || 0}`));
              fileChip.appendChild(context.el('span', { class: 'stat-del' }, `-${f.deletions || 0}`));
              filesSection.appendChild(fileChip);
            }
          } else {
            filesSection.appendChild(context.el('span', { class: 'settings-hint' }, '未解析出有效文件变更'));
          }

          checkBanner.textContent = '';
          const ok = Boolean(currentPreview.check && currentPreview.check.ok);
          checkBanner.className = `fix-patch-check ${ok ? 'fix-patch-check-ok' : 'fix-patch-check-err'}`;
          checkBanner.textContent = ok
            ? '补丁预检通过（git apply --check 可干净应用）'
            : `补丁预检未通过：${(currentPreview.check && currentPreview.check.error) || '无法安全应用到当前工作区'}`;

          diffHost.textContent = '';
          diffHost.appendChild(renderUnifiedDiff(currentPreview.diff || ''));

          confirmingApply = false;
          confirmBox.style.display = 'none';
          confirmBox.textContent = '';
          applyBtn.disabled = busy || !ok;
          regenBtn.disabled = busy;
        };

        const doApplyConfirmed = async () => {
          if (!lifecycle.isActive() || busy || !currentPreview.check?.ok || context.getFolder() !== folder) return;
          busy = true;
          applyBtn.disabled = true;
          regenBtn.disabled = true;
          errorEl.style.display = 'none';
          try {
            await context.api.applyFixPatch({
              folder,
              patchId: currentPreview.patchId,
              confirmed: true,
            });
            if (epoch !== projectEpoch || context.getFolder() !== folder) return;
            context.appliedPatches.set(item.id, currentPreview.patchId);
            context.findingErrors.delete(item.id);
            context.toast('补丁已应用到工作区（未暂存、未提交）', 'success');
            context.bus.dispatchEvent(new CustomEvent('changes:rescan'));
            context.render();
            close();
          } catch (err) {
            if (!lifecycle.isActive() || context.getFolder() !== folder) return;
            const msg = context.errText(err);
            errorEl.textContent = '应用补丁失败：' + msg;
            errorEl.style.display = '';
            context.toast('应用补丁失败：' + msg, 'error');
          } finally {
            busy = false;
            applyBtn.disabled = !currentPreview.check?.ok;
            regenBtn.disabled = false;
          }
        };

        applyBtn.addEventListener('click', () => {
          if (busy || !currentPreview.check?.ok || context.getFolder() !== folder) return;
          if (!confirmingApply) {
            confirmingApply = true;
            confirmBox.textContent = '';
            confirmBox.style.display = '';
            confirmBox.appendChild(context.el('div', { class: 'fix-apply-confirm-text' },
              '确认将该补丁写入工作区？此操作仅修改工作区文件（working-tree files only），不会执行 git add 暂存或 git commit 提交。'));
            const confirmActions = context.el('div', { class: 'fix-apply-confirm-actions' });
            const cancelConfirmBtn = context.el('button', {
              class: 'btn finding-action-btn',
              type: 'button',
              onClick: () => {
                confirmingApply = false;
                confirmBox.style.display = 'none';
              },
            }, '返回');
            const finalConfirmBtn = /** @type {HTMLButtonElement} */ (context.el('button', {
              class: 'btn btn-primary finding-action-btn',
              type: 'button',
              onClick: () => {
                doApplyConfirmed();
              },
            }, '确认修改工作区文件'));
            confirmActions.appendChild(cancelConfirmBtn);
            confirmActions.appendChild(finalConfirmBtn);
            confirmBox.appendChild(confirmActions);
            finalConfirmBtn.focus();
          }
        });

        regenBtn.addEventListener('click', async () => {
          if (!lifecycle.isActive() || busy || context.getFolder() !== folder) return;
          const extraInstruction = extraInput.value.trim();
          if (extraInstruction.length > 8000) {
            errorEl.textContent = '补充要求最多 8000 字';
            errorEl.style.display = '';
            return;
          }
          busy = true;
          regenBtn.disabled = true;
          applyBtn.disabled = true;
          confirmingApply = false;
          confirmBox.style.display = 'none';
          errorEl.style.display = 'none';
          const runId = `fix-patch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
          const runStatus = createRunStatus({
            el: context.el,
            api: context.api,
            bus: context.bus,
            runId,
            label: '正在重新生成修复补丁…',
            skeleton: false,
            compact: true,
            showDetails: typeof context.showRunDetails === 'function' ? () => context.showRunDetails() : null,
            toast: context.toast,
            errText: context.errText,
          });
          lifecycle.onDispose(() => runStatus.dispose());
          regenStatusHost.textContent = '';
          regenStatusHost.style.display = '';
          regenStatusHost.appendChild(runStatus.root);
          try {
            const nextPreview = await context.api.generateFixPatch({
              folder,
              findingId: item.id,
              runId,
              extraInstruction,
            });
            if (!lifecycle.isActive() || context.getFolder() !== folder) return;
            currentPreview = nextPreview;
            renderPreviewContent();
          } catch (err) {
            if (!lifecycle.isActive() || context.getFolder() !== folder) return;
            const msg = context.errText(err);
            errorEl.textContent = '重新生成失败：' + msg;
            errorEl.style.display = '';
          } finally {
            runStatus.dispose();
            regenStatusHost.textContent = '';
            regenStatusHost.style.display = 'none';
            busy = false;
            regenBtn.disabled = false;
            applyBtn.disabled = !currentPreview.check?.ok;
          }
        });

        footer.appendChild(cancelBtn);
        footer.appendChild(regenBtn);
        footer.appendChild(applyBtn);
        renderPreviewContent();
        return currentPreview.check?.ok ? applyBtn : extraInput;
      },
    });
  }

  return {
    get openPatchDialog() { return openPatchDialog; },
    get isBackendUnsupportedMessage() { return isBackendUnsupportedMessage; },
    get openHandoffDialog() { return openHandoffDialog; },
  };
}

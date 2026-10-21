import { createRunStatus } from '../runStatus.js';
import { confirmDialog } from '../dialog.js';

export function createFixOperations(context) {
  /**
   * @param {Finding} item
   * @param {HTMLElement} opener
   */
  async function runGenerateFixPatch(item, opener) {
    const folder = context.getFolder();
    if (!folder || context.runningOps.has(item.id) || typeof context.api.generateFixPatch !== 'function') return;
    context.findingErrors.delete(item.id);
    const runId = `fix-patch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const status = createRunStatus({
      el: context.el,
      api: context.api,
      bus: context.bus,
      runId,
      label: '正在生成修复补丁…',
      skeleton: false,
      compact: true,
      showDetails: typeof context.showRunDetails === 'function' ? () => context.showRunDetails() : null,
      toast: context.toast,
      errText: context.errText,
    });
    context.runningOps.set(item.id, { kind: 'patch', runId, status });
    context.render();
    try {
      const preview = await context.api.generateFixPatch({
        folder,
        findingId: item.id,
        runId,
      });
      if (context.getFolder() !== folder) return;
      context.savedPatches.set(item.id, preview.patchId);
      for (const warning of preview.persistenceWarnings || []) context.toast(warning, 'error');
      context.openPatchDialog(item, preview, opener);
    } catch (err) {
      if (context.getFolder() !== folder) return;
      const msg = context.errText(err);
      if (!msg.includes('已被用户终止')) {
        context.findingErrors.set(item.id, {
          message: msg,
          backendUnsupported: context.isBackendUnsupportedMessage(msg),
        });
      }
    } finally {
      status.dispose();
      if (context.runningOps.get(item.id)?.runId === runId) context.runningOps.delete(item.id);
      if (context.getFolder() === folder) context.render();
    }
  }

  /**
   * @param {Finding} item
   * @param {HTMLElement} [opener]
   */
  async function runRevertFixPatch(item, opener) {
    const folder = context.getFolder();
    const patchId = context.appliedPatches.get(item.id);
    if (!folder || !patchId || context.savingIds.has(item.id) || typeof context.api.revertFixPatch !== 'function') return;
    if (!(await confirmDialog({ title: '撤销补丁', message: '确认撤销此修复补丁？此操作会修改原项目的工作区文件。', confirmText: '确认撤销', danger: true }))) return;
    if (context.getFolder() !== folder) return;
    context.savingIds.add(item.id);
    context.findingErrors.delete(item.id);
    context.render();
    try {
      const result = await context.api.revertFixPatch({ folder, patchId, confirmed: true });
      if (context.getFolder() !== folder) return;
      if (result.finding) {
        const index = context.findings.findIndex((finding) => finding.id === result.finding.id);
        if (index >= 0) context.findings[index] = result.finding;
      }
      context.appliedPatches.delete(item.id);
      context.savedPatches.set(item.id, patchId);
      context.toast('已撤销修复补丁', 'success');
      context.bus.dispatchEvent(new CustomEvent('changes:rescan'));
    } catch (err) {
      if (context.getFolder() !== folder) return;
      const msg = context.errText(err);
      context.findingErrors.set(item.id, { message: `撤销补丁失败：${msg}`, backendUnsupported: false });
      context.toast('撤销补丁失败：' + msg, 'error');
    } finally {
      if (context.getFolder() === folder) {
        context.savingIds.delete(item.id);
        context.render();
        const row = [...context.container.querySelectorAll('.finding-row')].find(
          (node) => node instanceof HTMLElement && node.dataset && node.dataset.findingId === item.id,
        );
        const focusTarget = (row instanceof HTMLElement && row.querySelector('button:not([disabled]), input:not([disabled])'))
          || row
          || context.container.querySelector('.findings-list, .findings-panel')
          || context.container;
        if (focusTarget instanceof HTMLElement && (!opener || !document.contains(opener))) {
          if (focusTarget.tabIndex < 0 && !focusTarget.hasAttribute('tabindex')) focusTarget.tabIndex = -1;
          focusTarget.focus();
        }
      }
    }
  }

  /**
   * @param {Finding} item
   */
  async function runVerifyFinding(item) {
    const folder = context.getFolder();
    if (!folder || context.runningOps.has(item.id) || typeof context.api.verifyFinding !== 'function') return;
    context.findingErrors.delete(item.id);
    const runId = `fix-verify-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const status = createRunStatus({
      el: context.el,
      api: context.api,
      bus: context.bus,
      runId,
      label: '正在复核此问题…',
      skeleton: false,
      compact: true,
      showDetails: typeof context.showRunDetails === 'function' ? () => context.showRunDetails() : null,
      toast: context.toast,
      errText: context.errText,
    });
    context.runningOps.set(item.id, { kind: 'verify', runId, status });
    context.render();
    try {
      const res = await context.api.verifyFinding({
        folder,
        findingId: item.id,
        runId,
      });
      if (context.getFolder() !== folder) return;
      if (res && res.finding) {
        const idx = context.findings.findIndex((f) => f.id === item.id);
        if (idx >= 0) context.findings[idx] = res.finding;
      }
      await context.reloadFromStore(folder);
      if (context.getFolder() !== folder) return;
      if (res && res.verdict) {
        context.toast(`复核结果：${res.verdict}${res.note ? `（${res.note}）` : ''}`, 'success');
      } else {
        context.toast('复核完成，但未解析出有效结论', 'info');
      }
    } catch (err) {
      if (context.getFolder() !== folder) return;
      const msg = context.errText(err);
      if (!msg.includes('已被用户终止')) {
        context.findingErrors.set(item.id, {
          message: msg,
          backendUnsupported: context.isBackendUnsupportedMessage(msg),
        });
      }
    } finally {
      status.dispose();
      if (context.runningOps.get(item.id)?.runId === runId) context.runningOps.delete(item.id);
      if (context.getFolder() === folder) context.render();
    }
  }

  /**
   * @param {Finding} item
   * @param {HTMLButtonElement} opener
   */
  async function runOpenSavedPatch(item, opener) {
    const folder = context.getFolder();
    const patchId = context.savedPatches.get(item.id);
    if (!folder || !patchId || typeof context.api.openFixPatch !== 'function') return;
    opener.disabled = true;
    try {
      const preview = await context.api.openFixPatch({ folder, patchId });
      if (context.getFolder() !== folder) return;
      context.openPatchDialog(item, preview, opener);
    } catch (err) {
      if (context.getFolder() !== folder) return;
      const msg = context.errText(err);
      context.savedPatches.delete(item.id);
      context.toast('打开补丁失败：' + msg, 'error');
      context.render();
    } finally {
      opener.disabled = false;
    }
  }

  return {
    get runOpenSavedPatch() { return runOpenSavedPatch; },
    get runGenerateFixPatch() { return runGenerateFixPatch; },
    get runVerifyFinding() { return runVerifyFinding; },
    get runRevertFixPatch() { return runRevertFixPatch; },
  };
}

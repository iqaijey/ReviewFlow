// 结构化问题清单与规则建议视图（含多维过滤、不处理原因弹窗、.reviewflow.md 预览与确认追加、修复补丁与交接任务）
export { formatFindingLocation } from './findingsView/shared.js';
import { createDialogs } from './findingsView/dialogs.js';
import { createPatchDialogs } from './findingsView/patchDialogs.js';
import { createFixOperations } from './findingsView/fixOperations.js';
import { createStatus } from './findingsView/status.js';
import { createRuleSuggestions } from './findingsView/ruleSuggestions.js';
import { createList } from './findingsView/list.js';
import { confirmDialog } from './dialog.js';

/**
 * @param {{
 *   container: HTMLElement,
 *   el: (tag: string, attrs?: Record<string, any>, children?: any) => HTMLElement,
 *   api: AutoReviewApi,
 *   bus: EventTarget,
 *   getFolder: () => string | null,
 *   toast: (msg: string, type?: string) => void,
 *   errText: (err: any) => string,
 *   showRunDetails?: (() => void) | null,
 * }} opts
 */
export function createFindingsView({ container, el, api, bus, getFolder, toast, errText, showRunDetails = null }) {
  const context = {
  get el() { return el; },
  get getFolder() { return getFolder; },
  get api() { return api; },
  get toast() { return toast; },
  get openAccessibleDialog() { return dialogs.openAccessibleDialog; },
  get errText() { return errText; },
  get appliedPatches() { return appliedPatches; },
  get savedPatches() { return savedPatches; },
  get findingErrors() { return findingErrors; },
  get bus() { return bus; },
  get render() { return list.render; },
  get showRunDetails() { return showRunDetails; },
  get runningOps() { return runningOps; },
  get openPatchDialog() { return patchDialogs.openPatchDialog; },
  get isBackendUnsupportedMessage() { return patchDialogs.isBackendUnsupportedMessage; },
  get savingIds() { return savingIds; },
  get findings() { return findings; },
  set findings(value) { findings = value; },
  get reloadFromStore() { return reloadFromStore; },
  get refreshSuggestions() { return refreshSuggestions; },
  get severityFilter() { return severityFilter; },
  set severityFilter(value) { severityFilter = value; },
  get categoryFilter() { return categoryFilter; },
  set categoryFilter(value) { categoryFilter = value; },
  get statusFilter() { return statusFilter; },
  set statusFilter(value) { statusFilter = value; },
  get container() { return container; },
  get suggestions() { return suggestions; },
  set suggestions(value) { suggestions = value; },
  get selectedIds() { return selectedIds; },
  get openHandoffDialog() { return patchDialogs.openHandoffDialog; },
  get runGenerateFixPatch() { return fixOperations.runGenerateFixPatch; },
  get runVerifyFinding() { return fixOperations.runVerifyFinding; },
  get runRevertFixPatch() { return fixOperations.runRevertFixPatch; },
  get runOpenSavedPatch() { return fixOperations.runOpenSavedPatch; },
  get mutateStatus() { return status.mutateStatus; },
  get openDismissDialog() { return status.openDismissDialog; },
  get openRuleAppendDialog() { return ruleSuggestions.openRuleAppendDialog; },
  get clearAllFindings() { return clearAllFindings; },
  };

  /** @type {Finding[]} */
  let findings = [];
  /** @type {RuleSuggestion[]} */
  let suggestions = [];
  /** @type {Set<string>} */
  const savingIds = new Set();
  /** @type {Set<string>} */
  const selectedIds = new Set();
  /** @type {Map<string, string>} */
  const appliedPatches = new Map();
  /** @type {Map<string, string>} 已生成但未应用的补丁（findingId → patchId） */
  const savedPatches = new Map();
  /** @type {Map<string, { message: string, backendUnsupported: boolean }>} */
  const findingErrors = new Map();
  /** @type {Map<string, { kind: 'patch' | 'verify', runId: string, status: ReturnType<typeof import('./runStatus.js').createRunStatus> }>} */
  const runningOps = new Map();

  let severityFilter = 'all';
  let categoryFilter = 'all';
  let statusFilter = 'all';
  let loadSeq = 0;
  let jumpCursor = -1;

  function jumpOpenFinding(step) {
    const openWithLoc = findings.filter(
  (it) => (it.status === 'pending' || it.status === 'partial') && it.location && it.location.path,
    );
    if (!openWithLoc.length) {
  toast('当前没有可跳转的未关闭问题', 'info');
  return;
    }
    if (jumpCursor < 0 || jumpCursor >= openWithLoc.length) {
  jumpCursor = step >= 0 ? 0 : openWithLoc.length - 1;
    } else {
  jumpCursor = (jumpCursor + step + openWithLoc.length) % openWithLoc.length;
    }
    const target = openWithLoc[jumpCursor];
    bus.dispatchEvent(new CustomEvent('diff:jump', {
  detail: {
    folder: getFolder(),
    diffFingerprint: null,
    location: target.location || null,
  },
    }));
  }

  bus.addEventListener('findings:jump', (ev) => {
    const detail = /** @type {CustomEvent} */ (ev).detail || {};
    const step = detail.direction === 'prev' ? -1 : 1;
    jumpOpenFinding(step);
  });

  const dialogs = createDialogs(context);

  async function refreshSuggestions(folder = getFolder()) {
    if (folder !== getFolder()) return;
    if (!folder || typeof api.checklistRuleSuggestions !== 'function') {
  suggestions = [];
  return;
    }
    try {
  const list = await api.checklistRuleSuggestions({ folder });
  if (folder !== getFolder()) return;
  suggestions = Array.isArray(list) ? list : [];
    } catch {
  if (folder !== getFolder()) return;
  console.warn('读取规则建议失败');
  suggestions = [];
    }
  }

  /**
   * 补丁读取失败不影响问题清单本身显示
   * @param {string} folder
   * @returns {Promise<FixPatchSummary[]>}
   */
  async function loadStoredPatches(folder) {
    if (typeof api.listFixPatches !== 'function') return [];
    try {
      const list = await api.listFixPatches({ folder });
      return Array.isArray(list) ? list : [];
    } catch (err) {
      toast('读取已保存的修复补丁失败：' + errText(err), 'error');
      return [];
    }
  }

  async function reloadFromStore(folder = getFolder()) {
    if (folder !== getFolder()) return;
    const seq = ++loadSeq;
    if (!folder || typeof api.checklistList !== 'function') {
  findings = [];
  suggestions = [];
  list.render();
  return;
    }
    try {
  const [loadedFindings, storedPatches] = await Promise.all([
    api.checklistList(folder),
    loadStoredPatches(folder),
    refreshSuggestions(folder),
  ]);
  if (seq !== loadSeq || folder !== getFolder()) return;
  findings = Array.isArray(loadedFindings) ? loadedFindings : [];
  appliedPatches.clear();
  savedPatches.clear();
  for (const patch of storedPatches) (patch.applied ? appliedPatches : savedPatches).set(patch.findingId, patch.patchId);
  list.render();
    } catch (err) {
  if (seq !== loadSeq || folder !== getFolder()) return;
  toast('问题清单读取失败：' + errText(err), 'error');
    }
  }

  /**
   * @param {Finding[]} nextFindings
   * @param {string | null} [folder]
   */
  async function setFindings(nextFindings, folder = getFolder()) {
    if (folder !== getFolder()) return;
    loadSeq++;
    findings = Array.isArray(nextFindings) ? nextFindings : [];
    await refreshSuggestions(folder);
    if (folder !== getFolder()) return;
    list.render();
  }

  /** @param {HTMLButtonElement} opener */
  async function clearAllFindings(opener) {
    const folder = getFolder();
    if (!folder || typeof api.checklistClear !== 'function') return;
    if (runningOps.size) {
      toast('有问题正在生成补丁或复核，请等它结束后再清空', 'info');
      return;
    }
    const patchNote = appliedPatches.size
      ? ` 其中 ${appliedPatches.size} 条已应用的修复补丁将无法再从界面撤销。`
      : '';
    const ok = await confirmDialog({
      title: '清空问题清单',
      message: `将删除本项目全部 ${findings.length} 条问题（含待处理、已修复、不处理），下次评审不再核对这些旧问题。评审历史不受影响。${patchNote}`,
      confirmText: '确认清空',
      danger: true,
    });
    if (!ok || folder !== getFolder()) return;
    opener.disabled = true;
    try {
      const next = await api.checklistClear({ folder, confirmed: true });
      if (folder !== getFolder()) return;
      selectedIds.clear();
      appliedPatches.clear();
      savedPatches.clear();
      findingErrors.clear();
      await setFindings(next, folder);
      toast('问题清单已清空', 'success');
    } catch (err) {
      opener.disabled = false;
      toast('清空问题清单失败：' + errText(err), 'error');
    }
  }

  function clear() {
    loadSeq++;
    findings = [];
    suggestions = [];
    selectedIds.clear();
    savingIds.clear();
    appliedPatches.clear();
    savedPatches.clear();
    findingErrors.clear();
    for (const op of runningOps.values()) {
  op.status.dispose();
    }
    runningOps.clear();
    list.render();
  }

  const patchDialogs = createPatchDialogs(context);

  const fixOperations = createFixOperations(context);

  const status = createStatus(context);

  const ruleSuggestions = createRuleSuggestions(context);

  const list = createList(context);
  bus.addEventListener('project:changed', clear);

  return {
    reloadFromStore,
    setFindings,
    clear,
    getFindings: () => findings,
  };
}

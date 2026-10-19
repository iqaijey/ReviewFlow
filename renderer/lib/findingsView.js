// 结构化问题清单与规则建议视图（含多维过滤、不处理原因弹窗、.reviewflow.md 预览与确认追加、修复补丁与交接任务）
export { formatFindingLocation } from './findingsView/shared.js';
import { createDialogs } from './findingsView/dialogs.js';
import { createPatchDialogs } from './findingsView/patchDialogs.js';
import { createFixOperations } from './findingsView/fixOperations.js';
import { createStatus } from './findingsView/status.js';
import { createRuleSuggestions } from './findingsView/ruleSuggestions.js';
import { createList } from './findingsView/list.js';

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
  get mutateStatus() { return status.mutateStatus; },
  get openDismissDialog() { return status.openDismissDialog; },
  get openRuleAppendDialog() { return ruleSuggestions.openRuleAppendDialog; },
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
  const [loadedFindings] = await Promise.all([
    api.checklistList(folder),
    refreshSuggestions(folder),
  ]);
  if (seq !== loadSeq || folder !== getFolder()) return;
  findings = Array.isArray(loadedFindings) ? loadedFindings : [];
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

  function clear() {
    loadSeq++;
    findings = [];
    suggestions = [];
    selectedIds.clear();
    savingIds.clear();
    appliedPatches.clear();
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

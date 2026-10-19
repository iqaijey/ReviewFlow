import { formatRunEstimate, planReviewEnabled } from '../../lib/aiShared.js';

export function createEstimate(context) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let estimateTimer = null;
  let estimateSeq = 0;
  context.bus.addEventListener('project:changed', () => {
    estimateSeq++;
    if (estimateTimer) clearTimeout(estimateTimer);
    context.estimateBadge.style.display = 'none';
  });

  const runEstimateRefresh = async () => {
    const seq = ++estimateSeq;
    const folder = context.state.folder;
    const changes = context.state.changes;
    if (!folder || !changes || !Array.isArray(changes.files) || !changes.files.length || typeof context.api.estimateRun !== 'function') {
      context.estimateBadge.style.display = 'none';
      return;
    }
    const checkedMulti = context.multiOn
      ? [...context.multiBoxes].filter(([, b]) => b.checked).map(([v]) => v)
      : [];
    if (context.multiOn && checkedMulti.length < 2) {
      context.estimateBadge.textContent = '无法估算';
      context.estimateBadge.title = '多模型评审请至少选择 2 个模型';
      context.estimateBadge.style.display = '';
      return;
    }
    try {
      /** @type {EstimatePayload} */
      const payload = {
        folder,
        kind: 'overview',
        snapshotId: changes.snapshotId || undefined,
        noiseLevelOverride: context.selectedNoiseOverride(),
        planEnabled: planReviewEnabled(),
        multiModels: checkedMulti.length >= 2
          ? {
              models: checkedMulti.map((b) => ({ backend: /** @type {ReviewModelResult['backend']} */ (b) })),
              synthesizer: { backend: /** @type {ReviewModelResult['backend']} */ (context.synSelect.value || 'api') },
            }
          : undefined,
      };
      const est = await context.api.estimateRun(payload);
      if (seq !== estimateSeq || context.state.folder !== folder) return;
      const formatted = formatRunEstimate(est);
      context.estimateBadge.textContent = formatted.text;
      context.estimateBadge.title = formatted.tooltip;
      context.estimateBadge.style.display = '';
    } catch {
      if (seq !== estimateSeq || context.state.folder !== folder) return;
      context.estimateBadge.textContent = '无法估算';
      context.estimateBadge.title = '';
      context.estimateBadge.style.display = '';
    }
  };

  const scheduleEstimateRefresh = () => {
    if (estimateTimer) clearTimeout(estimateTimer);
    for (const ctrl of context.fileCardControllers.values()) {
      if (typeof ctrl.invalidateEstimate === 'function') ctrl.invalidateEstimate();
    }
    if (!context.state.folder || !context.state.changes || !context.state.changes.files.length) {
      context.estimateBadge.style.display = 'none';
      return;
    }
    estimateTimer = setTimeout(() => {
      estimateTimer = null;
      runEstimateRefresh();
    }, 400);
  };

  return {
  get scheduleEstimateRefresh() { return scheduleEstimateRefresh; },
  };
}

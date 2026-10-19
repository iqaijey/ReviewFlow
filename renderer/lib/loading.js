import { createRunStatus } from './runStatus.js';

export function createLoadingNode(el, ctx, text, opts = {}) {
  const status = createRunStatus({
    el,
    api: ctx.api,
    bus: ctx.bus,
    runId: opts.runId || '',
    label: text,
    skeleton: opts.skeleton !== false,
    compact: Boolean(opts.compact),
    showDetails: typeof ctx.showRunDetails === 'function' ? () => ctx.showRunDetails() : null,
    onCancel: opts.onCancel || null,
    toast: ctx.toast || null,
    errText: ctx.errText || null,
  });
  return status.root;
}


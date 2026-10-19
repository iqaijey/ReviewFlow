import { BACKEND_LABELS } from './aiShared.js';

/** @type {Record<string, string>} */
export const RUN_KIND_LABELS = {
  overview: '整体分析',
  review: '整体分析',
  full: '完整讲解',
  fullExplain: '完整讲解',
  file: '逐文件分析',
  explain: '逐句解析',
  line: '逐句解析',
  followup: '追问',
  chat: '追问',
  'review-section': '追问',
  plan: '方案生成',
  multi: '多模型汇总',
  synthesis: '多模型汇总',
  patch: '修复补丁',
  'fix-patch': '修复补丁',
  '生成修复补丁': '修复补丁',
  verify: '问题复核',
  'fix-verify': '问题复核',
  '复核问题': '问题复核',
  test: '测试连接',
  testConnection: '测试连接',
};

/**
 * @param {string | null | undefined} kind
 * @returns {string}
 */
export function formatRunKind(kind) {
  if (!kind || typeof kind !== 'string') return 'AI 调用';
  const trimmed = kind.trim();
  if (!trimmed) return 'AI 调用';
  if (RUN_KIND_LABELS[trimmed]) return RUN_KIND_LABELS[trimmed];
  if (/[\u4e00-\u9fa5]/.test(trimmed)) return trimmed;
  return 'AI 调用';
}

/** @type {WeakMap<EventTarget, any[]>} */
const latestRunsByBus = new WeakMap();

/**
 * @param {EventTarget} bus
 */
function ensureBusTracker(bus) {
  if (latestRunsByBus.has(bus)) return;
  latestRunsByBus.set(bus, []);
  bus.addEventListener('runs:changed', (ev) => {
    const detail = /** @type {CustomEvent} */ (ev).detail;
    latestRunsByBus.set(bus, Array.isArray(detail) ? detail : []);
  });
}

/**
 * @param {number} ms
 * @returns {string}
 */
export function formatElapsedMmSs(ms) {
  const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * @param {any} run
 * @returns {string}
 */
export function formatRunStage(run) {
  if (!run || typeof run !== 'object') return '';
  const parts = [];
  if (run.paused) {
    parts.push('已暂停');
  }
  const batchTotal = Number(run.batchTotal) || 0;
  const batchIndex = Number(run.batchIndex) || 0;
  if (batchTotal > 1 && batchIndex > 0) {
    parts.push(`第 ${batchIndex}/${batchTotal} 批`);
  } else if (run.batch) {
    parts.push(String(run.batch));
  }
  if (run.backend) {
    parts.push(BACKEND_LABELS[run.backend] || String(run.backend));
  }
  if (run.model) {
    parts.push(String(run.model));
  }
  return parts.join(' · ');
}

/**
 * @param {{
 *   el: (tag: string, attrs?: Record<string, any>, children?: any) => HTMLElement,
 *   api: AutoReviewApi,
 *   bus?: EventTarget | null,
 *   runId: string,
 *   label?: string,
 *   skeleton?: boolean,
 *   compact?: boolean,
 *   showDetails?: (() => void) | null,
 *   onCancel?: ((runId: string) => Promise<any> | void) | null,
 *   toast?: ((msg: string, type?: string) => void) | null,
 *   errText?: ((err: any) => string) | null,
 * }} opts
 */
export function createRunStatus({
  el,
  api,
  bus = null,
  runId,
  label = 'AI 分析中，请稍候…',
  skeleton = true,
  compact = false,
  showDetails = null,
  onCancel = null,
  toast = null,
  errText = (e) => String((e && e.message) || e),
}) {
  let disposed = false;
  let startedAt = Date.now();
  let paused = false;
  let pausedAt = 0;
  let pausedAccumMs = 0;
  let lastStageText = '';

  const root = el('div', {
    class: `review-loading ai-loading run-status${compact ? ' run-status-compact' : ''}`,
    dataset: { runId: runId || '' },
  });

  const head = el('div', { class: 'ai-loading-head run-status-head' });
  const spinner = el('span', { class: 'spinner', 'aria-hidden': 'true' });

  // aria-live 仅包裹状态主文案与阶段变更，不包含每秒跳动的计时器
  const liveRegion = el('span', {
    class: 'run-status-live',
    'aria-live': 'polite',
  });
  const labelEl = el('span', { class: 'run-status-label' }, label);
  const stageEl = el('span', { class: 'run-status-stage' }, '');
  liveRegion.appendChild(labelEl);
  liveRegion.appendChild(stageEl);

  const elapsedEl = el('span', {
    class: 'run-status-elapsed run-elapsed',
    'aria-hidden': 'true',
  }, '· 已用 00:00');

  const actions = el('div', { class: 'run-status-actions' });
  const stopBtn = /** @type {HTMLButtonElement} */ (el('button', {
    class: 'btn btn-danger run-status-stop',
    type: 'button',
    'aria-label': '停止当前运行',
  }, '停止'));

  stopBtn.addEventListener('click', async () => {
    if (disposed || stopBtn.disabled) return;
    stopBtn.disabled = true;
    stopBtn.textContent = '正在停止…';
    try {
      if (typeof onCancel === 'function') {
        await onCancel(runId);
      } else if (api && typeof api.cancelRun === 'function') {
        await api.cancelRun(runId);
      }
    } catch (err) {
      if (!disposed) {
        stopBtn.disabled = false;
        stopBtn.textContent = '停止';
        if (toast) toast('停止失败：' + (errText ? errText(err) : String(err)), 'error');
      }
    }
  });
  actions.appendChild(stopBtn);

  if (typeof showDetails === 'function') {
    const detailsBtn = el('button', {
      class: 'run-link',
      type: 'button',
      onClick: () => showDetails(),
    }, '运行详情');
    actions.appendChild(detailsBtn);
  }

  head.appendChild(spinner);
  head.appendChild(liveRegion);
  head.appendChild(elapsedEl);
  head.appendChild(actions);
  root.appendChild(head);

  if (skeleton) {
    const skeletonEl = el('div', { class: 'ai-skeleton', 'aria-hidden': 'true' });
    for (const w of ['92%', '100%', '78%', '96%', '60%']) {
      skeletonEl.appendChild(el('div', { class: 'ai-skeleton-line', style: `width:${w}` }));
    }
    root.appendChild(skeletonEl);
  }

  const computeElapsedMs = () => {
    const now = paused ? pausedAt : Date.now();
    return Math.max(0, now - startedAt - pausedAccumMs);
  };

  const renderElapsed = () => {
    if (disposed) return;
    const mmss = formatElapsedMmSs(computeElapsedMs());
    elapsedEl.textContent = paused ? `已暂停 · 已用 ${mmss}` : `· 已用 ${mmss}`;
  };

  const applyRunItem = (run) => {
    if (disposed || !run) return;
    if (typeof run.startedAt === 'number' && run.startedAt > 0 && run.startedAt < startedAt && !run.paused) {
      startedAt = run.startedAt;
    }
    const nextPaused = Boolean(run.paused);
    if (nextPaused && !paused) {
      paused = true;
      pausedAt = (typeof run.pausedAt === 'number' && run.pausedAt >= startedAt)
        ? run.pausedAt
        : Date.now();
      spinner.style.animationPlayState = 'paused';
    } else if (!nextPaused && paused) {
      paused = false;
      if (pausedAt > 0) {
        pausedAccumMs += Math.max(0, Date.now() - pausedAt);
      }
      pausedAt = 0;
      spinner.style.animationPlayState = '';
    }
    const stageText = formatRunStage(run);
    if (stageText !== lastStageText) {
      lastStageText = stageText;
      stageEl.textContent = stageText ? `· ${stageText}` : '';
    }
    renderElapsed();
  };

  const findMatchingRun = (runs) => {
    if (!Array.isArray(runs) || !runs.length) return null;
    if (runId) {
      const exact = runs.find((r) => r && r.runId === runId);
      if (exact) return exact;
      const prefix = runs.find((r) => r && typeof r.runId === 'string' && r.runId.startsWith(`${runId}-`));
      if (prefix) return prefix;
    }
    return null;
  };

  /** @type {((ev: Event) => void) | null} */
  let busListener = null;
  /** @type {(() => void) | null} */
  let ipcUnsub = null;

  if (bus && typeof bus.addEventListener === 'function') {
    ensureBusTracker(bus);
    busListener = (ev) => {
      const detail = /** @type {CustomEvent} */ (ev).detail;
      const matched = findMatchingRun(detail);
      if (matched) applyRunItem(matched);
    };
    bus.addEventListener('runs:changed', busListener);
    const cached = latestRunsByBus.get(bus);
    const initialMatch = findMatchingRun(cached);
    if (initialMatch) applyRunItem(initialMatch);
  } else if (api && typeof api.onRunsChanged === 'function') {
    ipcUnsub = api.onRunsChanged((runs) => {
      const matched = findMatchingRun(runs);
      if (matched) applyRunItem(matched);
    });
  }

  const timerId = setInterval(renderElapsed, 1000);

  const setLabel = (nextLabel) => {
    if (disposed) return;
    labelEl.textContent = String(nextLabel || '');
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timerId);
    if (bus && busListener) {
      bus.removeEventListener('runs:changed', busListener);
      busListener = null;
    }
    if (ipcUnsub) {
      ipcUnsub();
      ipcUnsub = null;
    }
  };

  return {
    root,
    stopBtn,
    setLabel,
    applyRunItem,
    dispose,
  };
}

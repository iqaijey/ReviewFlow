import { BACKEND_LABELS } from './lib/aiShared.js';
// 运行详情弹窗：按 runId 列出全部正在进行的 AI 调用（并发多跑道）。
// 子调用归入父任务，仅父任务提供控制；推送原地更新，保留滚动与焦点。
import { trapDialogFocus } from './lib/dialog.js';
import { formatRunKind } from './lib/runStatus.js';



export function createRunDetails(ctx) {
  const { el, api } = ctx;
  /** @type {HTMLElement | null} */
  let overlay = null;
  /** @type {HTMLElement | null} */
  let openerEl = null;
  /** @type {HTMLElement | null} */
  let closeButton = null;
  /** @type {((ev: KeyboardEvent) => void) | null} */
  let keyListener = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  /** @type {((event: CustomEvent) => void) | null} */
  let runsListener = null;
  /** @type {Map<string, any>} runId -> 卡片 DOM 引用 */
  const cards = new Map();

  const close = () => {
    if (keyListener) {
      document.removeEventListener('keydown', keyListener, true);
      keyListener = null;
    }
    if (runsListener) {
      ctx.bus.removeEventListener('runs:changed', runsListener);
      runsListener = null;
    }
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    cards.clear();
    closeButton = null;
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
    const prev = openerEl;
    openerEl = null;
    if (prev && document.contains(prev) && typeof prev.focus === 'function') {
      prev.focus();
    }
  };

  const row = (label, node) => {
    const r = el('div', { class: 'run-row' });
    r.appendChild(el('span', { class: 'run-label' }, label));
    r.appendChild(node);
    return r;
  };

  const buildCard = (runId) => {
    const card = { pausing: false, promptLoaded: false };
    const root = el('div', { class: 'run-card' });
    const head = el('div', { class: 'run-card-head' });
    const kindEl = el('span', { class: 'run-card-title' });
    const actions = el('div', { class: 'run-actions' });
    const pauseBtn = el('button', { class: 'btn run-pause', type: 'button' }, '暂停');
    pauseBtn.addEventListener('click', async () => {
      if (typeof api.pauseRun !== 'function') return;
      card.pausing = true;
      pauseBtn.disabled = true;
      pauseBtn.textContent = '暂停中…';
      try {
        await api.pauseRun(runId);
      } catch (error) {
        card.pausing = false;
        pauseBtn.disabled = false;
        pauseBtn.textContent = '暂停';
        ctx.toast('暂停失败：' + ctx.errText(error), 'error');
      }
    });
    const resumeBtn = el('button', { class: 'btn run-resume', type: 'button' }, '继续');
    resumeBtn.style.display = 'none';
    resumeBtn.addEventListener('click', async () => {
      if (typeof api.resumeRun !== 'function') return;
      resumeBtn.disabled = true;
      resumeBtn.textContent = '继续中…';
      try {
        ctx.bus.dispatchEvent(new CustomEvent('run:resuming', { detail: { runId } }));
        const result = await api.resumeRun(runId);
        ctx.bus.dispatchEvent(new CustomEvent('run:resumed', { detail: { runId, result } }));
      } catch (error) {
        ctx.bus.dispatchEvent(new CustomEvent('run:resumeFailed', { detail: { runId, error } }));
        ctx.toast('继续失败：' + ctx.errText(error), 'error');
      } finally {
        resumeBtn.disabled = false;
        resumeBtn.textContent = '继续';
      }
    });
    const cancelBtn = el('button', { class: 'btn run-cancel', type: 'button' }, '终止运行');
    cancelBtn.addEventListener('click', async () => {
      if (root.contains(document.activeElement) || document.activeElement === document.body) closeButton?.focus();
      cancelBtn.disabled = true;
      cancelBtn.textContent = '正在终止…';
      try {
        await api.cancelRun(runId);
      } catch (error) {
        cancelBtn.disabled = false;
        cancelBtn.textContent = '终止运行';
        ctx.toast('终止失败：' + ctx.errText(error), 'error');
      }
    });
    actions.appendChild(pauseBtn);
    actions.appendChild(resumeBtn);
    actions.appendChild(cancelBtn);
    head.appendChild(kindEl);
    head.appendChild(actions);

    const backendEl = el('span', {});
    const modelEl = el('span', {});
    const effortEl = el('span', {});
    const elapsedEl = el('span', { class: 'run-elapsed' });
    const progressRow = el('div', { class: 'run-progress' });
    const progressText = el('span', { class: 'run-progress-text' });
    const progressWrap = el('div', { class: 'update-progress' });
    const progressBar = el('div', { class: 'update-progress-bar' });
    progressWrap.appendChild(progressBar);
    progressRow.appendChild(progressText);
    progressRow.appendChild(progressWrap);
    const cmdEl = el('div', { class: 'run-cmd' });
    const promptTitle = el('div', { class: 'run-prompt-title' }, '');
    const promptEl = el('pre', { class: 'run-prompt' });

    const body = el('div', { class: 'run-card-body' });
    body.appendChild(row('后端', backendEl));
    body.appendChild(row('模型', modelEl));
    body.appendChild(row('思考强度', effortEl));
    body.appendChild(row('已耗时', elapsedEl));
    const progressRowLine = row('进度', progressRow);
    body.appendChild(progressRowLine);
    body.appendChild(row('命令 / 请求', cmdEl));
    body.appendChild(promptTitle);
    body.appendChild(promptEl);
    root.appendChild(head);
    root.appendChild(body);
    const children = el('div', { class: 'run-children' });
    root.appendChild(children);

    Object.assign(card, {
      root, children, actions, kindEl, pauseBtn, resumeBtn, cancelBtn,
      backendEl, modelEl, effortEl, elapsedEl,
      progressRowLine, progressText, progressBar, cmdEl, promptTitle, promptEl,
    });
    return card;
  };

  const updateCard = (card, run) => {
    card.actions.hidden = Boolean(run.parentRunId);
    card.actions.style.display = run.parentRunId ? 'none' : '';
    card.startedAt = run.startedAt;
    const batchTotal = Number(run.batchTotal) || 0;
    const batchIndex = Number(run.batchIndex) || 0;
    const batchLabel = batchTotal > 1 ? `（第 ${batchIndex}/${batchTotal} 批）` : '';
    if (run.paused) {
      card.kindEl.textContent = `已暂停${batchLabel}`;
      card.backendEl.textContent = BACKEND_LABELS[run.backend] || run.backend || '-';
      card.modelEl.textContent = run.model || '-';
      card.effortEl.textContent = run.effort ? run.effort : '-';
      card.elapsedEl.textContent = run.startedAt
        ? `${((Date.now() - run.startedAt) / 1000).toFixed(1)}s` : '-';
      card.cmdEl.textContent = run.command || '';
      card.promptTitle.textContent = '';
      card.promptEl.textContent = '';
      card.progressRowLine.style.display = 'none';
      card.pausing = false;
      card.pauseBtn.style.display = 'none';
      card.cancelBtn.style.display = '';
      card.resumeBtn.style.display = typeof api.resumeRun === 'function' ? '' : 'none';
      if (!card.resumeBtn.disabled) card.resumeBtn.textContent = '继续';
      return;
    }
    card.resumeBtn.style.display = 'none';
    card.resumeBtn.disabled = false;
    card.resumeBtn.textContent = '继续';
    card.cancelBtn.style.display = '';
    if (!card.cancelBtn.disabled) card.cancelBtn.textContent = '终止运行';
    card.pauseBtn.style.display = typeof api.pauseRun === 'function' ? '' : 'none';
    if (!card.pausing) {
      card.pauseBtn.disabled = false;
      card.pauseBtn.textContent = '暂停';
    }
    if (batchTotal > 1) {
      card.progressRowLine.style.display = '';
      card.progressText.textContent = `自动分批 ${batchIndex}/${batchTotal} · 自动连续执行，无需操作`;
      const percent = Math.max(0, Math.min(100, (batchIndex / batchTotal) * 100));
      card.progressBar.style.width = `${percent}%`;
    } else {
      card.progressRowLine.style.display = 'none';
    }
    const kindLabel = formatRunKind(run.kind);
    card.kindEl.textContent = run.batch ? `${kindLabel} ${run.batch}` : kindLabel;
    card.backendEl.textContent = BACKEND_LABELS[run.backend] || run.backend;
    card.modelEl.textContent = run.model || '-';
    card.effortEl.textContent = run.effort ? run.effort : '默认';
    card.elapsedEl.textContent = `${((Date.now() - run.startedAt) / 1000).toFixed(1)}s`;
    card.cmdEl.textContent = run.command || '';
    card.promptTitle.textContent = `Prompt（${(run.promptChars || 0).toLocaleString()} 字符）`;
    // promptText 不随列表推送，首次显示时按需取一次。
    if (!card.promptLoaded) {
      card.promptLoaded = true;
      if (typeof api.getRunPrompt === 'function') {
        api.getRunPrompt(run.runId)
          .then((text) => {
            if (text && !card.promptEl.textContent) card.promptEl.textContent = text;
          })
          .catch(() => { card.promptEl.textContent = '读取 Prompt 失败'; });
      }
    }
  };

  return function showRunDetails() {
    if (overlay) {
      close();
      return;
    }
    openerEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // overlay 在 close() 闭包中会被置空，下面用局部常量 overlayEl 承接当前实例
    const overlayEl = el('div', { class: 'modal-overlay' });
    overlay = overlayEl;
    const titleId = 'run-details-dialog-title';
    const panel = el('div', {
      class: 'run-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      tabindex: '-1',
    });
    const titleBar = el('div', { class: 'commit-modal-title', id: titleId }, '运行详情');
    const closeBtn = el('button', { class: 'btn run-close', type: 'button' }, '关闭');
    closeButton = closeBtn;
    titleBar.appendChild(closeBtn);
    const emptyEl = el('div', { class: 'run-empty' }, '当前没有正在进行的调用');
    const body = el('div', { class: 'run-body' });
    body.appendChild(emptyEl);
    panel.appendChild(titleBar);
    panel.appendChild(body);
    overlayEl.appendChild(panel);
    overlayEl.addEventListener('click', (ev) => {
      if (ev.target === overlay) close();
    });
    closeBtn.addEventListener('click', close);
    keyListener = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        close();
        return;
      }
      trapDialogFocus(panel, ev);
    };
    document.addEventListener('keydown', keyListener, true);
    document.body.appendChild(overlayEl);
    closeBtn.focus();

    const update = (runs) => {
      if (overlay !== overlayEl) return;
      emptyEl.style.display = runs.length ? 'none' : '';
      const seen = new Set();
      for (const run of runs) {
        const runId = String(run.runId || '');
        if (!runId) continue;
        seen.add(runId);
        let card = cards.get(runId);
        if (!card) {
          card = buildCard(runId);
          cards.set(runId, card);
          body.appendChild(card.root);
        }
        updateCard(card, run);
      }
      for (const run of runs) {
        const card = cards.get(String(run.runId || ''));
        const parent = run.parentRunId && seen.has(run.parentRunId) && cards.get(run.parentRunId);
        if (!card) continue;
        const host = parent && parent !== card ? parent.children : body;
        if (card.root.parentNode !== host) host.appendChild(card.root);
      }
      for (const [runId, card] of cards) {
        if (!seen.has(runId)) {
          card.root.remove();
          cards.delete(runId);
        }
      }
      if (!document.activeElement || document.activeElement === document.body || !document.contains(document.activeElement)) closeBtn.focus();
    };
    let pushed = false;
    runsListener = (event) => {
      pushed = true;
      update(event.detail);
    };
    ctx.bus.addEventListener('runs:changed', runsListener);
    api.listRuns().then((runs) => {
      if (!pushed) update(runs);
    }).catch((error) => {
      if (overlay === overlayEl) ctx.toast('获取运行状态失败：' + ctx.errText(error), 'error');
    });
    // 计时只更新本地 DOM，不再查询运行状态。
    timer = setInterval(() => {
      for (const card of cards.values()) {
        card.elapsedEl.textContent = card.startedAt
          ? `${((Date.now() - card.startedAt) / 1000).toFixed(1)}s` : '-';
      }
    }, 1000);
  };
}

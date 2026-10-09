// 运行详情弹窗：按 runId 列出全部正在进行的 AI 调用（并发多跑道）。
// 每条运行一张卡片（任务/后端/模型/命令/prompt/实时耗时/分批进度），
// 暂停/继续/终止按钮各管各的 runId；轮询 listRuns 原地更新卡片，避免闪烁与滚动丢失。
const BACKEND_LABELS = { api: 'API', opencode: 'OpenCode', kimi: 'Kimi CLI', codex: 'Codex' };

export function createRunDetails(ctx) {
  const { el, api } = ctx;
  /** @type {HTMLElement | null} */
  let overlay = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  /** @type {Map<string, any>} runId -> 卡片 DOM 引用 */
  const cards = new Map();

  const close = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    cards.clear();
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
  };

  const row = (label, node) => {
    const r = el('div', { class: 'run-row' });
    r.appendChild(el('span', { class: 'run-label' }, label));
    r.appendChild(node);
    return r;
  };

  const buildCard = (runId) => {
    const card = { pausing: false };
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
      } catch { /* 暂停失败由轮询回到运行态恢复按钮 */ }
    });
    const resumeBtn = el('button', { class: 'btn run-resume', type: 'button' }, '继续');
    resumeBtn.style.display = 'none';
    resumeBtn.addEventListener('click', async () => {
      if (typeof api.resumeRun !== 'function') return;
      resumeBtn.disabled = true;
      resumeBtn.textContent = '继续中…';
      try {
        await api.resumeRun(runId);
      } catch { /* 恢复结果由各 tab 自己的 await 接收，弹窗只负责切回运行态 */ }
    });
    const cancelBtn = el('button', { class: 'btn run-cancel', type: 'button' }, '终止运行');
    cancelBtn.addEventListener('click', async () => {
      cancelBtn.disabled = true;
      cancelBtn.textContent = '正在终止…';
      try {
        await api.cancelRun(runId);
      } catch { /* 终止失败也要让弹窗继续轮询到结束态 */ }
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

    Object.assign(card, {
      root, kindEl, pauseBtn, resumeBtn, cancelBtn,
      backendEl, modelEl, effortEl, elapsedEl,
      progressRowLine, progressText, progressBar, cmdEl, promptTitle, promptEl,
    });
    return card;
  };

  const updateCard = (card, run) => {
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
      card.cancelBtn.style.display = 'none';
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
    card.kindEl.textContent = run.batch ? `${run.kind} ${run.batch}` : run.kind;
    card.backendEl.textContent = BACKEND_LABELS[run.backend] || run.backend;
    card.modelEl.textContent = run.model || '-';
    card.effortEl.textContent = run.effort ? run.effort : '默认';
    card.elapsedEl.textContent = `${((Date.now() - run.startedAt) / 1000).toFixed(1)}s`;
    card.cmdEl.textContent = run.command || '';
    card.promptTitle.textContent = `Prompt（${(run.promptChars || 0).toLocaleString()} 字符）`;
    if (run.promptText && !card.promptEl.textContent) card.promptEl.textContent = run.promptText;
  };

  return function showRunDetails() {
    if (overlay) {
      close();
      return;
    }
    // overlay 在 close() 闭包中会被置空，下面用局部常量 overlayEl 承接当前实例
    const overlayEl = el('div', { class: 'modal-overlay' });
    overlay = overlayEl;
    const panel = el('div', { class: 'run-modal' });
    const titleBar = el('div', { class: 'commit-modal-title' }, '运行详情');
    const closeBtn = el('button', { class: 'btn run-close', type: 'button' }, '关闭');
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
    document.body.appendChild(overlayEl);

    const tick = async () => {
      /** @type {any[] | null} */
      let runs = null;
      try {
        if (typeof api.listRuns === 'function') {
          runs = await api.listRuns();
        } else {
          const run = await api.getCurrentRun();
          runs = run ? [run] : [];
        }
      } catch {
        runs = null;
      }
      if (!overlay) return;
      if (!Array.isArray(runs) || runs.length === 0) {
        emptyEl.style.display = '';
        for (const card of cards.values()) card.root.remove();
        cards.clear();
        return;
      }
      emptyEl.style.display = 'none';
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
      for (const [runId, card] of cards) {
        if (!seen.has(runId)) {
          card.root.remove();
          cards.delete(runId);
        }
      }
    };
    timer = setInterval(tick, 500);
    tick();
  };
}

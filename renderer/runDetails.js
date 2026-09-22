// 运行详情弹窗：预览当前正在进行的 AI 调用（后端/模型/命令/prompt/实时耗时）
const BACKEND_LABELS = { api: 'API', opencode: 'OpenCode', kimi: 'Kimi CLI', codex: 'Codex' };

export function createRunDetails(ctx) {
  const { el, api } = ctx;
  let overlay = null;
  let timer = null;

  const close = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
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

  return function showRunDetails() {
    if (overlay) {
      close();
      return;
    }
    overlay = el('div', { class: 'modal-overlay' });
    const panel = el('div', { class: 'run-modal' });
    const titleBar = el('div', { class: 'commit-modal-title' }, '运行详情');
    const actions = el('div', { class: 'run-actions' });
    const pauseBtn = el('button', { class: 'btn run-pause', type: 'button' }, '暂停');
    let pausing = false;
    pauseBtn.addEventListener('click', async () => {
      if (typeof api.pauseRun !== 'function') return;
      pausing = true;
      pauseBtn.disabled = true;
      pauseBtn.textContent = '暂停中…';
      try {
        await api.pauseRun();
      } catch { /* 暂停失败由轮询回到运行态恢复按钮 */ }
    });
    const resumeBtn = el('button', { class: 'btn run-resume', type: 'button' }, '继续');
    resumeBtn.style.display = 'none';
    resumeBtn.addEventListener('click', async () => {
      if (typeof api.resumeRun !== 'function') return;
      resumeBtn.disabled = true;
      resumeBtn.textContent = '继续中…';
      try {
        await api.resumeRun();
      } catch { /* 恢复结果由各 tab 自己的 await 接收，弹窗只负责切回运行态 */ }
    });
    const cancelBtn = el('button', { class: 'btn run-cancel', type: 'button' }, '终止运行');
    cancelBtn.addEventListener('click', async () => {
      cancelBtn.disabled = true;
      cancelBtn.textContent = '正在终止…';
      try {
        await api.cancelRun();
      } catch { /* 终止失败也要让弹窗继续轮询到结束态 */ }
    });
    const closeBtn = el('button', { class: 'btn run-close', type: 'button' }, '关闭');
    actions.appendChild(pauseBtn);
    actions.appendChild(resumeBtn);
    actions.appendChild(cancelBtn);
    actions.appendChild(closeBtn);
    titleBar.appendChild(actions);

    const kindEl = el('span', {});
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

    const body = el('div', { class: 'run-body' });
    body.appendChild(row('任务', kindEl));
    body.appendChild(row('后端', backendEl));
    body.appendChild(row('模型', modelEl));
    body.appendChild(row('思考强度', effortEl));
    body.appendChild(row('已耗时', elapsedEl));
    const progressRowLine = row('进度', progressRow);
    body.appendChild(progressRowLine);
    body.appendChild(row('命令 / 请求', cmdEl));
    body.appendChild(promptTitle);
    body.appendChild(promptEl);

    panel.appendChild(titleBar);
    panel.appendChild(body);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) close();
    });
    closeBtn.addEventListener('click', close);
    document.body.appendChild(overlay);

    const tick = async () => {
      let run = null;
      try {
        run = await api.getCurrentRun();
      } catch {
        run = null;
      }
      if (!run) {
        kindEl.textContent = '当前没有正在进行的调用';
        backendEl.textContent = '-';
        modelEl.textContent = '-';
        effortEl.textContent = '-';
        cmdEl.textContent = '';
        promptTitle.textContent = '';
        promptEl.textContent = '';
        progressRowLine.style.display = 'none';
        pauseBtn.style.display = 'none';
        resumeBtn.style.display = 'none';
        cancelBtn.style.display = 'none';
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        return;
      }
      const batchTotal = Number(run.batchTotal) || 0;
      const batchIndex = Number(run.batchIndex) || 0;
      const batchLabel = batchTotal > 1 ? `（第 ${batchIndex}/${batchTotal} 批）` : '';
      if (run.paused) {
        kindEl.textContent = `已暂停${batchLabel}`;
        backendEl.textContent = BACKEND_LABELS[run.backend] || run.backend || '-';
        modelEl.textContent = run.model || '-';
        effortEl.textContent = run.effort ? run.effort : '-';
        elapsedEl.textContent = run.startedAt
          ? `${((Date.now() - run.startedAt) / 1000).toFixed(1)}s` : '-';
        cmdEl.textContent = run.command || '';
        promptTitle.textContent = '';
        promptEl.textContent = '';
        progressRowLine.style.display = 'none';
        pausing = false;
        pauseBtn.style.display = 'none';
        cancelBtn.style.display = 'none';
        resumeBtn.style.display = typeof api.resumeRun === 'function' ? '' : 'none';
        if (!resumeBtn.disabled) resumeBtn.textContent = '继续';
        return;
      }
      resumeBtn.style.display = 'none';
      resumeBtn.disabled = false;
      resumeBtn.textContent = '继续';
      cancelBtn.style.display = '';
      if (!cancelBtn.disabled) cancelBtn.textContent = '终止运行';
      pauseBtn.style.display = typeof api.pauseRun === 'function' ? '' : 'none';
      if (!pausing) {
        pauseBtn.disabled = false;
        pauseBtn.textContent = '暂停';
      }
      if (batchTotal > 1) {
        progressRowLine.style.display = '';
        progressText.textContent = `第 ${batchIndex}/${batchTotal} 批`;
        const percent = Math.max(0, Math.min(100, (batchIndex / batchTotal) * 100));
        progressBar.style.width = `${percent}%`;
      } else {
        progressRowLine.style.display = 'none';
      }
      kindEl.textContent = run.batch ? `${run.kind} ${run.batch}` : run.kind;
      backendEl.textContent = BACKEND_LABELS[run.backend] || run.backend;
      modelEl.textContent = run.model || '-';
      effortEl.textContent = run.effort ? run.effort : '默认';
      elapsedEl.textContent = `${((Date.now() - run.startedAt) / 1000).toFixed(1)}s`;
      cmdEl.textContent = run.command || '';
      promptTitle.textContent = `Prompt（${(run.promptChars || 0).toLocaleString()} 字符）`;
      if (run.promptText && !promptEl.textContent) promptEl.textContent = run.promptText;
    };
    timer = setInterval(tick, 500);
    tick();
  };
}

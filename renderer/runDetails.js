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
    const cancelBtn = el('button', { class: 'btn run-cancel', type: 'button' }, '终止运行');
    cancelBtn.addEventListener('click', async () => {
      cancelBtn.disabled = true;
      cancelBtn.textContent = '正在终止…';
      try {
        await api.cancelRun();
      } catch { /* 终止失败也要让弹窗继续轮询到结束态 */ }
    });
    const closeBtn = el('button', { class: 'btn run-close', type: 'button' }, '关闭');
    titleBar.appendChild(cancelBtn);
    titleBar.appendChild(closeBtn);

    const kindEl = el('span', {});
    const backendEl = el('span', {});
    const modelEl = el('span', {});
    const effortEl = el('span', {});
    const elapsedEl = el('span', { class: 'run-elapsed' });
    const cmdEl = el('div', { class: 'run-cmd' });
    const promptTitle = el('div', { class: 'run-prompt-title' }, '');
    const promptEl = el('pre', { class: 'run-prompt' });

    const body = el('div', { class: 'run-body' });
    body.appendChild(row('任务', kindEl));
    body.appendChild(row('后端', backendEl));
    body.appendChild(row('模型', modelEl));
    body.appendChild(row('思考强度', effortEl));
    body.appendChild(row('已耗时', elapsedEl));
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
        cancelBtn.style.display = 'none';
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        return;
      }
      cancelBtn.style.display = '';
      if (!cancelBtn.disabled) cancelBtn.textContent = '终止运行';
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

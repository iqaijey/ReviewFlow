// 完整讲解：把当前改动按文件逐块讲透（流式预览 + 运行详情 + 终止）
import { renderMarkdown } from '../markdown.js';

const BACKEND_LABELS = { api: 'API', opencode: 'OpenCode', kimi: 'Kimi CLI', codex: 'Codex' };

function formatStats(stats) {
  const parts = [];
  if (stats && stats.backend) parts.push(BACKEND_LABELS[stats.backend] || stats.backend);
  if (stats && stats.model) parts.push(stats.model);
  if (stats && stats.backend) parts.push(stats.effort ? `思考 ${stats.effort}` : '默认强度');
  if (stats && stats.promptTokens != null && stats.completionTokens != null) {
    parts.push(`${(stats.promptTokens + stats.completionTokens).toLocaleString()} tokens`);
  }
  if (stats && stats.durationMs != null) {
    parts.push(`${(stats.durationMs / 1000).toFixed(1)}s`);
  }
  return parts.join(' · ');
}

export default {
  id: 'fullExplain',
  title: '完整讲解',

  mount(container, ctx) {
    const { el, bus, state, api, errText, notify } = ctx;

    const toolbar = el('div', { class: 'review-toolbar' });
    const hint = el('span', { class: 'stat-item' },
      '把当前全部改动按文件逐块讲透，内容较长、耗时较久');
    const startBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '开始完整讲解');
    toolbar.appendChild(hint);
    toolbar.appendChild(startBtn);
    container.appendChild(toolbar);

    const statusBox = el('div', { class: 'review-status' });
    const mdBox = el('div', { class: 'md review-result' });
    container.appendChild(statusBox);
    container.appendChild(mdBox);

    const setStatus = (node) => {
      statusBox.textContent = '';
      if (node) statusBox.appendChild(node);
    };

    const loadingNode = () => {
      const loading = el('div', { class: 'review-loading' });
      loading.appendChild(el('span', { class: 'spinner' }));
      loading.appendChild(el('span', {}, 'AI 讲解中，请稍候…'));
      loading.appendChild(el('button', {
        class: 'run-link', type: 'button',
        onClick: () => ctx.showRunDetails(),
      }, '运行详情'));
      return loading;
    };

    let running = false;

    const refresh = () => {
      if (!state.changes || !state.changes.files.length) {
        startBtn.disabled = true;
        if (!mdBox.firstChild) {
          setStatus(el('div', { class: 'empty-hint' },
            '请先在「改动总览」中选择项目文件夹并确保存在改动'));
        }
        return;
      }
      startBtn.disabled = running;
    };

    const run = async () => {
      if (running || !state.changes || !state.changes.files.length) return;
      running = true;
      startBtn.disabled = true;
      mdBox.textContent = '';
      setStatus(loadingNode());
      const runId = `run-${Date.now()}`;
      const streamBox = el('div', { class: 'stream-preview', style: 'white-space: pre-wrap' });
      const unsubscribe = typeof api.onAiChunk === 'function'
        ? api.onAiChunk(({ runId: chunkRunId, text }) => {
            if (chunkRunId !== runId) return;
            if (!streamBox.parentNode) mdBox.appendChild(streamBox);
            streamBox.textContent = text;
          })
        : null;
      try {
        const { markdown, stats } = await api.explainFull({
          folder: state.folder,
          files: state.changes.files,
          runId,
        });
        setStatus(null);
        mdBox.innerHTML = renderMarkdown(markdown);
        mdBox.appendChild(el('div', { class: 'ai-stats' }, formatStats(stats)));
        notify('完整讲解完成', '当前改动已讲解完毕');
      } catch (err) {
        if (errText(err).includes('已被用户终止')) {
          setStatus(el('div', { class: 'empty-hint' }, '已终止，可点击「开始完整讲解」重新开始'));
        } else {
          setStatus(el('div', { class: 'error-text' }, `讲解失败：${errText(err)}`));
          notify('完整讲解失败', errText(err));
        }
      } finally {
        if (unsubscribe) unsubscribe();
        streamBox.remove();
        running = false;
        startBtn.disabled = false;
      }
    };

    startBtn.addEventListener('click', run);

    bus.addEventListener('changes:loaded', () => {
      refresh();
      // 保留已有讲解结果，只提示可能过期
      if (mdBox.firstChild) {
        setStatus(el('div', { class: 'empty-hint' },
          '改动已更新，以下讲解可能已过期，可点击「开始完整讲解」重新生成'));
      }
    });

    refresh();
  },
};

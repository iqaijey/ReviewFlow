// 逐句解析：展示选中行上下文，调用 AI 解释，保留历史记录
import { renderMarkdown } from '../markdown.js';

// {backend, model, effort, promptTokens, completionTokens, durationMs}
// → "API · k3-256k · 思考 high · 1,234 tokens · 12.3s"
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
  id: 'explain',
  title: '逐句解析',

  mount(container, ctx) {
    const { el, bus, state, api, errText, notify } = ctx;

    const contextBox = el('div', { class: 'explain-context' });
    const statusBox = el('div', { class: 'explain-status' });
    const resultBox = el('div', { class: 'md explain-result' });
    const historyTitle = el('div', { class: 'explain-history-title' }, '历史解释');
    const historyList = el('div', { class: 'explain-history' });
    container.appendChild(contextBox);
    container.appendChild(statusBox);
    container.appendChild(resultBox);
    container.appendChild(historyTitle);
    container.appendChild(historyList);

    const setStatus = (node) => {
      statusBox.textContent = '';
      if (node) statusBox.appendChild(node);
    };

    const showIdle = () => {
      contextBox.textContent = '';
      resultBox.textContent = '';
      historyTitle.style.display = 'none';
      setStatus(el('div', { class: 'empty-hint' },
        '请在「改动总览」中点击一行改动（拖动或 ⌥+点击可框选多行）'));
    };

    // 统一成行号标注
    const lineNo = (l) => (l.newLine != null ? l.newLine : l.oldLine);

    // detail 归一化为 segments：单行 → 单段单行；框选 → 多段多行
    const toSegments = (detail) => {
      if (Array.isArray(detail.segments) && detail.segments.length) return detail.segments;
      const hunk = detail.file.hunks[detail.hunkIndex];
      if (!hunk) return null;
      return [{ hunkIndex: detail.hunkIndex, hunk, lines: [detail.line] }];
    };

    const renderContext = (file, segments) => {
      contextBox.textContent = '';
      const card = el('div', { class: 'explain-card' });
      card.appendChild(el('div', { class: 'explain-card-file' }, file.path));
      for (const seg of segments) {
        card.appendChild(el('div', { class: 'explain-card-hunk' }, seg.hunk.header));
        const selectedSet = new Set(seg.lines);
        const lines = el('div', { class: 'explain-card-lines' });
        for (const l of seg.hunk.lines) {
          const selected = selectedSet.has(l);
          const row = el('div', {
            class: `explain-line line-${l.type}${selected ? ' line-selected' : ''}`,
          });
          const prefix = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
          row.appendChild(el('span', { class: 'explain-line-prefix' },
            selected ? '>' : prefix));
          row.appendChild(el('span', { class: 'line-content' }, l.content));
          lines.appendChild(row);
        }
        card.appendChild(lines);
      }
      contextBox.appendChild(card);
    };

    const rangeLabel = (file, segments) => {
      const first = lineNo(segments[0].lines[0]);
      const lastSeg = segments[segments.length - 1];
      const last = lineNo(lastSeg.lines[lastSeg.lines.length - 1]);
      const total = segments.reduce((n, s) => n + s.lines.length, 0);
      if (total === 1) return `${file.path}:${first == null ? '-' : first}`;
      return `${file.path}:${first == null ? '?' : first}-${last == null ? '?' : last}（${total} 行）`;
    };

    const addHistory = (label, md) => {
      historyTitle.style.display = '';
      const item = el('div', { class: 'explain-history-item' });
      const head = el('button', { class: 'explain-history-head', type: 'button' }, label);
      const body = el('div', { class: 'md explain-history-body' });
      body.innerHTML = renderMarkdown(md);
      body.style.display = 'none';
      head.addEventListener('click', () => {
        body.style.display = body.style.display === 'none' ? '' : 'none';
      });
      item.appendChild(head);
      item.appendChild(body);
      historyList.insertBefore(item, historyList.firstChild);
    };

    let requestSeq = 0;

    const handleSelect = (detail) => {
      const { file } = detail;
      const segments = toSegments(detail);
      if (!segments) return;
      const seq = ++requestSeq;
      const label = rangeLabel(file, segments);

      renderContext(file, segments);
      resultBox.textContent = '';
      const loading = el('div', { class: 'explain-loading' });
      loading.appendChild(el('span', { class: 'spinner' }));
      loading.appendChild(el('span', {}, 'AI 解析中，请稍候…'));
      loading.appendChild(el('button', {
        class: 'run-link', type: 'button',
        onClick: () => ctx.showRunDetails(),
      }, '运行详情'));
      setStatus(loading);

      const payload = { folder: state.folder, filePath: file.path };
      if (detail.segments) {
        payload.segments = segments.map((s) => ({ hunk: s.hunk, lines: s.lines }));
      } else {
        payload.hunk = segments[0].hunk;
        payload.line = segments[0].lines[0];
      }

      api.explainChange(payload).then(({ markdown, stats }) => {
        if (seq !== requestSeq) return; // 已有更新的选择，丢弃过期结果
        setStatus(null);
        resultBox.innerHTML = renderMarkdown(markdown);
        resultBox.appendChild(el('div', { class: 'ai-stats' }, formatStats(stats)));
        addHistory(label, markdown);
        notify('逐句解析完成', label);
      }).catch((err) => {
        if (seq !== requestSeq) return;
        setStatus(el('div', { class: 'error-text' },
          `解析失败：${errText(err)}`));
        notify('逐句解析失败', errText(err));
      });
    };

    bus.addEventListener('line:select', (e) => handleSelect(e.detail));

    showIdle();
    // tab 首次挂载前选中的行，挂载时补上一次解析
    if (state.selectedLine && (state.selectedLine.line || state.selectedLine.segments)) {
      handleSelect(state.selectedLine);
    }
  },
};

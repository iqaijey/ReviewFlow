// 多角度 Review：整体分析 / 逐文件 / 历史 三种模式
import { renderMarkdown } from '../markdown.js';

const DIMENSIONS = [
  '改动概述', '安全性', '结构问题', '影响面',
  '逻辑严谨性', '臃肿与冗余', '可扩展性', '可复用性',
];

const pad = (n) => String(n).padStart(2, '0');

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
  id: 'review',
  title: '多角度 Review',

  mount(container, ctx) {
    const { el, bus, state, api, errText, notify, toast } = ctx;

    // ---------- 分段切换 ----------
    const seg = el('div', { class: 'seg-control' });
    const overallPanel = el('div', { class: 'seg-panel' });
    const filesPanel = el('div', { class: 'seg-panel', style: 'display:none' });
    const historyPanel = el('div', { class: 'seg-panel', style: 'display:none' });
    const panels = { overall: overallPanel, files: filesPanel, history: historyPanel };
    const segBtns = {};
    const switchMode = (mode) => {
      for (const [id, btn] of Object.entries(segBtns)) {
        btn.classList.toggle('active', id === mode);
      }
      for (const [id, panel] of Object.entries(panels)) {
        panel.style.display = id === mode ? '' : 'none';
      }
      if (mode === 'history') loadHistory();
    };
    for (const [id, label] of [['overall', '整体分析'], ['files', '逐文件'], ['history', '历史']]) {
      const btn = el('button', { class: 'seg-btn', type: 'button' }, label);
      btn.addEventListener('click', () => switchMode(id));
      segBtns[id] = btn;
      seg.appendChild(btn);
    }
    segBtns.overall.classList.add('active');
    container.appendChild(seg);
    container.appendChild(overallPanel);
    container.appendChild(filesPanel);
    container.appendChild(historyPanel);

    // ---------- 通用小部件 ----------
    const statsLine = (stats) =>
      el('div', { class: 'ai-stats' }, formatStats(stats));

    const defaultExportName = () => {
      const d = new Date();
      return `review-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
        `-${pad(d.getHours())}${pad(d.getMinutes())}.md`;
    };

    const exportBtn = (markdown) => {
      const btn = el('button', { class: 'btn', type: 'button' }, '导出 Markdown');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const saved = await api.exportReview({ defaultName: defaultExportName(), markdown });
          if (saved && toast) toast(`已保存到 ${saved}`);
        } catch (err) {
          alert('导出失败：' + errText(err));
        } finally {
          btn.disabled = false;
        }
      });
      return btn;
    };

    const countChanges = (files) => {
      let add = 0, del = 0;
      for (const f of files)
        for (const h of f.hunks)
          for (const l of h.lines) {
            if (l.type === 'add') add++;
            else if (l.type === 'del') del++;
          }
      return { add, del };
    };

    const autoTitle = () => {
      const d = new Date();
      const files = state.changes ? state.changes.files : [];
      const { add, del } = countChanges(files);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())} · ${files.length} 文件 +${add} -${del}`;
    };

    const loadingNode = () => {
      const loading = el('div', { class: 'review-loading' });
      loading.appendChild(el('span', { class: 'spinner' }));
      loading.appendChild(el('span', {}, 'AI 分析中，请稍候…'));
      loading.appendChild(el('button', {
        class: 'run-link', type: 'button',
        onClick: () => ctx.showRunDetails(),
      }, '运行详情'));
      return loading;
    };

    // ---------- 整体分析 ----------
    const toolbar = el('div', { class: 'review-toolbar' });
    const chips = el('div', { class: 'review-chips' });
    for (const dim of DIMENSIONS) {
      const chip = el('button', { class: 'review-chip', type: 'button' }, dim);
      chip.addEventListener('click', () => {
        const target = findSection(dim);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      chips.appendChild(chip);
    }
    const startBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '开始 AI 分析');
    toolbar.appendChild(chips);
    toolbar.appendChild(startBtn);
    overallPanel.appendChild(toolbar);

    const statusBox = el('div', { class: 'review-status' });
    const mdBox = el('div', { class: 'md review-result' });
    overallPanel.appendChild(statusBox);
    overallPanel.appendChild(mdBox);

    // 在已渲染的 markdown 中按标题文字定位小节
    const findSection = (dim) => {
      for (const h of mdBox.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
        if (h.textContent.includes(dim)) return h;
      }
      return null;
    };

    let running = false;

    const setStatus = (node) => {
      statusBox.textContent = '';
      if (node) statusBox.appendChild(node);
    };

    const refresh = () => {
      if (!state.changes || !state.changes.files.length) {
        startBtn.disabled = true;
        startBtn.textContent = '开始 AI 分析';
        setStatus(el('div', { class: 'empty-hint' },
          '请先在「改动总览」中选择项目文件夹并确保存在未提交的改动'));
        return;
      }
      startBtn.disabled = running;
    };

    const showError = (message) => {
      const box = el('div', { class: 'review-error' });
      box.appendChild(el('div', { class: 'error-text' }, `分析失败：${message}`));
      const retry = el('button', { class: 'btn', type: 'button' }, '重试');
      retry.addEventListener('click', runAnalysis);
      box.appendChild(retry);
      setStatus(box);
    };

    const runAnalysis = async () => {
      if (running || !state.changes || !state.changes.files.length) return;
      running = true;
      startBtn.disabled = true;
      mdBox.textContent = '';
      setStatus(loadingNode());
      // API 后端流式输出：增量文本先以纯文本预览，结束后替换为渲染好的 markdown
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
        const { markdown, stats } = await api.analyzeOverview({
          folder: state.folder,
          files: state.changes.files,
          runId,
        });
        setStatus(null);
        mdBox.innerHTML = renderMarkdown(markdown);
        mdBox.appendChild(statsLine(stats));
        mdBox.appendChild(exportBtn(markdown));
        notify('AI 分析完成', '多角度 Review 已生成');
        // 历史保存失败不影响结果展示
        try {
          await api.saveReview({
            folder: state.folder, title: autoTitle(), stats, markdown,
          });
        } catch { /* 忽略 */ }
      } catch (err) {
        if (errText(err).includes('已被用户终止')) {
          setStatus(el('div', { class: 'empty-hint' }, '已终止，可点击「开始 AI 分析」重新开始'));
        } else {
          showError(errText(err));
          notify('AI 分析失败', errText(err));
        }
      } finally {
        if (unsubscribe) unsubscribe();
        streamBox.remove();
        running = false;
        startBtn.disabled = false;
      }
    };

    startBtn.addEventListener('click', runAnalysis);

    // ---------- 逐文件 ----------
    const renderFilesPanel = () => {
      filesPanel.textContent = '';
      if (!state.changes || !state.changes.files.length) {
        filesPanel.appendChild(el('div', { class: 'empty-hint' },
          '请先在「改动总览」中加载项目改动'));
        return;
      }
      for (const file of state.changes.files) {
        const { add, del } = countChanges([file]);
        const card = el('div', { class: 'review-file-item' });
        const head = el('div', { class: 'review-file-head' });
        head.appendChild(el('span', { class: 'review-file-path' }, file.path));
        head.appendChild(el('span', { class: 'stat-add' }, `+${add}`));
        head.appendChild(el('span', { class: 'stat-del' }, `-${del}`));
        const analyzeBtn = el('button', { class: 'btn', type: 'button' }, '分析');
        head.appendChild(analyzeBtn);
        card.appendChild(head);
        const resultBox = el('div', { class: 'review-file-result' });
        card.appendChild(resultBox);
        filesPanel.appendChild(card);

        let fileRunning = false;
        analyzeBtn.addEventListener('click', async () => {
          if (fileRunning) return;
          fileRunning = true;
          analyzeBtn.disabled = true;
          resultBox.textContent = '';
          resultBox.appendChild(loadingNode());
          const runId = `run-${Date.now()}`;
          const streamBox = el('div', { class: 'stream-preview', style: 'white-space: pre-wrap' });
          const unsubscribe = typeof api.onAiChunk === 'function'
            ? api.onAiChunk(({ runId: chunkRunId, text }) => {
                if (chunkRunId !== runId) return;
                if (!streamBox.parentNode) resultBox.appendChild(streamBox);
                streamBox.textContent = text;
              })
            : null;
          try {
            const { markdown, stats } = await api.analyzeFile({
              folder: state.folder, file, runId,
            });
            resultBox.textContent = '';
            const mdNode = el('div', { class: 'md' });
            mdNode.innerHTML = renderMarkdown(markdown);
            resultBox.appendChild(mdNode);
            resultBox.appendChild(statsLine(stats));
          } catch (err) {
            resultBox.textContent = '';
            const box = el('div', { class: 'review-error' });
            box.appendChild(el('div', { class: 'error-text' }, `分析失败：${errText(err)}`));
            const retry = el('button', { class: 'btn', type: 'button' }, '重试');
            retry.addEventListener('click', () => analyzeBtn.click());
            box.appendChild(retry);
            resultBox.appendChild(box);
          } finally {
            if (unsubscribe) unsubscribe();
            streamBox.remove();
            fileRunning = false;
            analyzeBtn.disabled = false;
          }
        });
      }
    };

    // ---------- 历史 ----------
    const loadHistory = async () => {
      historyPanel.textContent = '';
      if (!state.folder) {
        historyPanel.appendChild(el('div', { class: 'empty-hint' }, '请先选择项目文件夹'));
        return;
      }
      let reviews = [];
      try {
        reviews = await api.listReviews(state.folder);
      } catch (err) {
        historyPanel.appendChild(el('div', { class: 'error-text' },
          `加载历史失败：${errText(err)}`));
        return;
      }
      if (!reviews || !reviews.length) {
        historyPanel.appendChild(el('div', { class: 'empty-hint' },
          '暂无历史评审记录，完成一次整体分析后会自动保存'));
        return;
      }
      const list = el('div', { class: 'review-history' });
      for (const entry of reviews) {
        const item = el('div', { class: 'review-history-item' });
        const head = el('button', { class: 'review-history-head', type: 'button' });
        head.appendChild(el('span', { class: 'review-history-time' },
          new Date(entry.createdAt).toLocaleString()));
        head.appendChild(el('span', { class: 'review-history-title' }, entry.title));
        if (entry.stats) {
          head.appendChild(el('span', { class: 'ai-stats' }, formatStats(entry.stats)));
        }
        const body = el('div', { class: 'review-history-body', style: 'display:none' });
        head.addEventListener('click', () => {
          const opening = body.style.display === 'none';
          body.style.display = opening ? '' : 'none';
          if (opening && !body.firstChild) {
            const mdNode = el('div', { class: 'md' });
            mdNode.innerHTML = renderMarkdown(entry.markdown);
            body.appendChild(mdNode);
            body.appendChild(exportBtn(entry.markdown));
          }
        });
        item.appendChild(head);
        item.appendChild(body);
        list.appendChild(item);
      }
      historyPanel.appendChild(list);
    };

    bus.addEventListener('changes:loaded', () => {
      refresh();
      renderFilesPanel();
      // 保留已有分析结果，只提示可能过期，不打断阅读/进行中的分析
      if (mdBox.firstChild) {
        setStatus(el('div', { class: 'empty-hint' },
          '改动已更新，以下分析结果可能已过期，可点击「开始 AI 分析」重新生成'));
      }
    });

    refresh();
    renderFilesPanel();
  },
};

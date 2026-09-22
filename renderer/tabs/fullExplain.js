// 完整讲解：把当前改动按文件逐块讲透（流式预览 + 运行详情 + 终止）
import { renderMarkdown, renderMarkdownPage } from '../markdown.js';

const BACKEND_LABELS = { api: 'API', opencode: 'OpenCode', kimi: 'Kimi CLI', codex: 'Codex' };

const pad = (n) => String(n).padStart(2, '0');

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

// 注入 prompt 的方案长度上限，避免方案过长撑爆 prompt
const PLAN_CONTEXT_MAX_CHARS = 6000;
const PLAN_PRD_EXCERPT_CHARS = 500;

// 拉取当前项目启用的需求方案并构造注入文本；未开启、无方案或接口缺失时返回 null
async function loadPlanContext(api, folder) {
  if (!folder || localStorage.getItem('planReviewEnabled') === '0') return null;
  if (typeof api.getActivePlan !== 'function') return null;
  let plan = null;
  try {
    plan = await api.getActivePlan(folder);
  } catch {
    return null;
  }
  if (!plan || !plan.planMarkdown) return null;
  let markdown = String(plan.planMarkdown);
  if (markdown.length > PLAN_CONTEXT_MAX_CHARS) {
    markdown = `${markdown.slice(0, PLAN_CONTEXT_MAX_CHARS)}\n\n（方案内容过长，已截断至 ${PLAN_CONTEXT_MAX_CHARS} 字）`;
  }
  const prdText = String(plan.prdText || '');
  const prdExcerpt = prdText.length > PLAN_PRD_EXCERPT_CHARS
    ? `${prdText.slice(0, PLAN_PRD_EXCERPT_CHARS)}…（PRD 过长已截断）`
    : prdText;
  const title = plan.title || '未命名方案';
  let section = `## 需求方案（评审依据）\n\n方案标题：${title}\n\n${markdown}`;
  if (prdExcerpt) section += `\n\n### PRD 摘要\n\n${prdExcerpt}`;
  return { title, section };
}

export default {
  id: 'fullExplain',
  title: '完整讲解',

  mount(container, ctx) {
    const { el, bus, state, api, errText, notify, toast } = ctx;

    const toolbar = el('div', { class: 'review-toolbar' });
    const hint = el('span', { class: 'stat-item' },
      '把当前全部改动按文件逐块讲透，内容较长、耗时较久');
    const startBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '开始完整讲解');
    const historyBtn = el('button', { class: 'btn', type: 'button' }, '历史');
    const runLink = el('button', {
      class: 'run-link', type: 'button', title: '查看当前运行 / 暂停与继续',
      onClick: () => ctx.showRunDetails(),
    }, '运行详情');
    toolbar.appendChild(hint);
    toolbar.appendChild(startBtn);
    toolbar.appendChild(historyBtn);
    toolbar.appendChild(runLink);
    container.appendChild(toolbar);

    const historyPanel = el('div', { style: 'display:none' });
    container.appendChild(historyPanel);

    const statusBox = el('div', { class: 'review-status' });
    const mdBox = el('div', { class: 'md review-result' });
    container.appendChild(statusBox);
    container.appendChild(mdBox);

    // 与多角度 Review 相同的时间 + 文件数格式
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

    const defaultExportName = () => {
      const d = new Date();
      return `fullexplain-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
        `-${pad(d.getHours())}${pad(d.getMinutes())}.html`;
    };

    const copyBtn = (markdown) => {
      const btn = el('button', { class: 'btn', type: 'button' }, '复制');
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(markdown)
          .then(() => { if (toast) toast('已复制到剪贴板'); })
          .catch(() => { /* 剪贴板不可用时静默 */ });
      });
      return btn;
    };

    const exportHtmlBtn = (markdown) => {
      const btn = el('button', { class: 'btn', type: 'button' }, '导出 HTML');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const saved = await api.exportReview({
            defaultName: defaultExportName(),
            content: renderMarkdownPage(`完整讲解 · ${autoTitle()}`, markdown),
            ext: 'html',
          });
          if (saved && toast) toast(`已保存到 ${saved}`);
        } catch (err) {
          alert('导出失败：' + errText(err));
        } finally {
          btn.disabled = false;
        }
      });
      return btn;
    };

    // 每次讲解运行递增，用于丢弃过期追问结果
    let runSeq = 0;

    // 追问区：基于本次讲解结果继续提问，最多保留最近 10 轮（首条固定为初始结果）
    const buildFollowUp = (markdown) => {
      if (typeof api.reviewFollowUp !== 'function') return null;
      const seqAtBuild = runSeq;
      let previousQA = [{ question: '（初始结果）', answer: markdown }];
      const box = el('div', { class: 'explain-follow' });
      const list = el('div', { class: 'explain-follow-list' });
      const form = el('div', { class: 'explain-follow-form' });
      const input = el('input', {
        class: 'settings-input', type: 'text',
        placeholder: '就这次讲解继续提问…', spellcheck: 'false',
      });
      const askBtn = el('button', { class: 'btn', type: 'button' }, '提问');
      form.appendChild(input);
      form.appendChild(askBtn);
      box.appendChild(list);
      box.appendChild(form);

      let asking = false;
      const submit = async () => {
        const question = input.value.trim();
        if (!question || asking || !state.changes) return;
        asking = true;
        input.disabled = true;
        askBtn.disabled = true;
        const item = el('div', { class: 'explain-follow-item' });
        item.appendChild(el('div', { class: 'explain-follow-q' }, `> ${question}`));
        const loading = el('div', { class: 'explain-loading' });
        loading.appendChild(el('span', { class: 'spinner' }));
        loading.appendChild(el('span', {}, 'AI 思考中，请稍候…'));
        item.appendChild(loading);
        list.appendChild(item);
        const runId = `run-${Date.now()}`;
        try {
          const { markdown: answer, stats } = await api.reviewFollowUp({
            folder: state.folder,
            files: state.changes.files,
            previousQA: [...previousQA],
            question,
            runId,
          });
          if (seqAtBuild !== runSeq) return; // 已重新讲解，丢弃过期回答
          loading.remove();
          const mdNode = el('div', { class: 'md' });
          mdNode.innerHTML = renderMarkdown(answer);
          item.appendChild(mdNode);
          item.appendChild(el('div', { class: 'ai-stats' }, formatStats(stats)));
          previousQA.push({ question, answer });
          if (previousQA.length > 10) {
            previousQA = [previousQA[0], ...previousQA.slice(-9)];
          }
          input.value = '';
        } catch (err) {
          if (seqAtBuild !== runSeq) return;
          loading.remove();
          if (errText(err).includes('已被用户终止')) {
            item.appendChild(el('div', { class: 'empty-hint' }, '已终止'));
          } else {
            item.appendChild(el('div', { class: 'error-text' },
              `追问失败：${errText(err)}`));
          }
        } finally {
          asking = false;
          input.disabled = false;
          askBtn.disabled = false;
        }
      };
      askBtn.addEventListener('click', submit);
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') submit();
      });
      return box;
    };

    // ---------- 历史（kind === 'full'） ----------
    let historyLoaded = false;
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
      reviews = (reviews || []).filter((entry) => entry.kind === 'full');
      if (!reviews.length) {
        historyPanel.appendChild(el('div', { class: 'empty-hint' },
          '暂无历史讲解记录，完成一次完整讲解后会自动保存'));
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
          }
        });
        item.appendChild(head);
        item.appendChild(body);
        list.appendChild(item);
      }
      historyPanel.appendChild(list);
    };

    historyBtn.addEventListener('click', () => {
      const opening = historyPanel.style.display === 'none';
      historyPanel.style.display = opening ? '' : 'none';
      if (opening && !historyLoaded) {
        historyLoaded = true;
        loadHistory();
      }
    });

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
      runSeq++;
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
        const payload = {
          folder: state.folder,
          files: state.changes.files,
          runId,
        };
        const plan = await loadPlanContext(api, state.folder);
        if (plan) payload.planContext = plan.section;
        const { markdown, stats } = await api.explainFull(payload);
        setStatus(null);
        mdBox.innerHTML = renderMarkdown(markdown);
        mdBox.appendChild(el('div', { class: 'ai-stats' }, formatStats(stats)));
        const btnGroup = el('div', { class: 'export-group' });
        btnGroup.appendChild(copyBtn(markdown));
        btnGroup.appendChild(exportHtmlBtn(markdown));
        mdBox.appendChild(btnGroup);
        const followUp = buildFollowUp(markdown);
        if (followUp) mdBox.appendChild(followUp);
        notify('完整讲解完成', '当前改动已讲解完毕');
        // 历史保存失败不影响结果展示
        try {
          await api.saveReview({
            folder: state.folder,
            title: `完整讲解 · ${autoTitle()}`,
            kind: 'full',
            stats,
            markdown,
          });
          historyLoaded = false; // 下次打开历史时重新加载
        } catch { /* 忽略 */ }
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
      // 文件夹可能已切换，历史列表下次打开时重新加载
      historyLoaded = false;
      if (historyPanel.style.display !== 'none') {
        historyLoaded = true;
        loadHistory();
      }
    });

    refresh();
  },
};

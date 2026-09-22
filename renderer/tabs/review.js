// 多角度 Review：整体分析 / 逐文件 / 历史 三种模式
import { renderMarkdown, renderMarkdownPage } from '../markdown.js';

const DIMENSIONS = [
  '改动概述', '安全性', '结构问题', '影响面',
  '逻辑严谨性', '臃肿与冗余', '可扩展性', '可复用性',
];

// 注入 prompt 的方案长度上限，避免方案过长撑爆 prompt
const PLAN_CONTEXT_MAX_CHARS = 6000;
const PLAN_PRD_EXCERPT_CHARS = 500;

const planReviewEnabled = () => localStorage.getItem('planReviewEnabled') !== '0';

// 拉取当前项目启用的需求方案并构造注入文本；未开启、无方案或接口缺失时返回 null
async function loadPlanContext(api, folder) {
  if (!folder || !planReviewEnabled() || typeof api.getActivePlan !== 'function') return null;
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

    // 顶部方案参照提示条，内容由 refreshPlanHint 填充
    const planHint = el('div', {
      class: 'stat-item',
      style: 'display:none; font-size:12px; margin-bottom:6px;',
    });
    container.appendChild(planHint);

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

    const defaultExportName = (ext) => {
      const d = new Date();
      return `review-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
        `-${pad(d.getHours())}${pad(d.getMinutes())}.${ext || 'md'}`;
    };

    const exportBtn = (markdown) => {
      const btn = el('button', { class: 'btn', type: 'button' }, '导出 Markdown');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const saved = await api.exportReview({
            defaultName: defaultExportName('md'), content: markdown, ext: 'md',
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
            defaultName: defaultExportName('html'),
            content: renderMarkdownPage(autoTitle(), markdown),
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

    const exportGroup = (markdown) => {
      const group = el('div', { class: 'export-group' });
      group.appendChild(exportBtn(markdown));
      group.appendChild(copyBtn(markdown));
      group.appendChild(exportHtmlBtn(markdown));
      return group;
    };

    // 整体分析每次运行递增，用于丢弃过期追问结果
    let runSeq = 0;

    // 追问区：基于本次整体分析结果继续提问，最多保留最近 10 轮（首条固定为初始结果）
    const buildFollowUp = (markdown) => {
      if (typeof api.reviewFollowUp !== 'function') return null;
      const seqAtBuild = runSeq;
      let previousQA = [{ question: '（初始结果）', answer: markdown }];
      const box = el('div', { class: 'explain-follow' });
      const list = el('div', { class: 'explain-follow-list' });
      const form = el('div', { class: 'explain-follow-form' });
      const input = el('input', {
        class: 'settings-input', type: 'text',
        placeholder: '就这次评审继续提问…', spellcheck: 'false',
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
          if (seqAtBuild !== runSeq) return; // 已重新分析，丢弃过期回答
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
    // 固定 8 维度 + 设置里的自定义维度（每行一个）+ 参照方案时追加「需求符合度」
    const parseCustomDimensions = (raw) =>
      String(raw || '').split('\n').map((t) => t.trim()).filter(Boolean);
    let cachedCustomDims = [];
    let activePlanTitle = '';
    const rebuildChips = () => {
      chips.textContent = '';
      const dims = activePlanTitle
        ? DIMENSIONS.concat(cachedCustomDims, ['需求符合度'])
        : DIMENSIONS.concat(cachedCustomDims);
      for (const dim of dims) {
        const chip = el('button', { class: 'review-chip', type: 'button' }, dim);
        chip.addEventListener('click', () => {
          const target = findSection(dim);
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        chips.appendChild(chip);
      }
    };
    let cachedCustomPrompt = '';
    const loadDimensions = () => {
      api.getSettings()
        .then((s) => {
          cachedCustomPrompt = (s && s.customPrompt) || '';
          cachedCustomDims = parseCustomDimensions(s && s.customDimensions);
          rebuildChips();
        })
        .catch(() => {});
    };
    // 有启用方案时在 tab 顶部提示；× 临时关闭参照（写 localStorage，不删方案）
    const refreshPlanHint = async () => {
      const plan = await loadPlanContext(api, state.folder);
      activePlanTitle = plan ? plan.title : '';
      rebuildChips();
      planHint.textContent = '';
      if (!plan) {
        planHint.style.display = 'none';
        return;
      }
      planHint.style.display = '';
      planHint.appendChild(el('span', {}, `📋 参照方案：${plan.title}`));
      const closeBtn = el('button', {
        class: 'run-link', type: 'button',
        title: '临时关闭，评审时不再参照需求方案',
      }, '×');
      closeBtn.addEventListener('click', () => {
        localStorage.setItem('planReviewEnabled', '0');
        refreshPlanHint();
      });
      planHint.appendChild(closeBtn);
    };
    rebuildChips();
    loadDimensions();
    refreshPlanHint();
    bus.addEventListener('settings:saved', loadDimensions);
    const startBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '开始 AI 分析');
    const runLink = el('button', {
      class: 'run-link', type: 'button', title: '查看当前运行 / 暂停与继续',
      onClick: () => ctx.showRunDetails(),
    }, '运行详情');
    toolbar.appendChild(chips);
    toolbar.appendChild(startBtn);
    toolbar.appendChild(runLink);
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
      retry.addEventListener('click', () => runAnalysis());
      box.appendChild(retry);
      // 一次性自定义要求重跑：仅本次生效，不写回设置
      const rerunForm = el('div', { class: 'explain-follow-form review-rerun-form' });
      const promptInput = el('input', {
        class: 'settings-input', type: 'text',
        placeholder: '临时自定义要求，可留空', spellcheck: 'false',
      });
      promptInput.value = cachedCustomPrompt;
      const rerunBtn = el('button', { class: 'btn', type: 'button' }, '按此重跑');
      rerunBtn.addEventListener('click', () => runAnalysis(promptInput.value));
      promptInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') runAnalysis(promptInput.value);
      });
      rerunForm.appendChild(promptInput);
      rerunForm.appendChild(rerunBtn);
      box.appendChild(rerunForm);
      setStatus(box);
    };

    const runAnalysis = async (overridePrompt) => {
      if (running || !state.changes || !state.changes.files.length) return;
      // 按钮点击会把事件对象传进来，只接受字符串形式的临时要求
      const override = typeof overridePrompt === 'string' ? overridePrompt.trim() : '';
      running = true;
      runSeq++;
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
        const payload = {
          folder: state.folder,
          files: state.changes.files,
          runId,
        };
        if (override) payload.customPromptOverride = override;
        const plan = await loadPlanContext(api, state.folder);
        if (plan) payload.planContext = plan.section;
        const { markdown, stats } = await api.analyzeOverview(payload);
        setStatus(null);
        mdBox.innerHTML = renderMarkdown(markdown);
        mdBox.appendChild(statsLine(stats));
        mdBox.appendChild(exportGroup(markdown));
        const followUp = buildFollowUp(markdown);
        if (followUp) mdBox.appendChild(followUp);
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
    // file → 触发该文件逐文件分析（供「改动总览」的 AI 按钮跳转后调用）
    const fileAnalyzeTriggers = new Map();
    const renderFilesPanel = () => {
      filesPanel.textContent = '';
      fileAnalyzeTriggers.clear();
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
        fileAnalyzeTriggers.set(file, () => {
          card.scrollIntoView({ block: 'start' });
          analyzeBtn.click();
        });
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
            const filePayload = { folder: state.folder, file, runId };
            const plan = await loadPlanContext(api, state.folder);
            if (plan) filePayload.planContext = plan.section;
            const { markdown, stats } = await api.analyzeFile(filePayload);
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

    bus.addEventListener('plan:changed', refreshPlanHint);

    bus.addEventListener('changes:loaded', () => {
      refresh();
      renderFilesPanel();
      refreshPlanHint(); // 文件夹可能已切换，刷新参照方案提示
      // 保留已有分析结果，只提示可能过期，不打断阅读/进行中的分析
      if (mdBox.firstChild) {
        setStatus(el('div', { class: 'empty-hint' },
          '改动已更新，以下分析结果可能已过期，可点击「开始 AI 分析」重新生成'));
      }
    });

    // 「改动总览」文件项的 AI 按钮跳转过来后，切到逐文件模式并自动分析该文件
    bus.addEventListener('file:analyze:ready', () => {
      const file = state.pendingAnalyzeFile;
      if (!file) return;
      state.pendingAnalyzeFile = null;
      switchMode('files');
      const trigger = fileAnalyzeTriggers.get(file);
      if (trigger) trigger();
    });

    refresh();
    renderFilesPanel();
  },
};

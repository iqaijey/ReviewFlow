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

    // detail 归一化为 segments：单行 → 单段单行；框选/按类 → 多段多行
    const toSegments = (detail) => {
      if (Array.isArray(detail.segments) && detail.segments.length) return detail.segments;
      const hunk = detail.file.hunks[detail.hunkIndex];
      if (!hunk) return null;
      return [{ file: detail.file, hunkIndex: detail.hunkIndex, hunk, lines: [detail.line] }];
    };

    const renderContext = (segments) => {
      contextBox.textContent = '';
      const card = el('div', { class: 'explain-card' });
      let lastFile = null;
      for (const seg of segments) {
        const filePath = seg.file ? seg.file.path : '';
        if (filePath && filePath !== lastFile) {
          card.appendChild(el('div', { class: 'explain-card-file' }, filePath));
          lastFile = filePath;
        }
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

    const rangeLabel = (segments) => {
      // 按类选择：显示类名
      if (segments[0] && segments[0].classInfo) {
        const names = [...new Set(segments.map((s) => s.classInfo.name))];
        return names.length === 1 ? `类 ${names[0]}` : `${names[0]} 等 ${names.length} 个类`;
      }
      const file = segments[0].file;
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
    let previousQA = []; // 本次选择的追问历史，随新选择重置

    // 追问区：输入框 + 提问按钮，回答以 markdown 追加，最多保留最近 10 轮
    const buildFollowUp = (basePayload) => {
      if (typeof api.explainFollowUp !== 'function') return null;
      const seqAtBuild = requestSeq;
      const box = el('div', { class: 'explain-follow' });
      const list = el('div', { class: 'explain-follow-list' });
      const form = el('div', { class: 'explain-follow-form' });
      const input = el('input', {
        class: 'settings-input', type: 'text',
        placeholder: '就这次改动继续提问…', spellcheck: 'false',
      });
      const askBtn = el('button', { class: 'btn', type: 'button' }, '提问');
      form.appendChild(input);
      form.appendChild(askBtn);
      box.appendChild(list);
      box.appendChild(form);

      let asking = false;
      const submit = async () => {
        const question = input.value.trim();
        if (!question || asking) return;
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
          const { markdown, stats } = await api.explainFollowUp({
            ...basePayload,
            previousQA: [...previousQA],
            question,
            runId,
          });
          if (seqAtBuild !== requestSeq) return; // 已选择新内容，丢弃过期回答
          loading.remove();
          const mdNode = el('div', { class: 'md' });
          mdNode.innerHTML = renderMarkdown(markdown);
          item.appendChild(mdNode);
          item.appendChild(el('div', { class: 'ai-stats' }, formatStats(stats)));
          previousQA.push({ question, answer: markdown });
          if (previousQA.length > 10) previousQA = previousQA.slice(-10);
          input.value = '';
        } catch (err) {
          if (seqAtBuild !== requestSeq) return;
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

    const handleSelect = async (detail) => {
      const segments = toSegments(detail);
      if (!segments) return;
      const seq = ++requestSeq;
      previousQA = [];
      const label = rangeLabel(segments);

      renderContext(segments);
      resultBox.textContent = '';
      const loading = el('div', { class: 'explain-loading' });
      loading.appendChild(el('span', { class: 'spinner' }));
      loading.appendChild(el('span', {}, 'AI 解析中，请稍候…'));
      loading.appendChild(el('button', {
        class: 'run-link', type: 'button',
        onClick: () => ctx.showRunDetails(),
      }, '运行详情'));
      setStatus(loading);

      const payload = { folder: state.folder };
      if (detail.segments) {
        payload.filePath = segments[0].file ? segments[0].file.path : '';
        payload.segments = segments.map((s) => ({
          hunk: s.hunk,
          lines: s.lines,
          filePath: s.file ? s.file.path : undefined,
        }));
      } else {
        payload.filePath = segments[0].file.path;
        payload.hunk = segments[0].hunk;
        payload.line = segments[0].lines[0];
      }

      const plan = await loadPlanContext(api, state.folder);
      if (seq !== requestSeq) return; // 等待方案期间已选择新内容
      if (plan) payload.planContext = plan.section;

      api.explainChange(payload).then(({ markdown, stats }) => {
        if (seq !== requestSeq) return; // 已有更新的选择，丢弃过期结果
        setStatus(null);
        resultBox.innerHTML = renderMarkdown(markdown);
        resultBox.appendChild(el('div', { class: 'ai-stats' }, formatStats(stats)));
        const followUp = buildFollowUp(payload);
        if (followUp) resultBox.appendChild(followUp);
        addHistory(label, markdown);
        notify('逐句解析完成', label);
      }).catch((err) => {
        if (seq !== requestSeq) return;
        if (errText(err).includes('已被用户终止')) {
          setStatus(el('div', { class: 'empty-hint' }, '已终止'));
          return;
        }
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

import { formatStats, loadPlanContext, copyMarkdown } from '../lib/aiShared.js';
import { setStatusBox } from '../lib/statusBox.js';
// 逐句解析：展示选中行上下文，调用 AI 解释，保留历史记录
import { renderMarkdown } from '../markdown.js';
import { createChatView } from '../lib/chatView.js';
import { createRunStatus } from '../lib/runStatus.js';
import { createStreamPreview } from '../lib/streamPreview.js';

export default {
  id: 'explain',
  title: '逐句解析',

  mount(container, ctx) {
    const { el, bus, state, api, errText, notify, toast, emptyState } = ctx;

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

    const setStatus = (node, fill) => setStatusBox(statusBox, node, fill);

    let requestSeq = 0;
    let threadListSeq = 0;
    let knownFolder = state.folder;
    let activeThreadId = null;
    /** @type {ChatThreadSummary[]} */
    let lineThreads = [];
    /** @type {((cancel?: boolean) => void) | null} */
    let activeCleanup = null;
    /** @type {ReturnType<typeof createChatView> | null} */
    let activeChat = null;
    const disposeChat = () => { activeChat?.dispose(); activeChat = null; };

    const cleanupExplainRun = ({ cancel = false } = {}) => {
      activeCleanup?.(cancel);
    };

    const showIdle = () => {
      disposeChat();
      contextBox.textContent = '';
      resultBox.textContent = '';
      setStatus(emptyState('还没有选中要解析的改动',
        '在「改动总览」中点击一行改动，拖动或 ⌥+点击可框选多行'), !lineThreads.length);
    };

    // 统一成行号标注
    const lineNo = (l) => (l.newLine != null ? l.newLine : l.oldLine);

    // detail 归一化为 segments：单行 → 单段单行；框选/按类 → 多段多行
    const toSegments = (detail) => {
      if (!detail) return null;
      if (Array.isArray(detail.segments) && detail.segments.length) return detail.segments;
      if (!detail.file || !Array.isArray(detail.file.hunks)) return null;
      const hunk = detail.file.hunks[detail.hunkIndex];
      if (!hunk) return null;
      return [{ file: detail.file, hunkIndex: detail.hunkIndex, hunk, lines: [detail.line] }];
    };

    const detailFromCapturedSelection = (selection) => {
      if (!Array.isArray(selection) || !selection.length) return null;
      const segments = [];
      for (const seg of selection) {
        if (!seg || !seg.hunk || !Array.isArray(seg.hunk.lines)) continue;
        const idxs = Array.isArray(seg.selectedLineIndexes) ? seg.selectedLineIndexes : [];
        const lines = idxs.map((i) => seg.hunk.lines[i]).filter(Boolean);
        if (!lines.length) continue;
        segments.push({
          file: { path: seg.path || '', hunks: [seg.hunk] },
          hunkIndex: 0,
          hunk: seg.hunk,
          lines,
        });
      }
      if (!segments.length) return null;
      if (segments.length === 1 && segments[0].lines.length === 1) {
        return {
          file: segments[0].file,
          hunkIndex: 0,
          hunk: segments[0].hunk,
          line: segments[0].lines[0],
        };
      }
      return { file: segments[0].file, segments };
    };

    const renderInitialResult = ({ markdown, stats, detail, thread = null, threadId = null }) => {
      const folder = state.folder;
      disposeChat();
      resultBox.textContent = '';
      const mdBody = el('div', { class: 'explain-initial-body' });
      mdBody.innerHTML = renderMarkdown(markdown || '');
      resultBox.appendChild(mdBody);

      const bar = el('div', { class: 'explain-initial-bar' });
      const statsText = formatStats(stats);
      if (statsText) {
        bar.appendChild(el('div', { class: 'ai-stats' }, statsText));
      }
      const actions = el('div', { class: 'explain-initial-actions' });
      const copyBtn = el('button', {
        class: 'btn explain-action-btn explain-copy-btn',
        type: 'button',
      }, '复制');
      copyBtn.addEventListener('click', () => {
        copyMarkdown(markdown || '', toast);
      });
      const regenBtn = /** @type {HTMLButtonElement} */ (el('button', {
        class: 'btn explain-action-btn explain-regen-btn',
        type: 'button',
      }, '重新解析'));
      regenBtn.disabled = !detail;
      regenBtn.addEventListener('click', () => {
        if (!detail) return;
        if (state.folder !== folder) return;
        handleSelect(detail);
      });
      actions.appendChild(copyBtn);
      actions.appendChild(regenBtn);
      bar.appendChild(actions);
      resultBox.appendChild(bar);

      if (thread || threadId) {
        activeChat = createChatView({
          container: resultBox,
          el,
          api,
          bus,
          getFolder: () => state.folder,
          originFolder: folder,
          thread,
          threadId,
          placeholder: '就这次改动继续提问（⌘Enter 发送）…',
          label: '就本次改动继续追问',
          toast,
          errText,
          onThreadUpdated: () => {
            loadLineThreads();
          },
        });
      }
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

    const renderCapturedSelection = (selection) => {
      contextBox.textContent = '';
      if (!Array.isArray(selection) || !selection.length) return;
      const card = el('div', { class: 'explain-card' });
      let lastFile = null;
      for (const seg of selection) {
        if (!seg || !seg.hunk) continue;
        const filePath = seg.path || '';
        if (filePath && filePath !== lastFile) {
          card.appendChild(el('div', { class: 'explain-card-file' }, filePath));
          lastFile = filePath;
        }
        card.appendChild(el('div', { class: 'explain-card-hunk' }, seg.hunk.header || ''));
        const selectedIdxSet = new Set(
          Array.isArray(seg.selectedLineIndexes) ? seg.selectedLineIndexes : [],
        );
        const lines = el('div', { class: 'explain-card-lines' });
        const hunkLines = Array.isArray(seg.hunk.lines) ? seg.hunk.lines : [];
        hunkLines.forEach((l, idx) => {
          const selected = selectedIdxSet.has(idx);
          const row = el('div', {
            class: `explain-line line-${l.type}${selected ? ' line-selected' : ''}`,
          });
          const prefix = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
          row.appendChild(el('span', { class: 'explain-line-prefix' },
            selected ? '>' : prefix));
          row.appendChild(el('span', { class: 'line-content' }, l.content));
          lines.appendChild(row);
        });
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

    const renderThreadList = () => {
      historyList.textContent = '';
      if (!lineThreads.length) {
        historyTitle.style.display = 'none';
        return;
      }
      historyTitle.style.display = '';
      if (!contextBox.firstChild && !resultBox.firstChild && statusBox.classList.contains('status-fill')) {
        statusBox.classList.remove('status-fill');
      }
      for (const summary of lineThreads) {
        const item = el('div', {
          class: `explain-history-item${summary.id === activeThreadId ? ' is-active' : ''}`,
          dataset: { threadId: summary.id },
        });
        const head = el('button', {
          class: 'explain-history-head',
          type: 'button',
        });
        head.appendChild(el('span', {
          class: 'explain-thread-title',
          title: summary.title || '逐句解析',
        }, summary.title || '逐句解析'));
        head.appendChild(el('span', {
          class: 'explain-thread-time',
        }, new Date(summary.createdAt).toLocaleString()));
        head.addEventListener('click', () => {
          openLineThread(summary.id);
        });
        item.appendChild(head);
        historyList.appendChild(item);
      }
    };

    const loadLineThreads = async () => {
      const folder = state.folder;
      const seq = ++threadListSeq;
      if (!folder || typeof api.listChatThreads !== 'function') {
        lineThreads = [];
        renderThreadList();
        return;
      }
      try {
        const list = await api.listChatThreads({ folder, kind: 'line' });
        if (seq !== threadListSeq || state.folder !== folder) return;
        lineThreads = Array.isArray(list) ? list : [];
        renderThreadList();
      } catch (err) {
        if (seq !== threadListSeq || state.folder !== folder) return;
        if (toast) toast('加载历史解释失败：' + errText(err), 'error');
      }
    };

    const openLineThread = async (threadId) => {
      const folder = state.folder;
      if (!folder || !threadId || typeof api.getChatThread !== 'function') return;
      cleanupExplainRun({ cancel: true });
      const seq = ++requestSeq;
      try {
        const thread = await api.getChatThread({ folder, id: threadId });
        if (seq !== requestSeq || state.folder !== folder) return;
        if (!thread) {
          if (toast) toast('该历史解析记录不存在或已删除', 'error');
          loadLineThreads();
          return;
        }
        activeThreadId = thread.id;
        setStatus(null);
        const selectionList = thread.context ? thread.context.selection : [];
        renderCapturedSelection(selectionList);
        const restoredDetail = detailFromCapturedSelection(selectionList);
        renderInitialResult({
          markdown: (thread.context && thread.context.initialMarkdown) || '',
          stats: null,
          detail: restoredDetail,
          thread,
        });
        renderThreadList();
      } catch (err) {
        if (seq !== requestSeq || state.folder !== folder) return;
        if (toast) toast('读取历史解析失败：' + errText(err), 'error');
      }
    };

    const handleSelect = async (detail) => {
      const segments = toSegments(detail);
      const folder = state.folder;
      if (!segments || !folder) return;
      cleanupExplainRun({ cancel: true });
      const seq = ++requestSeq;
      const label = rangeLabel(segments);
      const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

      renderContext(segments);
      disposeChat();
      resultBox.textContent = '';
      const runStatus = createRunStatus({
        el,
        api,
        bus,
        runId,
        label: 'AI 解析中，请稍候…',
        compact: true,
        showDetails: () => ctx.showRunDetails(),
        toast,
        errText,
      });
      setStatus(runStatus.root);
      const stream = createStreamPreview({ el, api, runId, parent: resultBox });
      let disposed = false;
      const cleanup = (cancel = false) => {
        if (disposed) return;
        disposed = true;
        runStatus.dispose();
        stream.unsubscribe?.();
        stream.streamBox.remove();
        if (activeCleanup === cleanup) activeCleanup = null;
        if (cancel) api.cancelRun(runId).catch(() => console.warn('取消过期解析失败'));
      };
      activeCleanup = cleanup;

      /** @type {ExplainChangePayload} */
      const payload = {
        folder,
        filePath: segments[0].file ? segments[0].file.path : '',
        runId,
      };
      if (detail.segments) {
        payload.segments = segments.map((s) => ({
          hunk: s.hunk,
          lines: s.lines,
          filePath: s.file ? s.file.path : undefined,
        }));
      } else {
        payload.hunk = segments[0].hunk;
        payload.line = segments[0].lines[0];
      }

      try {
        const plan = await loadPlanContext(api, folder);
        if (seq !== requestSeq || state.folder !== folder) return;
        if (plan) payload.planContext = plan.section;
        const { markdown, stats, threadId, persistenceWarnings } = await api.explainChange(payload);
        if (seq !== requestSeq || state.folder !== folder) return;
        cleanup();
        if (Array.isArray(persistenceWarnings)) {
          for (const w of persistenceWarnings) {
            if (w && toast) toast(w, 'error');
          }
        }
        activeThreadId = threadId || null;
        setStatus(null);
        renderInitialResult({
          markdown,
          stats,
          detail,
          threadId: threadId || null,
        });
        loadLineThreads();
        notify('逐句解析完成', label);
      } catch (err) {
        if (seq !== requestSeq || state.folder !== folder) return;
        cleanup();
        resultBox.textContent = '';
        if (errText(err).includes('已被用户终止')) {
          const box = el('div', { class: 'run-terminal' });
          box.appendChild(el('span', {}, '已终止'));
          const retry = el('button', { class: 'btn explain-action-btn', type: 'button' }, '重试');
          retry.addEventListener('click', () => handleSelect(detail));
          box.appendChild(retry);
          setStatus(box);
          return;
        }
        const errBox = el('div', { class: 'review-error' });
        errBox.appendChild(el('div', { class: 'error-text' }, `解析失败：${errText(err)}`));
        const retry = el('button', { class: 'btn', type: 'button' }, '重试');
        retry.addEventListener('click', () => handleSelect(detail));
        errBox.appendChild(retry);
        setStatus(errBox);
        notify('逐句解析失败', errText(err));
      } finally {
        cleanup();
      }
    };

    bus.addEventListener('line:select', (e) => handleSelect(e.detail));
    bus.addEventListener('explain:invalidate', () => {
      if (!activeCleanup) return;
      requestSeq++;
      cleanupExplainRun({ cancel: true });
      setStatus(el('div', { class: 'empty-hint' }, '选区已更改，请点击「解析选区」开始新的解析'));
    });
    bus.addEventListener('project:changed', () => {
      cleanupExplainRun({ cancel: true });
      requestSeq++;
      threadListSeq++;
      knownFolder = state.folder;
      activeThreadId = null;
      lineThreads = [];
      renderThreadList();
      showIdle();
    });
    bus.addEventListener('changes:loaded', () => {
      if (state.folder !== knownFolder) {
        knownFolder = state.folder;
        cleanupExplainRun({ cancel: true });
        requestSeq++;
        activeThreadId = null;
        lineThreads = [];
        showIdle();
      }
      loadLineThreads();
    });

    showIdle();
    loadLineThreads();
    // tab 首次挂载前选中的行，挂载时补上一次解析
    if (state.selectedLine && (state.selectedLine.line || state.selectedLine.segments)) {
      handleSelect(state.selectedLine);
    }
  },
};

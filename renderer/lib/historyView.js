import { BACKEND_LABELS, formatStoredStats, exportReview, defaultExportName as makeExportName } from './aiShared.js';
import { renderMarkdown } from '../markdown.js';
import { createChatView } from './chatView.js';
import { renderCoverageNotices } from './reviewGuards.js';
import { trapDialogFocus, restoreDialogFocus } from './dialog.js';



const SOURCE_MODE_LABELS = {
  uncommitted: '未提交改动',
  branch: '分支对比',
  ref: '自定义引用',
  commits: '指定提交',
};

const SOURCE_SEMANTICS_LABELS = {
  'head-to-worktree': 'HEAD → 工作区 (head-to-worktree)',
  'base-to-worktree': '基准 → 工作区 (base-to-worktree)',
  'concatenated-show': '合并提交展示 (concatenated-show)',
};

const NOISE_LABELS = {
  quiet: '安静 (quiet)',
  balanced: '均衡 (balanced)',
  detailed: '详尽 (detailed)',
};

const MODEL_SOURCE_LABELS = {
  settings: '设置指定',
  'cli-config': 'CLI 配置',
  'backend-default': '后端默认',
};

const OUTCOME_LABELS = {
  complete: '完成',
  partial: '部分完成',
  failed: '失败',
};



function shortHash(value, length = 8) {
  if (typeof value !== 'string' || !value.trim()) return '—';
  return value.trim().slice(0, length);
}

function formatKindLabel(kind) {
  if (kind === 'full') return '完整讲解';
  if (!kind || kind === 'review') return '评审';
  return String(kind);
}

function formatBackendRole(slotId, role) {
  if (role === 'synthesizer') {
    if (typeof slotId === 'string' && slotId.includes('fallback')) {
      return '汇总回退 (synthesizer-fallback)';
    }
    return '汇总 (synthesizer)';
  }
  return `评审 (${slotId || 'reviewer'})`;
}

export function buildProvenancePanel(el, provenance) {
  const panel = el('div', { class: 'provenance-panel' });
  panel.appendChild(el('div', { class: 'provenance-title' }, '来源信息'));
  if (!provenance || typeof provenance !== 'object') {
    panel.appendChild(el('div', { class: 'provenance-empty' }, '来源信息不可用（旧记录）'));
    return panel;
  }

  const grid = el('div', { class: 'provenance-grid' });
  const addField = (label, valueText, fullTitle = '', mono = false) => {
    const field = el('div', { class: 'provenance-field' });
    field.appendChild(el('span', { class: 'provenance-label' }, `${label}：`));
    field.appendChild(el('span', {
      class: `provenance-value${mono ? ' provenance-mono' : ''}`,
      title: fullTitle || String(valueText),
    }, String(valueText)));
    grid.appendChild(field);
  };

  const source = provenance.source || {
    mode: null,
    requestedBase: null,
    branch: null,
    headSha: null,
    baseSha: null,
    commits: [],
    semantics: null,
  };
  const modeLabel = (source.mode && SOURCE_MODE_LABELS[source.mode]) || source.mode || '未知模式';
  const semLabel = (source.semantics && SOURCE_SEMANTICS_LABELS[source.semantics]) || source.semantics || '—';
  addField('改动来源', `${modeLabel} · ${semLabel}`);

  const branchParts = [source.branch || '—'];
  if (source.requestedBase) branchParts.push(`基准 ${source.requestedBase}`);
  addField('分支 / 基准', branchParts.join(' · '));

  const shaSummary = `HEAD ${shortHash(source.headSha, 8)} / Base ${shortHash(source.baseSha, 8)}`;
  const shaTitle = `HEAD: ${source.headSha || '—'}\nBase: ${source.baseSha || '—'}`;
  addField('基准 / HEAD SHA', shaSummary, shaTitle, true);

  const commits = Array.isArray(source.commits) ? source.commits : [];
  if (commits.length) {
    const commitShort = commits.map((c) => shortHash(c && c.sha, 7)).join(', ');
    const commitFull = commits
      .map((c) => `${c.sha}${Array.isArray(c.parentShas) && c.parentShas.length ? ` (parents: ${c.parentShas.map((p) => shortHash(p, 7)).join(',')})` : ''}`)
      .join('\n');
    addField('所选提交', `${commits.length} 个 (${commitShort})`, commitFull, true);
  } else {
    addField('所选提交', '—');
  }

  addField('Diff 指纹', shortHash(provenance.diffFingerprint, 12), provenance.diffFingerprint || '', true);

  const files = Array.isArray(provenance.files) ? provenance.files : [];
  const reviewedCount = files.filter((f) => f && f.reviewed).length;
  const truncatedCount = files.filter((f) => f && f.truncated).length;
  const resourceCount = files.filter((f) => f && f.resource).length;
  let fileSummary = `共 ${files.length} 个 · 已评审 ${reviewedCount} 个`;
  if (resourceCount) fileSummary += ` · 资源 ${resourceCount} 个`;
  if (truncatedCount) fileSummary += ` · 截断 ${truncatedCount} 个`;
  addField('文件统计', fileSummary);

  const planText = provenance.plan
    ? `${provenance.plan.title || provenance.plan.id} (${shortHash(provenance.plan.contextHash, 8)})`
    : '未启用';
  addField('需求方案', planText, provenance.plan ? `${provenance.plan.title} [${provenance.plan.id}] hash:${provenance.plan.contextHash}` : '');

  const presetText = provenance.preset
    ? (provenance.preset.name || provenance.preset.id)
    : '默认设置';
  addField('评审预设', presetText, provenance.preset ? `${provenance.preset.name} [${provenance.preset.id}]` : '');

  const rules = provenance.projectRules;
  const rulesText = rules && rules.fileHash
    ? `文件 ${shortHash(rules.fileHash, 8)} / 注入 ${shortHash(rules.injectedHash, 8)}`
    : '未配置';
  const rulesTitle = rules
    ? `fileHash: ${rules.fileHash || 'null'}\ninjectedHash: ${rules.injectedHash || '—'}`
    : '';
  addField('.reviewflow.md', rulesText, rulesTitle, true);

  addField(
    '版本信息',
    `App v${provenance.appVersion || '—'} · ${provenance.promptVersion || '—'} (${shortHash(provenance.promptInputsHash, 8)})`,
    `appVersion: ${provenance.appVersion || '—'}\npromptVersion: ${provenance.promptVersion || '—'}\npromptInputsHash: ${provenance.promptInputsHash || '—'}`,
  );

  const noiseLabel = (provenance.noiseLevel && NOISE_LABELS[provenance.noiseLevel]) || provenance.noiseLevel || '—';
  addField('噪声等级', noiseLabel);

  panel.appendChild(grid);

  const backends = Array.isArray(provenance.backends) ? provenance.backends : [];
  if (backends.length) {
    const backendBox = el('div', { class: 'provenance-backends' });
    for (const b of backends) {
      const row = el('div', { class: 'provenance-backend-row' });
      const roleClass = b.role === 'synthesizer' ? 'role-synthesizer' : 'role-reviewer';
      row.appendChild(el('span', { class: `history-role-badge ${roleClass}` }, formatBackendRole(b.slotId, b.role)));
      row.appendChild(el('span', { class: 'provenance-mono' }, BACKEND_LABELS[b.backend] || b.backend || '未知后端'));
      const modelDisplay = b.resolvedModel || b.requestedModel || '默认模型';
      const reqDiff = b.requestedModel && b.resolvedModel && b.requestedModel !== b.resolvedModel
        ? `（请求 ${b.requestedModel}）`
        : '';
      const sourceLabel = MODEL_SOURCE_LABELS[b.modelSource] || b.modelSource || '';
      row.appendChild(el('span', { class: 'provenance-mono' }, `${modelDisplay}${reqDiff}${sourceLabel ? ` [${sourceLabel}]` : ''}`));
      row.appendChild(el('span', {}, b.effort ? `思考 ${b.effort}` : '默认强度'));
      backendBox.appendChild(row);
    }
    panel.appendChild(backendBox);
  }

  if (files.length) {
    const details = el('details', { class: 'provenance-files-details' });
    details.appendChild(el('summary', {}, `查看快照文件列表（${files.length}）`));
    const fileList = el('div', { class: 'provenance-files-list' });
    for (const f of files) {
      const item = el('div', { class: 'provenance-file-item' });
      item.appendChild(el('span', {}, `[${f.status || 'M'}]`));
      item.appendChild(el('span', { title: f.path }, f.oldPath ? `${f.oldPath} → ${f.path}` : f.path));
      item.appendChild(el('span', {}, f.reviewed ? '已评审' : (f.resource ? '资源跳过' : '未评审')));
      if (f.truncated) item.appendChild(el('span', {}, '已截断'));
      item.appendChild(el('span', { title: f.diffFingerprint }, shortHash(f.diffFingerprint, 8)));
      fileList.appendChild(item);
    }
    details.appendChild(fileList);
    panel.appendChild(details);
  }

  return panel;
}

export function buildPerModelSection(el, perModel, markdown = renderMarkdown) {
  if (!Array.isArray(perModel) || !perModel.length) return null;
  const det = el('details', { class: 'multi-raw history-per-model' });
  const pendingBodies = [];
  det.appendChild(el('summary', {}, `各模型原始结果（${perModel.length}）`));
  for (const pm of perModel) {
    const block = el('div', { class: 'history-per-model-item' });
    const head = el('div', { class: 'history-per-model-head' });
    const roleClass = pm.role === 'synthesizer' ? 'role-synthesizer' : 'role-reviewer';
    head.appendChild(el('span', { class: `history-role-badge ${roleClass}` }, formatBackendRole(pm.slotId, pm.role)));
    const backendLabel = pm.label || BACKEND_LABELS[pm.backend] || pm.backend || '模型';
    head.appendChild(el('span', {}, `${backendLabel}${pm.model ? ` · ${pm.model}` : ''}`));
    if (pm.effort) {
      head.appendChild(el('span', { class: 'provenance-mono' }, `思考 ${pm.effort}`));
    }
    const outcome = pm.outcome || (pm.markdown ? 'complete' : 'failed');
    head.appendChild(el('span', {
      class: `history-outcome-badge outcome-${outcome}`,
    }, OUTCOME_LABELS[outcome] || outcome));
    block.appendChild(head);

    if (pm.error) {
      block.appendChild(el('div', { class: 'error-text' }, `失败：${pm.error}`));
    }
    if (pm.markdown) {
      const mdNode = el('div', { class: 'md' });
      pendingBodies.push({ node: mdNode, content: pm.markdown });
      block.appendChild(mdNode);
    }
    if (pm.stats) {
      block.appendChild(el('div', { class: 'ai-stats' }, formatStoredStats(pm.stats)));
    }
    det.appendChild(block);
  }
  det.addEventListener('toggle', () => {
    if (!det.open) return;
    for (const { node, content } of pendingBodies.splice(0)) node.innerHTML = markdown(content);
  });
  return det;
}

/**
 * @param {{
 *   container: HTMLElement,
 *   el: (tag: string, attrs?: Record<string, any>, children?: any) => HTMLElement,
 *   api: AutoReviewApi,
 *   bus?: EventTarget,
 *   getFolder: () => string | null,
 *   kind?: string,
 *   emptyState: (title: string, sub?: string, action?: { label: string, onClick: () => void } | null) => HTMLElement,
 *   selectFolder?: () => void,
 *   toast: (msg: string, type?: string) => void,
 *   errText: (err: any) => string,
 *   onEntryUpdated?: (entry: ReviewHistoryEntry) => void,
 * }} opts
 */
export function createHistoryView({
  container,
  el,
  api,
  bus,
  getFolder,
  kind = 'review',
  emptyState,
  selectFolder,
  toast,
  errText,
  onEntryUpdated,
}) {
  /** @type {ReviewHistoryEntry[]} */
  let entries = [];
  /** @type {Map<string, ReviewHistoryEntry>} */
  const entryCache = new Map();
  /** @type {Set<string>} */
  const expandedIds = new Set();
  /** @type {Set<string>} */
  const selectedIds = new Set();
  const openChatIds = new Set();
  const chatThreadsByReviewId = new Map();
  /** @type {string | null} */
  let editingId = null;
  let editingValue = '';
  let currentQuery = '';
  /** @type {string | null} */
  let knownFolder = null;
  let loadSeq = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let searchTimer = null;
  /** @type {Map<string, ReturnType<typeof createChatView>>} */
  const chats = new Map();
  /** @type {Map<string, import('./chatView.js').PendingChatOperation>} */
  const pendingChatOperations = new Map();
  let chatGeneration = 0;
  const perModelOpenIds = new Set();
  /** @type {Map<string, string>} */
  const perModelMarkdownCache = new Map();
  const markdownCache = new Map();
  const disposeChats = () => { for (const chat of chats.values()) chat.dispose(); chats.clear(); };
  const entryMarkdown = (entry) => {
    const cached = markdownCache.get(entry.id);
    if (cached?.markdown === entry.markdown) return cached.html;
    const html = renderMarkdown(entry.markdown || '');
    markdownCache.set(entry.id, { markdown: entry.markdown, html });
    return html;
  };
  const perModelMarkdown = (content) => {
    if (!perModelMarkdownCache.has(content)) perModelMarkdownCache.set(content, renderMarkdown(content));
    return perModelMarkdownCache.get(content) || '';
  };
  const entryPerModel = (entry) => {
    const node = buildPerModelSection(el, entry.perModel, perModelMarkdown);
    if (!node) return null;
    node.addEventListener('toggle', () => {
      if (node.open) perModelOpenIds.add(entry.id);
      else perModelOpenIds.delete(entry.id);
    });
    if (perModelOpenIds.has(entry.id)) {
      node.open = true;
      node.dispatchEvent(new Event('toggle'));
    }
    return node;
  };
  bus?.addEventListener('project:changed', () => {
    loadSeq++;
    chatGeneration++;
    pendingChatOperations.clear();
    disposeChats();
    markdownCache.clear();
    perModelMarkdownCache.clear();
    perModelOpenIds.clear();
    closeActiveDialog(null);
  });

  /** @type {HTMLElement | null} */
  let activeOverlay = null;
  /** @type {((ev: KeyboardEvent) => void) | null} */
  let activeKeyHandler = null;

  /**
   * @param {HTMLElement | null} returnFocusEl
   * @param {(() => HTMLElement | null | undefined) | null} [fallbackFn]
   */
  function closeActiveDialog(returnFocusEl, fallbackFn = null) {
    if (activeKeyHandler) {
      document.removeEventListener('keydown', activeKeyHandler, true);
      activeKeyHandler = null;
    }
    if (activeOverlay) {
      activeOverlay.remove();
      activeOverlay = null;
    }
    if (returnFocusEl || fallbackFn) {
      restoreDialogFocus(returnFocusEl, fallbackFn);
    }
  }

  function openDialog({ title, opener, reviewId = null, dialogClass = 'findings-dialog', build }) {
    closeActiveDialog(null);
    const resolvedReviewId = reviewId
      || (opener && typeof opener.closest === 'function'
        ? (/** @type {HTMLElement | null} */ (opener.closest('.history-item')))?.dataset?.reviewId || null
        : null);
    const titleId = `history-dialog-title-${Date.now()}`;
    const overlay = el('div', { class: 'modal-overlay' });
    const dialog = el('div', {
      class: dialogClass,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      tabindex: '-1',
    });
    const findHistoryFallbackFocus = () => {
      if (opener && document.contains(opener)) return opener;
      if (resolvedReviewId) {
        const row = [...listHost.querySelectorAll('.history-item')].find(
          (node) => node instanceof HTMLElement && node.dataset && node.dataset.reviewId === resolvedReviewId,
        );
        if (row instanceof HTMLElement) {
          const btn = row.querySelector('button:not([disabled]), input:not([disabled])');
          if (btn instanceof HTMLElement) return btn;
          return row;
        }
      }
      const firstRowBtn = listHost.querySelector('.history-item button:not([disabled]), .history-item input:not([disabled])');
      if (firstRowBtn instanceof HTMLElement) return firstRowBtn;
      const listEl = listHost.querySelector('.history-list');
      if (listEl instanceof HTMLElement) return listEl;
      if (document.contains(searchInput)) return searchInput;
      return listHost;
    };
    const close = () => { if (activeOverlay === overlay) closeActiveDialog(opener, findHistoryFallbackFocus); };
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) close();
    });
    const onKeyDown = (/** @type {KeyboardEvent} */ ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        close();
        return;
      }
      trapDialogFocus(dialog, ev);
    };
    activeOverlay = overlay;
    activeKeyHandler = onKeyDown;
    document.addEventListener('keydown', onKeyDown, true);

    const initialFocus = build(dialog, titleId, close);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    if (initialFocus && typeof initialFocus.focus === 'function') {
      initialFocus.focus();
    } else {
      dialog.focus();
    }
  }

  function matchesKind(entry) {
    if (!entry) return false;
    return kind === 'full' ? entry.kind === 'full' : entry.kind !== 'full';
  }

  function sortEntries(list) {
    return [...list].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (b.createdAt - a.createdAt));
  }

  const root = el('div', { class: 'history-view' });
  const toolbar = el('div', { class: 'history-toolbar' });
  const searchId = `history-search-${kind}`;
  const searchGroup = el('div', { class: 'history-search-group' });
  searchGroup.appendChild(el('label', { class: 'history-search-label', for: searchId }, '搜索历史'));
  const searchInput = /** @type {HTMLInputElement} */ (el('input', {
    id: searchId,
    class: 'history-search-input',
    type: 'text',
    placeholder: '搜索标题、正文、文件路径或模型…',
    spellcheck: 'false',
  }));
  searchGroup.appendChild(searchInput);
  toolbar.appendChild(searchGroup);

  const compareBar = el('div', { class: 'history-compare-bar' });
  const compareHint = el('span', { class: 'history-compare-hint' }, '勾选 2 条记录可对比');
  const clearSelectBtn = /** @type {HTMLButtonElement} */ (el('button', {
    class: 'btn history-action-btn',
    type: 'button',
    style: 'display:none',
  }, '清除选择'));
  const compareBtn = /** @type {HTMLButtonElement} */ (el('button', {
    class: 'btn history-action-btn',
    type: 'button',
  }, '对比'));
  compareBtn.disabled = true;
  compareBar.appendChild(compareHint);
  compareBar.appendChild(clearSelectBtn);
  compareBar.appendChild(compareBtn);
  toolbar.appendChild(compareBar);

  const listHost = el('div', { class: 'history-list-host' });

  function syncCompareBar() {
    const count = selectedIds.size;
    compareHint.textContent = count ? `已选 ${count}/2 条` : '勾选 2 条记录可对比';
    clearSelectBtn.style.display = count > 0 ? '' : 'none';
    compareBtn.disabled = count !== 2;
  }

  clearSelectBtn.addEventListener('click', () => {
    selectedIds.clear();
    syncCompareBar();
    renderList();
  });

  compareBtn.addEventListener('click', async () => {
    if (selectedIds.size !== 2) return;
    const folder = getFolder();
    const ids = [...selectedIds];
    /** @type {ReviewHistoryEntry[]} */
    const pair = [];
    for (const id of ids) {
      let item = entries.find((e) => e.id === id) || entryCache.get(id) || null;
      if (!item && folder && typeof api.getReview === 'function') {
        try {
          item = await api.getReview({ folder, id });
        } catch {
          item = null;
        }
      }
      if (item) pair.push(item);
    }
    if (pair.length !== 2) {
      toast('所选记录已不存在，请重新选择', 'error');
      selectedIds.clear();
      syncCompareBar();
      await load();
      return;
    }
    openCompareDialog(pair[0], pair[1], compareBtn);
  });

  searchInput.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      searchTimer = null;
      currentQuery = searchInput.value.trim();
      load();
    }, 180);
  });

  searchInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (searchInput.value) {
        searchInput.value = '';
        currentQuery = '';
        if (searchTimer) {
          clearTimeout(searchTimer);
          searchTimer = null;
        }
        load();
      }
      searchInput.blur();
    }
  });

  function openCompareDialog(leftEntry, rightEntry, opener) {
    openDialog({
      title: '历史记录双栏对比',
      opener,
      dialogClass: 'history-compare-dialog',
      build: (dialog, titleId, close) => {
        const header = el('div', { class: 'history-compare-header' });
        header.appendChild(el('div', { class: 'history-compare-title', id: titleId }, '历史记录对比'));
        const closeBtn = /** @type {HTMLButtonElement} */ (el('button', {
          class: 'btn history-action-btn',
          type: 'button',
          onClick: close,
        }, '关闭'));
        header.appendChild(closeBtn);
        dialog.appendChild(header);

        const grid = el('div', { class: 'history-compare-grid' });
        for (const entry of [leftEntry, rightEntry]) {
          const pane = el('div', { class: 'history-compare-pane' });
          const paneHead = el('div', { class: 'history-compare-pane-head' });
          paneHead.appendChild(el('div', { class: 'history-compare-pane-title' }, entry.title));
          const meta = el('div', { class: 'history-compare-pane-meta' });
          meta.appendChild(el('span', {}, new Date(entry.createdAt).toLocaleString()));
          meta.appendChild(el('span', { class: 'history-kind-badge' }, formatKindLabel(entry.kind)));
          if (entry.pinned) {
            meta.appendChild(el('span', { class: 'history-pin-badge' }, '置顶'));
          }
          if (entry.stats) {
            meta.appendChild(el('span', {}, formatStoredStats(entry.stats)));
          }
          paneHead.appendChild(meta);
          pane.appendChild(paneHead);
          pane.appendChild(buildProvenancePanel(el, entry.provenance));
          const coverage = el('div');
          renderCoverageNotices(el, coverage, entry.coverageNotices);
          pane.appendChild(coverage);
          const mdNode = el('div', { class: 'md' });
          mdNode.innerHTML = entryMarkdown(entry);
          pane.appendChild(mdNode);
          const perModelNode = buildPerModelSection(el, entry.perModel, perModelMarkdown);
          if (perModelNode) pane.appendChild(perModelNode);
          grid.appendChild(pane);
        }
        dialog.appendChild(grid);
        return closeBtn;
      },
    });
  }

  function openDeleteConfirmDialog(entry, opener) {
    openDialog({
      title: '确认删除历史记录',
      opener,
      reviewId: entry.id,
      dialogClass: 'findings-dialog',
      build: (dialog, titleId, close) => {
        dialog.appendChild(el('div', { class: 'commit-modal-title', id: titleId }, '确认删除历史记录'));
        const body = el('div', { class: 'findings-dialog-body' });
        body.appendChild(el('div', {}, `确定要删除「${entry.title}」吗？该操作不可撤销。`));
        dialog.appendChild(body);

        const footer = el('div', { class: 'commit-modal-footer' });
        const cancelBtn = /** @type {HTMLButtonElement} */ (el('button', {
          class: 'btn',
          type: 'button',
          onClick: close,
        }, '取消'));
        const confirmBtn = /** @type {HTMLButtonElement} */ (el('button', {
          class: 'btn btn-danger',
          type: 'button',
        }, '确认删除'));
        confirmBtn.addEventListener('click', async () => {
          const folder = getFolder();
          if (!folder) return;
          confirmBtn.disabled = true;
          cancelBtn.disabled = true;
          try {
            const delRes = await api.deleteReview({ folder, id: entry.id });
            if (getFolder() !== folder) { close(); return; }
            if (delRes && Array.isArray(delRes.persistenceWarnings)) {
              for (const w of delRes.persistenceWarnings) {
                if (w) toast(w, 'error');
              }
            }
            selectedIds.delete(entry.id);
            expandedIds.delete(entry.id);
            openChatIds.delete(entry.id);
            chatThreadsByReviewId.delete(entry.id);
            entryCache.delete(entry.id);
            entries = entries.filter((e) => e.id !== entry.id);
            syncCompareBar();
            renderList();
            close();
          } catch (err) {
            confirmBtn.disabled = false;
            cancelBtn.disabled = false;
            toast('删除失败：' + errText(err), 'error');
          }
        });
        footer.appendChild(cancelBtn);
        footer.appendChild(confirmBtn);
        dialog.appendChild(footer);
        return cancelBtn;
      },
    });
  }

  async function handleExportMarkdown(entry, btn) {
    btn.disabled = true;
    try {
          await exportReview(api, toast, errText, () => ({
        defaultName: makeExportName(entry.kind === 'full' ? 'fullexplain' : 'review', 'md'),
        content: entry.markdown || '',
        ext: 'md',
      }));
        } finally {
      btn.disabled = false;
    }
  }

  async function handleTogglePin(entry, btn) {
    const folder = getFolder();
    if (!folder) return;
    btn.disabled = true;
    try {
      const updated = await api.setReviewPinned({
        folder,
        id: entry.id,
        pinned: !entry.pinned,
      });
      if (getFolder() !== folder) return;
      if (updated && updated.id) {
        entryCache.set(updated.id, updated);
      }
      await load();
    } catch (err) {
      btn.disabled = false;
      toast('置顶状态更新失败：' + errText(err), 'error');
    }
  }

  async function submitRename(entry, rawValue) {
    const folder = getFolder();
    if (!folder) return;
    const trimmed = String(rawValue || '').trim();
    if (!trimmed || trimmed.length > 200) {
      toast('评审标题须为 1–200 个字符', 'error');
      return;
    }
    try {
      const updated = await api.renameReview({
        folder,
        id: entry.id,
        title: trimmed,
      });
      if (getFolder() !== folder) return;
      editingId = null;
      editingValue = '';
      if (updated && updated.id) {
        entryCache.set(updated.id, updated);
        entries = entries.map((e) => (e.id === updated.id ? updated : e));
        if (typeof onEntryUpdated === 'function') onEntryUpdated(updated);
      }
      renderList();
    } catch (err) {
      toast('重命名失败：' + errText(err), 'error');
    }
  }

  function renderList() {
    const originFolder = knownFolder;
    const generation = chatGeneration;
    const visibleIds = new Set(entries.map((entry) => entry.id));
    for (const [id, chat] of chats) {
      if (!visibleIds.has(id)) { chat.dispose(); chats.delete(id); }
    }
    listHost.textContent = '';
    if (!entries.length) {
      if (currentQuery) {
        listHost.appendChild(emptyState('未找到匹配的历史记录', '请尝试其他搜索关键词或清空搜索框'));
      } else if (kind === 'full') {
        listHost.appendChild(emptyState('暂无历史讲解记录', '完成一次完整讲解后会自动保存到这里'));
      } else {
        listHost.appendChild(emptyState('暂无历史评审记录', '完成一次整体分析后会自动保存到这里'));
      }
      return;
    }

    const list = el('div', { class: 'history-list review-history' });
    for (const entry of entries) {
      const isExpanded = expandedIds.has(entry.id);
      const isSelected = selectedIds.has(entry.id);
      const isEditing = editingId === entry.id;

      const item = el('div', {
        class: `history-item review-history-item${entry.pinned ? ' is-pinned' : ''}`,
        dataset: { reviewId: entry.id },
      });

      const row = el('div', { class: 'history-row' });

      const cbId = `history-select-${kind}-${entry.id}`;
      const cbLabel = el('label', {
        class: 'history-check-label',
        for: cbId,
        title: '勾选两条记录进行对比',
      });
      const cb = /** @type {HTMLInputElement} */ (el('input', {
        id: cbId,
        class: 'history-check-input',
        type: 'checkbox',
        'aria-label': `选择「${entry.title}」用于对比`,
      }));
      cb.checked = isSelected;
      if (!isSelected && selectedIds.size >= 2) {
        cb.disabled = true;
      }
      cb.addEventListener('change', () => {
        if (cb.checked) {
          if (selectedIds.size >= 2) {
            cb.checked = false;
            return;
          }
          selectedIds.add(entry.id);
        } else {
          selectedIds.delete(entry.id);
        }
        syncCompareBar();
        renderList();
      });
      cbLabel.appendChild(cb);
      row.appendChild(cbLabel);

      if (isEditing) {
        const renameWrap = el('div', { class: 'history-rename-wrap' });
        const renameInput = /** @type {HTMLInputElement} */ (el('input', {
          class: 'history-rename-input',
          type: 'text',
          maxlength: '200',
          'aria-label': '重命名评审标题',
          spellcheck: 'false',
        }));
        renameInput.value = editingValue;
        const saveBtn = el('button', {
          class: 'btn history-action-btn',
          type: 'button',
          onClick: () => submitRename(entry, renameInput.value),
        }, '保存');
        const cancelBtn = el('button', {
          class: 'btn history-action-btn',
          type: 'button',
          onClick: () => {
            editingId = null;
            editingValue = '';
            renderList();
          },
        }, '取消');
        renameInput.addEventListener('input', () => {
          editingValue = renameInput.value;
        });
        renameInput.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            submitRename(entry, renameInput.value);
          } else if (ev.key === 'Escape') {
            ev.preventDefault();
            ev.stopPropagation();
            editingId = null;
            editingValue = '';
            renderList();
          }
        });
        renameWrap.appendChild(renameInput);
        renameWrap.appendChild(saveBtn);
        renameWrap.appendChild(cancelBtn);
        row.appendChild(renameWrap);
        queueMicrotask(() => {
          if (document.contains(renameInput)) {
            renameInput.focus();
            renameInput.select();
          }
        });
      } else {
        const expandBtn = el('button', {
          class: 'history-expand-btn review-history-head',
          type: 'button',
          'aria-expanded': isExpanded ? 'true' : 'false',
        });
        expandBtn.appendChild(el('span', { class: 'history-expand-arrow' }, isExpanded ? '▾' : '▸'));
        if (entry.pinned) {
          expandBtn.appendChild(el('span', { class: 'history-pin-badge' }, '置顶'));
        }
        expandBtn.appendChild(el('span', { class: 'history-row-title review-history-title', title: entry.title }, entry.title));
        expandBtn.appendChild(el('span', { class: 'history-kind-badge' }, formatKindLabel(entry.kind)));
        expandBtn.appendChild(el('span', { class: 'history-row-time review-history-time' },
          new Date(entry.createdAt).toLocaleString()));
        const statsText = formatStoredStats(entry.stats);
        if (statsText) {
          expandBtn.appendChild(el('span', { class: 'history-row-stats ai-stats' }, statsText));
        }
        expandBtn.addEventListener('click', () => {
          if (expandedIds.has(entry.id)) expandedIds.delete(entry.id);
          else expandedIds.add(entry.id);
          renderList();
        });
        row.appendChild(expandBtn);
      }

      const actions = el('div', { class: 'history-item-actions' });
      const pinBtn = /** @type {HTMLButtonElement} */ (el('button', {
        class: 'btn history-action-btn',
        type: 'button',
      }, entry.pinned ? '取消置顶' : '置顶'));
      pinBtn.addEventListener('click', () => handleTogglePin(entry, pinBtn));

      const renameBtn = /** @type {HTMLButtonElement} */ (el('button', {
        class: 'btn history-action-btn',
        type: 'button',
        onClick: () => {
          editingId = entry.id;
          editingValue = entry.title || '';
          renderList();
        },
      }, '重命名'));

      const exportMdBtn = /** @type {HTMLButtonElement} */ (el('button', {
        class: 'btn history-action-btn',
        type: 'button',
      }, '导出 Markdown'));
      exportMdBtn.addEventListener('click', () => handleExportMarkdown(entry, exportMdBtn));

      const deleteBtn = /** @type {HTMLButtonElement} */ (el('button', {
        class: 'btn btn-danger history-action-btn',
        type: 'button',
        onClick: () => openDeleteConfirmDialog(entry, deleteBtn),
      }, '删除'));

      actions.appendChild(pinBtn);
      actions.appendChild(renameBtn);
      actions.appendChild(exportMdBtn);
      actions.appendChild(deleteBtn);
      row.appendChild(actions);
      item.appendChild(row);

      if (isExpanded) {
        const body = el('div', { class: 'history-body review-history-body' });
        body.appendChild(buildProvenancePanel(el, entry.provenance));
        const coverage = el('div');
        renderCoverageNotices(el, coverage, entry.coverageNotices);
        body.appendChild(coverage);
        const mdNode = el('div', { class: 'md' });
        mdNode.innerHTML = entryMarkdown(entry);
        body.appendChild(mdNode);
        const perModelNode = entryPerModel(entry);
        if (perModelNode) body.appendChild(perModelNode);

        if (typeof api.createChatThread === 'function') {
          const chatBar = el('div', { class: 'history-chat-bar' });
          const followUpBtn = el('button', {
            class: 'btn history-action-btn history-followup-btn',
            type: 'button',
          }, '继续追问');
          chatBar.appendChild(followUpBtn);
          const chatHost = el('div', { class: 'history-chat-host' });
          body.appendChild(chatBar);
          body.appendChild(chatHost);

          const mountEntryChat = (loadedThread, shouldFocus) => {
            const existing = chats.get(entry.id);
            if (existing) {
              chatHost.appendChild(existing.root);
              if (shouldFocus) existing.focus();
              return;
            }
            chatHost.textContent = '';
            const chat = createChatView({
              container: chatHost,
              el,
              api,
              bus,
              getFolder,
              originFolder,
              thread: loadedThread,
              placeholder: `就「${entry.title}」继续追问（⌘Enter 发送）…`,
              label: `就「${entry.title}」继续追问`,
              toast,
              errText,
              onSendingChanged: (sending, operation) => {
                if (getFolder() !== originFolder || generation !== chatGeneration) return;
                if (sending && operation) pendingChatOperations.set(entry.id, operation);
                else pendingChatOperations.delete(entry.id);
                const replacement = chats.get(entry.id);
                if (replacement && replacement !== chat) replacement.setPendingOperation(operation);
              },
              onThreadUpdated: (updatedThread) => {
                if (getFolder() !== originFolder || generation !== chatGeneration) return;
                chatThreadsByReviewId.set(entry.id, updatedThread);
                const replacement = chats.get(entry.id);
                if (replacement && replacement !== chat) replacement.setThread(updatedThread);
              },
            });
            chats.set(entry.id, chat);
            chat.setPendingOperation(pendingChatOperations.get(entry.id) || null);
            if (shouldFocus) chat.focus();
          };

          const openEntryChat = async (shouldFocus) => {
            const folder = originFolder;
            if (!folder || getFolder() !== folder) return;
            followUpBtn.setAttribute('disabled', '');
            try {
              const created = await api.createChatThread({ folder, reviewId: entry.id });
              if (getFolder() !== folder || !listHost.contains(chatHost)) return;
              if (created && Array.isArray(created.persistenceWarnings)) {
                for (const w of created.persistenceWarnings) {
                  if (w) toast(w, 'error');
                }
              }
              const loaded = (typeof api.getChatThread === 'function'
                ? await api.getChatThread({ folder, id: created.id })
                : null) || created;
              if (getFolder() !== folder || !listHost.contains(chatHost)) return;
              openChatIds.add(entry.id);
              chatThreadsByReviewId.set(entry.id, loaded);
              mountEntryChat(loaded, shouldFocus);
            } catch (err) {
              toast('打开追问会话失败：' + errText(err), 'error');
            } finally {
              followUpBtn.removeAttribute('disabled');
            }
          };

          followUpBtn.addEventListener('click', () => {
            openEntryChat(true);
          });

          if (openChatIds.has(entry.id)) {
            const cachedThread = chatThreadsByReviewId.get(entry.id);
            if (cachedThread) {
              mountEntryChat(cachedThread, false);
            } else {
              openEntryChat(false);
            }
          }
        }

        item.appendChild(body);
      }

      list.appendChild(item);
    }
    listHost.appendChild(list);
  }

  async function load() {
    const folder = getFolder();
    const seq = ++loadSeq;
    if (folder !== knownFolder) {
      chatGeneration++;
      pendingChatOperations.clear();
      disposeChats();
      markdownCache.clear();
      perModelMarkdownCache.clear();
      perModelOpenIds.clear();
      knownFolder = folder;
      selectedIds.clear();
      expandedIds.clear();
      openChatIds.clear();
      chatThreadsByReviewId.clear();
      entryCache.clear();
      editingId = null;
      editingValue = '';
      syncCompareBar();
    }
    if (!folder) {
      container.textContent = '';
      const emptyLabel = kind === 'full'
        ? '选择一个项目后，这里会显示历史讲解记录'
        : '选择一个项目后，这里会显示历史评审记录';
      container.appendChild(emptyState('请先选择项目文件夹', emptyLabel,
        selectFolder ? { label: '选择项目', onClick: () => selectFolder() } : null));
      return;
    }

    if (!root.parentNode) {
      container.textContent = '';
      root.appendChild(toolbar);
      root.appendChild(listHost);
      container.appendChild(root);
    }

    try {
      const options = kind === 'full'
        ? { query: currentQuery, kind }
        : { query: currentQuery };
      const fetched = await api.listReviews(folder, options);
      if (seq !== loadSeq || getFolder() !== folder) return;
      entries = (Array.isArray(fetched) ? fetched : []).filter(matchesKind);
      for (const e of entries) {
        if (e && e.id) entryCache.set(e.id, e);
      }
      renderList();
    } catch (err) {
      if (seq !== loadSeq || getFolder() !== folder) return;
      disposeChats();
      listHost.textContent = '';
      listHost.appendChild(el('div', { class: 'error-text' }, `加载历史失败：${errText(err)}`));
    }
  }

  function upsertEntry(historyEntry, originFolder) {
    if (!historyEntry || !matchesKind(historyEntry)) return;
    const folder = getFolder();
    if (!folder || folder !== originFolder) return;
    if (folder !== knownFolder) {
      knownFolder = folder;
      entries = [];
      entryCache.clear();
    }
    entryCache.set(historyEntry.id, historyEntry);
    if (currentQuery) {
      if (container.style.display !== 'none') {
        load();
      }
      return;
    }
    const filtered = entries.filter((e) => e.id !== historyEntry.id);
    filtered.unshift(historyEntry);
    entries = sortEntries(filtered);
    if (container.style.display !== 'none') {
      if (!root.parentNode) {
        container.textContent = '';
        root.appendChild(toolbar);
        root.appendChild(listHost);
        container.appendChild(root);
      }
      renderList();
    }
  }

  return {
    load,
    upsertEntry,
  };
}

export { formatStoredStats as formatHistoryStats };

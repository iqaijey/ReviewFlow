import overviewTab from './tabs/overview.js';
import reviewTab from './tabs/review.js';
import explainTab from './tabs/explain.js';
import fullExplainTab from './tabs/fullExplain.js';
import settingsTab from './tabs/settings.js';
import planTab from './tabs/plan.js';
import { createRunDetails } from './runDetails.js';
import { createCommandPalette } from './lib/commandPalette.js';
import { createThemeManager } from './lib/theme.js';
import { createWorkspaceState } from './lib/workspaceState.js';
import { trapDialogFocus } from './lib/dialog.js';
import { routeExplainRequest } from './lib/reviewGuards.js';
import { formatRunKind, formatElapsedMmSs } from './lib/runStatus.js';
import { createRequestGuard } from './lib/requestGuard.js';

const api = window.autoReview;
const bus = new EventTarget();
const workspaceState = createWorkspaceState();

/** @type {{ folder: string | null, sourceMode: string, base: string | null, commits: string[] | null, changes: ReviewChangesResult | null, changesFp: string | null, selectedFile: any, selectedLine?: any, pendingAnalyzeFile?: any, selAnchor?: any }} */
const state = {
  folder: null,
  sourceMode: 'uncommitted',
  base: null,
  commits: null,
  changes: null,
  changesFp: null,
  selectedFile: null,
};
const changesGuard = createRequestGuard(() => state.folder);
const projectGuard = createRequestGuard(() => state.folder);
/** @type {ReturnType<typeof projectGuard.begin> | null} */
let projectLoadPending = null;
/** @type {{ project: ReturnType<typeof projectGuard.begin>, done: Promise<boolean> | null } | null} */
let projectLifecyclePending = null;
let watchRescanPending = false;
changesGuard.onBegin(() => setLoading(false));

/**
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {any} [children]
 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'onClick') node.addEventListener('click', value);
    else if (key === 'style') node.style.cssText = value;
    else if (key === 'dataset') {
      for (const [dk, dv] of Object.entries(value)) node.dataset[dk] = dv;
    } else node.setAttribute(key, value);
  }
  for (const child of (/** @type {any[]} */ ([])).concat(children)) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

const sidebarEl = /** @type {HTMLElement} */ (document.getElementById('sidebar'));
const sidebarToggleBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('btn-sidebar-toggle'));
const projectChipEl = /** @type {HTMLElement | null} */ (document.getElementById('project-chip'));
const projectNameEl = /** @type {HTMLElement | null} */ (document.getElementById('project-name'));
const projectPathEl = /** @type {HTMLElement} */ (document.getElementById('project-path'));
const selectBtn = /** @type {HTMLButtonElement} */ (document.getElementById('btn-select-folder'));
const rescanBtn = /** @type {HTMLButtonElement} */ (document.getElementById('btn-rescan'));
const themeBtn = /** @type {HTMLButtonElement} */ (document.getElementById('btn-theme'));

const SIDEBAR_STORAGE_KEY = 'rf.sidebarCollapsed';
const narrowMql = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 1100px)') : null;
let userSidebarPref = (() => {
  try {
    const v = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
})();
let narrowOverrideExpanded = false;

function isSidebarCollapsed() {
  if (narrowMql && narrowMql.matches) {
    return !narrowOverrideExpanded;
  }
  return userSidebarPref === true;
}

function syncSidebarUI() {
  const collapsed = isSidebarCollapsed();
  if (sidebarEl) {
    sidebarEl.classList.toggle('sidebar-collapsed', collapsed);
    sidebarEl.classList.toggle('sidebar-expanded-override', Boolean(narrowMql && narrowMql.matches && !collapsed));
  }
  if (sidebarToggleBtn) {
    sidebarToggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    const label = collapsed ? '展开侧边栏' : '收起侧边栏';
    sidebarToggleBtn.title = label;
    sidebarToggleBtn.setAttribute('aria-label', label);
  }
}

if (sidebarToggleBtn) {
  sidebarToggleBtn.addEventListener('click', () => {
    const nextCollapsed = !isSidebarCollapsed();
    if (narrowMql && narrowMql.matches) {
      narrowOverrideExpanded = !nextCollapsed;
    }
    userSidebarPref = nextCollapsed;
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, nextCollapsed ? '1' : '0');
    } catch { console.warn('保存侧边栏状态失败'); }
    syncSidebarUI();
  });
}
if (narrowMql && typeof narrowMql.addEventListener === 'function') {
  narrowMql.addEventListener('change', () => {
    narrowOverrideExpanded = false;
    syncSidebarUI();
  });
}
syncSidebarUI();

function updateProjectDisplay(folder) {
  if (!folder) {
    projectPathEl.textContent = '未选择项目';
    projectPathEl.title = '点击选择最近项目';
    if (projectNameEl) projectNameEl.textContent = '未选择项目';
    if (projectChipEl) projectChipEl.title = '点击选择最近项目';
    return;
  }
  const name = String(folder).split(/[\\/]/).filter(Boolean).pop() || String(folder);
  projectPathEl.textContent = folder;
  projectPathEl.title = folder;
  if (projectNameEl) projectNameEl.textContent = name;
  if (projectChipEl) projectChipEl.title = folder;
}

// ---------- 主题（浅色/深色/跟随系统） ----------
const THEME_META = {
  light: { label: '浅色', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>' },
  dark: { label: '深色', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>' },
  auto: { label: '跟随系统', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/></svg>' },
};

const themeManager = createThemeManager({
  onChange: (mode, resolved) => {
    if (typeof api.setWindowTheme === 'function') {
      try { api.setWindowTheme(resolved); } catch { console.warn('同步窗口主题失败'); }
    }
    const meta = THEME_META[mode];
    themeBtn.innerHTML = meta.icon;
    const titleText = `主题：${meta.label}${mode === 'auto' ? `（当前${resolved === 'dark' ? '深色' : '浅色'}）` : ''}，点击切换`;
    themeBtn.title = titleText;
    themeBtn.setAttribute('aria-label', titleText);
  },
});

themeBtn.addEventListener('click', () => {
  themeManager.cycle();
  toast(`主题：${THEME_META[themeManager.mode].label}`, 'success');
});

// ---------- 全局运行状态指示器：有 AI 运行时在侧边栏显示进度，点击打开运行详情 ----------
const runIndicator = /** @type {HTMLElement} */ (document.getElementById('run-indicator'));
/** @type {Map<string, { startedAt: number, pausedAt: number }>} */
const runIndicatorMeta = new Map();
/** @type {ReturnType<typeof setInterval> | null} */
let runIndicatorTimer = null;
/** @type {any[]} */
let latestIndicatorRuns = [];

function computeIndicatorElapsed(run) {
  const runId = String((run && run.runId) || '');
  const meta = runId ? runIndicatorMeta.get(runId) : null;
  if (!meta) return 0;
  const end = run && run.paused ? meta.pausedAt : Date.now();
  return Math.max(0, end - meta.startedAt);
}

function renderRunIndicatorContent(runs) {
  if (!Array.isArray(runs) || !runs.length) {
    runIndicator.style.display = 'none';
    return;
  }
  const first = runs[0];
  const kindLabel = formatRunKind(first && first.kind);
  let label;
  if (runs.length > 1) {
    label = `${runs.length} 个任务运行中`;
  } else if (first && first.paused) {
    label = `已暂停 · 已用 ${formatElapsedMmSs(computeIndicatorElapsed(first))}`;
  } else {
    label = `${kindLabel}${first && first.batch ? ` ${first.batch}` : ''}`;
  }
  runIndicator.style.display = '';
  runIndicator.textContent = '';
  const spinner = el('span', { class: 'spinner' });
  if (first && first.paused) {
    spinner.style.animationPlayState = 'paused';
  }
  runIndicator.appendChild(spinner);
  runIndicator.appendChild(el('span', { class: 'run-indicator-text' }, label));
  runIndicator.title = first && first.paused ? '已暂停，点击查看运行详情' : '运行中，点击查看运行详情';
}

function refreshRunIndicator(runs) {
  const list = Array.isArray(runs) ? runs : [];
  latestIndicatorRuns = list;
  const activeIds = new Set();
  const now = Date.now();
  for (const r of list) {
    if (!r) continue;
    const id = String(r.runId || '');
    if (!id) continue;
    activeIds.add(id);
    const prev = runIndicatorMeta.get(id);
    if (!prev) {
      const startedAt = typeof r.startedAt === 'number' && r.startedAt > 0 && !r.paused ? r.startedAt : now;
      runIndicatorMeta.set(id, {
        startedAt,
        pausedAt: r.paused ? now : 0,
      });
    } else if (r.paused && !prev.pausedAt) {
      prev.pausedAt = typeof r.startedAt === 'number' && r.startedAt >= prev.startedAt ? r.startedAt : now;
    } else if (!r.paused && prev.pausedAt) {
      prev.startedAt += Math.max(0, now - prev.pausedAt);
      prev.pausedAt = 0;
    }
  }
  for (const id of runIndicatorMeta.keys()) {
    if (!activeIds.has(id)) runIndicatorMeta.delete(id);
  }
  if (!list.length && runIndicatorTimer) {
    clearInterval(runIndicatorTimer);
    runIndicatorTimer = null;
  } else if (list.some((r) => r && !r.paused) && !runIndicatorTimer) {
    runIndicatorTimer = setInterval(() => {
      if (latestIndicatorRuns.length && !latestIndicatorRuns[0]?.paused) {
        renderRunIndicatorContent(latestIndicatorRuns);
      }
    }, 1000);
  } else if (list.every((r) => r && r.paused) && runIndicatorTimer) {
    clearInterval(runIndicatorTimer);
    runIndicatorTimer = null;
  }
  bus.dispatchEvent(new CustomEvent('runs:changed', { detail: runs }));
  renderRunIndicatorContent(list);
}
runIndicator.addEventListener('click', () => ctx.showRunDetails());
let runsPushed = false;
api.onRunsChanged((runs) => {
  runsPushed = true;
  refreshRunIndicator(runs);
});
api.listRuns().then((runs) => {
  // 初始查询不能覆盖查询期间已到达的推送。
  if (!runsPushed) refreshRunIndicator(runs);
}).catch((err) => toast('获取运行状态失败：' + errText(err), 'error'));

function setLoading(loading) {
  selectBtn.disabled = loading;
  rescanBtn.disabled = loading || !state.folder;
}

// 改动内容的轻量指纹：fs.watch 误报（xattr、编辑器临时文件等）时不触发刷新
function changesFingerprint(changes) {
  if (!changes || !Array.isArray(changes.files)) return '';
  let h = 0;
  const mix = (s) => {
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  };
  for (const f of changes.files) {
    mix(f.path);
    mix(f.status);
    for (const hk of f.hunks) {
      mix(hk.header);
      for (const l of hk.lines) mix(l.type[0] + l.content);
    }
  }
  return String(h);
}

async function loadChanges(folder, { force = false, request = changesGuard.begin() } = {}) {
  const mode = state.commits
    ? 'commits'
    : state.base
      ? (state.sourceMode === 'ref' ? 'ref' : 'branch')
      : (state.sourceMode || 'uncommitted');
  /** @type {ReviewChangesOptions} */
  const options = mode === 'commits'
    ? { mode: /** @type {ReviewMode} */ (mode), commits: state.commits }
    : mode === 'branch' || mode === 'ref'
      ? { mode: /** @type {ReviewMode} */ (mode), base: state.base }
      : { mode: /** @type {ReviewMode} */ (mode), base: null };
  let result;
  try {
    result = await api.getChanges(folder, options);
  } catch (error) {
    if (!request.isCurrent()) return false;
    throw error;
  }
  if (!request.isCurrent()) return false;
  const fp = changesFingerprint(result);
  if (!force && state.changes && fp === state.changesFp) return false;
  state.sourceMode = String((result && result.source && result.source.mode) || mode);
  state.changesFp = fp;
  state.changes = result;
  bus.dispatchEvent(new CustomEvent('changes:loaded', { detail: result }));
  await completeProjectLifecycle();
  return true;
}

// 右下角浮层提示，多条垂直堆叠；error 停留更久；type: success / error / info
const TOAST_ICONS = {
  success: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
  error: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  info: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};
/** @type {HTMLElement | null} */
let toastStackEl = null;
function toast(msg, type = 'info') {
  if (!toastStackEl) {
    toastStackEl = el('div', {
      class: 'toast-stack',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'false',
    });
    document.body.appendChild(toastStackEl);
  }
  const node = el('div', {
    class: `toast toast-${type}`,
    role: type === 'error' ? 'alert' : 'status',
  });
  node.innerHTML = TOAST_ICONS[type] || TOAST_ICONS.info;
  node.appendChild(document.createTextNode(String(msg)));
  toastStackEl.appendChild(node);
  setTimeout(() => {
    node.classList.add('toast-out');
    setTimeout(() => node.remove(), 300);
  }, type === 'error' ? 4000 : 2500);
}

const EMPTY_STATE_ICON =
  '<svg class="empty-state-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M22 12h-6l-2 3h-4l-2-3H2"/>' +
  '<path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89' +
  'A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>';
function emptyState(title, sub, action) {
  const node = el('div', { class: 'empty-state' });
  node.innerHTML = EMPTY_STATE_ICON;
  node.appendChild(el('div', { class: 'empty-state-title' }, title));
  if (sub) node.appendChild(el('div', { class: 'empty-state-sub' }, sub));
  if (action && action.label && typeof action.onClick === 'function') {
    node.appendChild(el('button', {
      class: 'btn btn-primary', type: 'button', onClick: action.onClick,
    }, action.label));
  }
  return node;
}

function completeProjectLifecycle() {
  const pending = projectLifecyclePending;
  if (!pending || !pending.project.isCurrent() || !state.changes) return Promise.resolve(false);
  const project = pending.project;
  const folder = project.folder;
  if (!folder) return Promise.resolve(false);
  // 首次有效快照认领初始化，后续扫描复用同一任务。
  if (!pending.done) pending.done = (async () => {
    workspaceState.touchProject(folder);
    try { await api.stopWatch(); } catch { if (project.isCurrent()) console.warn('停止文件监听失败'); }
    if (!project.isCurrent()) return false;
    try { await api.startWatch(folder); } catch { if (project.isCurrent()) toast('启动文件监听失败，请手动重新扫描', 'error'); }
    if (!project.isCurrent()) return false;
    try { await api.addRecentProject(folder); } catch { if (project.isCurrent()) console.warn('保存最近项目失败'); }
    return project.isCurrent();
  })();
  return pending.done;
}

bus.addEventListener('changes:loaded', () => {
  const project = projectGuard.capture();
  completeProjectLifecycle().catch((err) => {
    if (project.isCurrent()) toast('初始化项目失败：' + errText(err), 'error');
  });
});

async function loadProject(folder, { silent = false } = {}) {
  state.folder = folder;
  const project = projectGuard.begin();
  projectLoadPending = project;
  projectLifecyclePending = { project, done: null };
  watchRescanPending = false;
  changesGuard.clearSource();
  const request = changesGuard.begin();
  try {
    const ws = workspaceState.getProject(folder);
    const savedSource = ws.source || { mode: 'uncommitted', base: null, commits: null };
    const hasCustomSource = Boolean(
      (savedSource.mode && savedSource.mode !== 'uncommitted')
      || savedSource.base
      || (Array.isArray(savedSource.commits) && savedSource.commits.length),
    );
    state.folder = folder;
    state.sourceMode = savedSource.mode || 'uncommitted';
    state.base = savedSource.base || null;
    state.commits = savedSource.commits || null;
    state.changes = null;
    state.changesFp = null;
    state.selectedFile = null;
    state.selectedLine = null;
    state.pendingAnalyzeFile = null;
    state.selAnchor = null;
    bus.dispatchEvent(new CustomEvent('project:changed', { detail: { folder } }));
    updateProjectDisplay(folder);
    setLoading(true);
    try {
      await loadChanges(folder, { force: true, request });
    } catch (sourceErr) {
      if (!project.isCurrent()) return false;
      if (request.isCurrent()) {
        if (!hasCustomSource) throw sourceErr;
        state.sourceMode = 'uncommitted';
        state.base = null;
        state.commits = null;
        await loadChanges(folder, { force: true, request });
        if (request.isCurrent()) {
          workspaceState.updateProject(folder, {
            source: { mode: 'uncommitted', base: null, commits: null },
          });
          toast('上次的对比来源已失效，已回到未提交改动', 'info');
        }
      }
    }
    if (!project.isCurrent()) return false;
    return await completeProjectLifecycle();
  } catch (err) {
    if (!request.isCurrent()) return false;
    if (silent) {
      setLoading(false);
      state.folder = null;
      updateProjectDisplay(null);
      return false;
    }
    toast('加载改动失败：' + errText(err), 'error');
    return false;
  } finally {
    if (projectLoadPending === project) {
      projectLoadPending = null;
      if (watchRescanPending) {
        watchRescanPending = false;
        scheduleWatchRescan();
      }
    }
    if (request.isCurrent()) setLoading(false);
  }
}

async function selectFolder() {
  try {
    const folder = await api.selectProjectFolder();
    if (!folder) return;
    await loadProject(folder);
  } catch (err) {
    toast('加载改动失败：' + errText(err), 'error');
  }
}

async function rescan() {
  if (!state.folder) {
    toast('请先选择项目文件夹', 'error');
    return;
  }
  const project = projectGuard.capture();
  await changesGuard.waitForSource();
  if (!project.isCurrent()) return;
  const request = changesGuard.begin();
  try {
    setLoading(true);
    await loadChanges(state.folder, { force: true, request });
  } catch (err) {
    if (request.isCurrent()) toast('重新扫描失败：' + errText(err), 'error');
  } finally {
    if (request.isCurrent()) setLoading(false);
  }
}

// Electron IPC 异常会带 "Error invoking remote method '...': Error: " 前缀，剥掉再展示
function errText(err) {
  return String(err && err.message ? err.message : err)
    .replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

// macOS 系统通知（Electron 渲染进程原生支持 HTML5 Notification）
function notify(title, body) {
  try {
    new Notification(title, { body: body || '' });
  } catch { console.warn('系统通知不可用'); }
}

// 最近项目下拉：点击 header 路径展开，点击其他位置关闭
/** @type {HTMLElement | null} */
let recentDropdown = null;
/** @type {HTMLElement | null} */
let recentOpenerEl = null;
let recentActiveIdx = 0;

function closeRecentDropdown({ restoreFocus = false } = {}) {
  if (recentDropdown) {
    recentDropdown.remove();
    recentDropdown = null;
  }
  if (projectChipEl) {
    projectChipEl.setAttribute('aria-expanded', 'false');
  }
  const prev = recentOpenerEl;
  recentOpenerEl = null;
  if (restoreFocus && prev && document.contains(prev) && typeof prev.focus === 'function') {
    prev.focus();
  }
}

function paintRecentActive() {
  if (!recentDropdown) return;
  const items = /** @type {HTMLElement[]} */ ([...recentDropdown.querySelectorAll('.recent-item')]);
  items.forEach((node, idx) => {
    const active = idx === recentActiveIdx;
    node.classList.toggle('active', active);
    node.setAttribute('aria-selected', active ? 'true' : 'false');
    node.tabIndex = active ? 0 : -1;
    if (active) node.focus();
  });
}

async function toggleRecentDropdown() {
  if (recentDropdown) {
    closeRecentDropdown({ restoreFocus: true });
    return;
  }
  let recents = [];
  try {
    recents = await api.getRecentProjects();
  } catch { toast('读取最近项目失败', 'error'); return; }
  if (!recents || !recents.length) {
    toast('暂无最近项目');
    return;
  }
  recentOpenerEl = projectChipEl || projectPathEl;
  const anchorEl = projectChipEl || projectPathEl;
  const rect = anchorEl.getBoundingClientRect();
  recentDropdown = el('div', {
    class: 'recent-dropdown',
    role: 'listbox',
    'aria-label': '最近项目',
    style: `top:${Math.max(8, Math.min(window.innerHeight - 240, rect.bottom + 6))}px; left:${Math.max(8, rect.left)}px;`,
  });
  recentActiveIdx = Math.max(0, recents.findIndex((p) => p === state.folder));
  recents.forEach((path, idx) => {
    const item = el('div', {
      class: `recent-item${idx === recentActiveIdx ? ' active' : ''}`,
      role: 'option',
      tabindex: idx === recentActiveIdx ? '0' : '-1',
      'aria-selected': idx === recentActiveIdx ? 'true' : 'false',
      text: path,
      title: path,
      onClick: () => {
        closeRecentDropdown();
        if (path !== state.folder) loadProject(path);
      },
    });
    item.addEventListener('mousemove', () => {
      if (recentActiveIdx !== idx) {
        recentActiveIdx = idx;
        paintRecentActive();
      }
    });
    recentDropdown?.appendChild(item);
  });
  recentDropdown.addEventListener('keydown', (ev) => {
    const items = recentDropdown ? [...recentDropdown.querySelectorAll('.recent-item')] : [];
    if (!items.length) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const step = ev.key === 'ArrowDown' ? 1 : -1;
      recentActiveIdx = (recentActiveIdx + step + items.length) % items.length;
      paintRecentActive();
    } else if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      const path = recents[recentActiveIdx];
      closeRecentDropdown({ restoreFocus: true });
      if (path && path !== state.folder) loadProject(path);
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      closeRecentDropdown({ restoreFocus: true });
    }
  });
  if (projectChipEl) {
    projectChipEl.setAttribute('aria-expanded', 'true');
  }
  document.body.appendChild(recentDropdown);
  paintRecentActive();
}

const recentTriggerEl = projectChipEl || projectPathEl;
recentTriggerEl.addEventListener('click', toggleRecentDropdown);
recentTriggerEl.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'ArrowDown') {
    ev.preventDefault();
    toggleRecentDropdown();
  }
});
document.addEventListener('click', (ev) => {
  if (!recentDropdown) return;
  const target = /** @type {Node | null} */ (ev.target);
  if (recentDropdown.contains(target) || recentTriggerEl.contains(target)) return;
  closeRecentDropdown();
});

// 文件监听：变化防抖 2s 后自动重新扫描
/** @type {ReturnType<typeof setTimeout> | null} */
let watchTimer = null;
function scheduleWatchRescan() {
  if (watchTimer) clearTimeout(watchTimer);
  const project = projectGuard.capture();
  watchTimer = setTimeout(async () => {
    watchTimer = null;
    if (!state.folder || !project.isCurrent()) return;
    if (projectLoadPending) { watchRescanPending = true; return; }
    await changesGuard.waitForSource();
    if (!project.isCurrent()) return;
    const request = changesGuard.begin();
    try {
      const updated = await loadChanges(state.folder, { request });
      if (request.isCurrent() && updated) toast('检测到文件变化，已自动重新扫描');
    } catch { if (request.isCurrent()) console.warn('自动重新扫描失败'); }
  }, 2000);
}
if (typeof api.onFsChanged === 'function') {
  api.onFsChanged(() => {
    // IPC 不带项目目录，切换期间合并事件，监听就绪后补扫。
    if (projectLoadPending) { watchRescanPending = true; return; }
    scheduleWatchRescan();
  });
}

const ctx = { api, state, bus, selectFolder, el, errText, notify, toast, changesFingerprint, changesGuard, emptyState, workspaceState };
ctx.showRunDetails = createRunDetails(ctx);

const tabs = [overviewTab, reviewTab, explainTab, fullExplainTab, settingsTab, planTab];
const tabBar = /** @type {HTMLElement} */ (document.getElementById('tab-bar'));
const tabContent = /** @type {HTMLElement} */ (document.getElementById('tab-content'));
const mounted = new Map();
let activeId = null;

const svgWrap = (inner) =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const TAB_ICONS = {
  overview: svgWrap('<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'),
  review: svgWrap('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  explain: svgWrap('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  fullExplain: svgWrap('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'),
  settings: svgWrap('<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>'),
  plan: svgWrap('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
};

tabBar.setAttribute('role', 'tablist');
tabBar.setAttribute('aria-orientation', 'vertical');

function activateTab(id, { persist = true, focusTab = false } = {}) {
  if (id === activeId) return;
  activeId = id;
  if (persist) {
    workspaceState.setLastActiveTab(id);
  }
  for (const btn of tabBar.children) {
    const tabBtn = /** @type {HTMLElement} */ (btn);
    const isActive = tabBtn.dataset.tabId === id;
    tabBtn.classList.toggle('active', isActive);
    tabBtn.setAttribute('aria-selected', isActive ? 'true' : 'false');
    tabBtn.tabIndex = isActive ? 0 : -1;
    if (isActive && focusTab) tabBtn.focus();
  }
  for (const [tabId, panel] of mounted) {
    panel.hidden = tabId !== id;
  }
  if (!mounted.has(id)) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    const panel = el('div', {
      id: `panel-${id}`,
      class: 'tab-panel',
      role: 'tabpanel',
      'aria-labelledby': `tab-btn-${id}`,
      dataset: { tabId: id },
    });
    tabContent.append(panel);
    tab.mount(panel, ctx);
    mounted.set(id, panel);
  }
  const panel = mounted.get(id);
  panel.classList.remove('panel-enter');
  void panel.offsetWidth;
  panel.classList.add('panel-enter');
}

for (const tab of tabs) {
  const btn = el('button', {
    id: `tab-btn-${tab.id}`,
    class: 'tab-btn',
    type: 'button',
    role: 'tab',
    'aria-selected': 'false',
    'aria-controls': `panel-${tab.id}`,
    'aria-label': tab.title,
    tabindex: '-1',
    dataset: { tabId: tab.id },
    title: `${tab.title}（⌘${tabs.indexOf(tab) + 1}）`,
    onClick: () => activateTab(tab.id),
  });
  btn.innerHTML = `${TAB_ICONS[tab.id] || ''}<span>${tab.title}</span>`;
  tabBar.append(btn);
}

tabBar.addEventListener('keydown', (ev) => {
  const keys = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'];
  if (!keys.includes(ev.key)) return;
  ev.preventDefault();
  const idx = tabs.findIndex((t) => t.id === activeId);
  const cur = idx >= 0 ? idx : 0;
  let next = cur;
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') {
    next = (cur + 1) % tabs.length;
  } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') {
    next = (cur - 1 + tabs.length) % tabs.length;
  } else if (ev.key === 'Home') {
    next = 0;
  } else if (ev.key === 'End') {
    next = tabs.length - 1;
  }
  activateTab(tabs[next].id, { focusTab: true });
});

// 「改动总览」文件项的 AI 按钮：切到 Review tab 后通知其消费 pendingAnalyzeFile
bus.addEventListener('file:analyze', () => {
  activateTab('review');
  bus.dispatchEvent(new CustomEvent('file:analyze:ready'));
});

bus.addEventListener('explain:request', (event) => {
  routeExplainRequest(state, () => activateTab('explain'),
    (detail) => bus.dispatchEvent(new CustomEvent('line:select', { detail })),
    /** @type {CustomEvent} */ (event).detail);
});

bus.addEventListener('diff:jump', (ev) => {
  activateTab('overview');
  bus.dispatchEvent(new CustomEvent('diff:jump:ready', { detail: /** @type {CustomEvent} */ (ev).detail }));
});

bus.addEventListener('changes:rescan', () => {
  rescan();
});

// .md 容器内的代码块：点击复制全部代码，不影响其他点击行为
document.addEventListener('click', (ev) => {
  const target = /** @type {Element | null} */ (ev.target);
  const pre = target && typeof target.closest === 'function'
    ? target.closest('.md pre')
    : null;
  if (!pre) return;
  navigator.clipboard.writeText(pre.textContent)
    .then(() => toast('已复制代码块'))
    .catch(() => toast('复制失败，请重试', 'error'));
});

// 快捷键：⌘1~6 切 tab，⌘R 重新扫描，⌘K 命令面板
document.addEventListener('keydown', (ev) => {
  if (ev.metaKey && ev.shiftKey && !ev.altKey && !ev.ctrlKey && ev.key.toLowerCase() === 'e') {
    ev.preventDefault();
    activateTab('review');
    bus.dispatchEvent(new CustomEvent('review:command', { detail: { action: 'export' } }));
    return;
  }
  if (!ev.metaKey && !ev.ctrlKey && !ev.altKey && !ev.shiftKey && activeId === 'overview') {
    if (!document.querySelector('.modal-overlay, .palette-overlay')) {
      const t = /** @type {HTMLElement | null} */ (ev.target);
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      if (!typing) {
        if (ev.key === ']') {
          ev.preventDefault();
          bus.dispatchEvent(new CustomEvent('overview:command', { detail: { action: 'nextHunk' } }));
          return;
        }
        if (ev.key === '[') {
          ev.preventDefault();
          bus.dispatchEvent(new CustomEvent('overview:command', { detail: { action: 'prevHunk' } }));
          return;
        }
        if (ev.key === 'n') {
          ev.preventDefault();
          bus.dispatchEvent(new CustomEvent('overview:command', { detail: { action: 'nextUnread' } }));
          return;
        }
      }
    }
  }
  if (!ev.metaKey || ev.shiftKey || ev.altKey || ev.ctrlKey) return;
  if (ev.key >= '1' && ev.key <= String(tabs.length)) {
    ev.preventDefault();
    activateTab(tabs[Number(ev.key) - 1].id);
  } else if (ev.key === 'r') {
    ev.preventDefault();
    rescan();
  } else if (ev.key === 'k') {
    ev.preventDefault();
    palette.toggle();
  }
});

// 快捷键说明弹窗：按 ? 打开，点遮罩 / Esc 关闭
/** @type {HTMLElement | null} */
let shortcutOverlay = null;
/** @type {HTMLElement | null} */
let shortcutOpenerEl = null;
function closeShortcuts() {
  if (shortcutOverlay) {
    shortcutOverlay.remove();
    shortcutOverlay = null;
  }
  const prev = shortcutOpenerEl;
  shortcutOpenerEl = null;
  if (prev && document.contains(prev) && typeof prev.focus === 'function') {
    prev.focus();
  }
}
function showShortcuts() {
  if (shortcutOverlay) {
    closeShortcuts();
    return;
  }
  shortcutOpenerEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  shortcutOverlay = el('div', { class: 'modal-overlay' });
  const titleId = 'shortcut-modal-title';
  const panel = el('div', {
    class: 'commit-modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': titleId,
    tabindex: '-1',
  });
  const head = el('div', { class: 'commit-modal-title', id: titleId, style: 'display:flex;align-items:center;justify-content:space-between;' });
  head.appendChild(el('span', {}, '快捷键说明'));
  const closeBtn = el('button', { class: 'btn', type: 'button', onClick: closeShortcuts }, '关闭');
  head.appendChild(closeBtn);
  panel.appendChild(head);
  const list = el('div', { class: 'shortcut-list' });
  for (const [key, desc] of [
    [`⌘1 ~ ⌘${tabs.length}`, '切换 Tab'],
    ['⌘K', '命令面板'],
    ['⌘R', '重新扫描改动'],
    ['⌘Enter', '开始 / 停止 AI 分析（多角度 Review）'],
    ['⌘⇧E', '导出当前评审（Markdown）'],
    ['⌘F', '搜索改动（改动总览）'],
    ['⌘E / Esc', '解析当前选区 / 清除选区（改动总览）'],
    ['j / k', '上/下切换文件（改动总览）'],
    ['[ / ]', '上/下一个改动块（改动总览）'],
    ['n', '下一个未读文件（改动总览）'],
    ['点击改动行', '选中该改动行（待解析）'],
    ['拖动行号 / ⌥+点击', '框选多行改动（待解析）'],
    ['拖动代码文本', '原生选中文本（⌘C 复制）'],
    ['点击类名', '按类选择改动（待解析）'],
    ['点击行号', '复制该行内容'],
    ['?', '打开本说明'],
  ]) {
    const rowEl = el('div', { class: 'shortcut-row' });
    rowEl.appendChild(el('span', { class: 'shortcut-key' }, key));
    rowEl.appendChild(el('span', {}, desc));
    list.appendChild(rowEl);
  }
  panel.appendChild(list);
  shortcutOverlay.appendChild(panel);
  shortcutOverlay.addEventListener('click', (ev) => {
    if (ev.target === shortcutOverlay) closeShortcuts();
  });
  document.body.appendChild(shortcutOverlay);
  closeBtn.focus();
}
document.addEventListener('keydown', (ev) => {
  if (shortcutOverlay) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closeShortcuts();
      return;
    }
    const panel = /** @type {HTMLElement | null} */ (shortcutOverlay.querySelector('.commit-modal'));
    if (panel) trapDialogFocus(panel, ev);
    return;
  }
  if (ev.key !== '?' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const t = /** @type {HTMLElement | null} */ (ev.target);
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' || t.isContentEditable)) return;
  ev.preventDefault();
  showShortcuts();
});

// ⌘K 命令面板：页面 / 动作 / 最近项目（Raycast/Linear 式快速导航）
const palette = createCommandPalette({
  el,
  getItems: async () => {
    const items = [];
    tabs.forEach((tab, i) => {
      items.push({
        group: '页面', label: tab.title, iconHtml: TAB_ICONS[tab.id], hint: `⌘${i + 1}`,
        run: () => activateTab(tab.id),
      });
    });
    const ACTION_ICONS = {
      rescan: svgWrap('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
      runs: svgWrap('<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>'),
      folder: svgWrap('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
      shortcuts: svgWrap('<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/>'),
      recent: svgWrap('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
      play: svgWrap('<polygon points="5 3 19 12 5 21 5 3"/>'),
      stop: svgWrap('<rect x="6" y="6" width="12" height="12" rx="1"/>'),
      export: svgWrap('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>'),
      history: svgWrap('<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><polyline points="12 7 12 12 15 15"/>'),
      finding: svgWrap('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'),
      source: svgWrap('<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'),
      hunk: svgWrap('<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>'),
    };
    items.push(
      {
        group: '动作', label: '开始 AI 分析', hint: '⌘Enter', iconHtml: ACTION_ICONS.play,
        run: () => {
          activateTab('review');
          bus.dispatchEvent(new CustomEvent('review:command', { detail: { action: 'start' } }));
        },
      },
      {
        group: '动作', label: '停止当前分析', hint: '⌘Enter', iconHtml: ACTION_ICONS.stop,
        run: () => {
          bus.dispatchEvent(new CustomEvent('review:command', { detail: { action: 'stop' } }));
        },
      },
      {
        group: '动作', label: '导出当前评审', hint: '⌘⇧E', iconHtml: ACTION_ICONS.export,
        run: () => {
          activateTab('review');
          bus.dispatchEvent(new CustomEvent('review:command', { detail: { action: 'export' } }));
        },
      },
      {
        group: '动作', label: '打开评审历史', iconHtml: ACTION_ICONS.history,
        run: () => {
          activateTab('review');
          bus.dispatchEvent(new CustomEvent('review:command', { detail: { action: 'history' } }));
        },
      },
      {
        group: '动作', label: '下一个未关闭问题', iconHtml: ACTION_ICONS.finding,
        run: () => {
          activateTab('review');
          bus.dispatchEvent(new CustomEvent('review:command', { detail: { action: 'nextFinding' } }));
        },
      },
      {
        group: '动作', label: '上一个未关闭问题', iconHtml: ACTION_ICONS.finding,
        run: () => {
          activateTab('review');
          bus.dispatchEvent(new CustomEvent('review:command', { detail: { action: 'prevFinding' } }));
        },
      },
      {
        group: '动作', label: '下一个改动块', hint: ']', iconHtml: ACTION_ICONS.hunk,
        run: () => {
          activateTab('overview');
          bus.dispatchEvent(new CustomEvent('overview:command', { detail: { action: 'nextHunk' } }));
        },
      },
      {
        group: '动作', label: '上一个改动块', hint: '[', iconHtml: ACTION_ICONS.hunk,
        run: () => {
          activateTab('overview');
          bus.dispatchEvent(new CustomEvent('overview:command', { detail: { action: 'prevHunk' } }));
        },
      },
      {
        group: '动作', label: '下一个未读文件', hint: 'n', iconHtml: ACTION_ICONS.hunk,
        run: () => {
          activateTab('overview');
          bus.dispatchEvent(new CustomEvent('overview:command', { detail: { action: 'nextUnread' } }));
        },
      },
      { group: '动作', label: '重新扫描改动', hint: '⌘R', iconHtml: ACTION_ICONS.rescan, run: () => rescan() },
      { group: '动作', label: '运行详情', iconHtml: ACTION_ICONS.runs, run: () => ctx.showRunDetails() },
      { group: '动作', label: '选择项目文件夹…', iconHtml: ACTION_ICONS.folder, run: () => selectFolder() },
      {
        group: '动作', label: `切换主题（当前：${THEME_META[themeManager.mode].label}）`,
        iconHtml: THEME_META[themeManager.mode].icon,
        run: () => themeBtn.click(),
      },
      { group: '动作', label: '快捷键说明', hint: '?', iconHtml: ACTION_ICONS.shortcuts, run: () => showShortcuts() },
      {
        group: '对比来源', label: '切换对比来源：未提交改动', iconHtml: ACTION_ICONS.source,
        run: () => {
          activateTab('overview');
          bus.dispatchEvent(new CustomEvent('overview:command', { detail: { action: 'setSource', mode: 'uncommitted' } }));
        },
      },
      {
        group: '对比来源', label: '切换对比来源：已暂存', iconHtml: ACTION_ICONS.source,
        run: () => {
          activateTab('overview');
          bus.dispatchEvent(new CustomEvent('overview:command', { detail: { action: 'setSource', mode: 'staged' } }));
        },
      },
      {
        group: '对比来源', label: '切换对比来源：未暂存', iconHtml: ACTION_ICONS.source,
        run: () => {
          activateTab('overview');
          bus.dispatchEvent(new CustomEvent('overview:command', { detail: { action: 'setSource', mode: 'unstaged' } }));
        },
      },
      {
        group: '对比来源', label: '切换对比来源：仅未跟踪', iconHtml: ACTION_ICONS.source,
        run: () => {
          activateTab('overview');
          bus.dispatchEvent(new CustomEvent('overview:command', { detail: { action: 'setSource', mode: 'untracked' } }));
        },
      },
    );
    try {
      const recents = await api.getRecentProjects();
      for (const p of (Array.isArray(recents) ? recents : []).slice(0, 8)) {
        items.push({
          group: '最近项目',
          label: String(p).split('/').filter(Boolean).pop() || String(p),
          path: String(p),
          iconHtml: ACTION_ICONS.recent,
          run: () => { if (p !== state.folder) loadProject(p); },
        });
      }
    } catch { console.warn('读取命令面板最近项目失败'); }
    const changedFiles = state.changes && Array.isArray(state.changes.files) ? state.changes.files : [];
    const fileIcon = svgWrap('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>');
    for (const f of changedFiles) {
      items.push({
        group: '文件',
        label: String(f.path).split('/').pop() || String(f.path),
        path: String(f.path),
        iconHtml: fileIcon,
        run: () => {
          activateTab('overview');
          bus.dispatchEvent(new CustomEvent('file:jump', { detail: f.path }));
        },
      });
    }
    return items;
  },
});

selectBtn.addEventListener('click', selectFolder);
rescanBtn.addEventListener('click', rescan);
rescanBtn.disabled = true;

const initialTabId = (() => {
  const saved = workspaceState.getLastActiveTab();
  return saved && tabs.some((t) => t.id === saved) ? saved : tabs[0].id;
})();
activateTab(tabs[0].id, { persist: false });
if (initialTabId !== tabs[0].id) {
  activateTab(initialTabId, { persist: false });
}

window.addEventListener('beforeunload', () => {
  workspaceState.flush();
});

// 命令行带路径启动时直接加载，如 `npm start -- /path/to/project`；
// 否则按最近项目顺序自动恢复（失效条目静默跳过，试到第一个可用为止）
if (typeof api.getInitialFolder === 'function') {
  api.getInitialFolder().then(async (folder) => {
    if (folder) {
      loadProject(folder);
      return;
    }
    try {
      const recents = await api.getRecentProjects();
      for (const p of (Array.isArray(recents) ? recents : [])) {
        if (await loadProject(p, { silent: true })) break;
      }
    } catch { console.warn('恢复最近项目失败'); }
  });
}

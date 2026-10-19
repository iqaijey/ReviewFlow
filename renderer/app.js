import overviewTab from './tabs/overview.js';
import reviewTab from './tabs/review.js';
import explainTab from './tabs/explain.js';
import fullExplainTab from './tabs/fullExplain.js';
import settingsTab from './tabs/settings.js';
import planTab from './tabs/plan.js';
import { createRunDetails } from './runDetails.js';
import { createCommandPalette } from './lib/commandPalette.js';
import { createThemeManager } from './lib/theme.js';

const api = window.autoReview;
const bus = new EventTarget();

/** @type {{ folder: string | null, base: string | null, changes: any, changesFp: string | null, selectedFile: any, selectedLine?: any }} */
const state = {
  folder: null,
  base: null,
  changes: null,
  changesFp: null,
  selectedFile: null,
};

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

const projectPathEl = /** @type {HTMLElement} */ (document.getElementById('project-path'));
const selectBtn = /** @type {HTMLButtonElement} */ (document.getElementById('btn-select-folder'));
const rescanBtn = /** @type {HTMLButtonElement} */ (document.getElementById('btn-rescan'));
const themeBtn = /** @type {HTMLButtonElement} */ (document.getElementById('btn-theme'));

// ---------- 主题（浅色/深色/跟随系统） ----------
const THEME_META = {
  light: { label: '浅色', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>' },
  dark: { label: '深色', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>' },
  auto: { label: '跟随系统', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/></svg>' },
};

const themeManager = createThemeManager({
  onChange: (mode, resolved) => {
    // 同步窗口底色，避免深色模式下启动/刷新闪白
    if (typeof api.setWindowTheme === 'function') {
      try { api.setWindowTheme(resolved); } catch { /* 忽略 */ }
    }
    const meta = THEME_META[mode];
    themeBtn.innerHTML = meta.icon;
    themeBtn.title = `主题：${meta.label}${mode === 'auto' ? `（当前${resolved === 'dark' ? '深色' : '浅色'}）` : ''}，点击切换`;
  },
});

themeBtn.addEventListener('click', () => {
  themeManager.cycle();
  toast(`主题：${THEME_META[themeManager.mode].label}`, 'success');
});

// ---------- 全局运行状态指示器：有 AI 运行时在侧边栏显示进度，点击打开运行详情 ----------
const runIndicator = /** @type {HTMLElement} */ (document.getElementById('run-indicator'));
async function refreshRunIndicator() {
  let runs = [];
  try {
    if (typeof api.listRuns === 'function') runs = await api.listRuns();
  } catch {
    runs = [];
  }
  if (!Array.isArray(runs) || !runs.length) {
    runIndicator.style.display = 'none';
    return;
  }
  const first = runs[0];
  const label = runs.length > 1
    ? `${runs.length} 个任务运行中`
    : `${first.kind || 'AI 调用'}${first.batch ? ` ${first.batch}` : ''}`;
  runIndicator.style.display = '';
  runIndicator.textContent = '';
  const spinner = el('span', { class: 'spinner' });
  runIndicator.appendChild(spinner);
  runIndicator.appendChild(el('span', { class: 'run-indicator-text' }, label));
  runIndicator.title = first.paused ? '已暂停，点击查看运行详情' : '运行中，点击查看运行详情';
}
runIndicator.addEventListener('click', () => ctx.showRunDetails());
setInterval(refreshRunIndicator, 1000);
refreshRunIndicator();

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

async function loadChanges(folder, { force = false } = {}) {
  const result = await api.getChanges(folder, { base: state.base || null });
  const fp = changesFingerprint(result);
  if (!force && state.changes && fp === state.changesFp) return false;
  state.changesFp = fp;
  state.changes = result;
  bus.dispatchEvent(new CustomEvent('changes:loaded', { detail: result }));
  return true;
}

// 右下角浮层提示，多条垂直堆叠；error 停留更久；type: success / error / info
const TOAST_ICONS = {
  success: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  error: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  info: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};
/** @type {HTMLElement | null} */
let toastStackEl = null;
function toast(msg, type = 'info') {
  if (!toastStackEl) {
    toastStackEl = el('div', { class: 'toast-stack' });
    document.body.appendChild(toastStackEl);
  }
  const node = el('div', { class: `toast toast-${type}` });
  node.innerHTML = TOAST_ICONS[type] || TOAST_ICONS.info;
  node.appendChild(document.createTextNode(String(msg)));
  toastStackEl.appendChild(node);
  setTimeout(() => {
    node.classList.add('toast-out');
    setTimeout(() => node.remove(), 300);
  }, type === 'error' ? 4000 : 2500);
}

// 统一空状态：居中图标 + 主文案 + 弱化副文案（feather inbox 图标）；
// action 可选，给空态一个直接入口按钮（如「选择项目」）
const EMPTY_STATE_ICON =
  '<svg class="empty-state-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
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

async function loadProject(folder, { silent = false } = {}) {
  try {
    state.folder = folder;
    state.base = null;
    state.selectedFile = null;
    state.selectedLine = null;
    projectPathEl.textContent = folder;
    projectPathEl.title = folder;
    setLoading(true);
    await loadChanges(folder, { force: true });
    try { await api.stopWatch(); } catch { /* 忽略 */ }
    try { await api.startWatch(folder); } catch { /* 忽略 */ }
    try { await api.addRecentProject(folder); } catch { /* 忽略 */ }
    return true;
  } catch (err) {
    if (silent) {
      // 启动自动恢复失败（如目录已删除）：停留空态，由启动逻辑尝试下一个最近项目
      state.folder = null;
      projectPathEl.textContent = '未选择项目';
      projectPathEl.title = '点击选择最近项目';
      return false;
    }
    toast('加载改动失败：' + errText(err), 'error');
    return false;
  } finally {
    setLoading(false);
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
  try {
    setLoading(true);
    await loadChanges(state.folder, { force: true });
  } catch (err) {
    toast('重新扫描失败：' + errText(err), 'error');
  } finally {
    setLoading(false);
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
  } catch { /* 通知不可用时静默跳过 */ }
}

// 最近项目下拉：点击 header 路径展开，点击其他位置关闭
/** @type {HTMLElement | null} */
let recentDropdown = null;
function closeRecentDropdown() {
  if (recentDropdown) {
    recentDropdown.remove();
    recentDropdown = null;
  }
}

async function toggleRecentDropdown() {
  if (recentDropdown) {
    closeRecentDropdown();
    return;
  }
  let recents = [];
  try {
    recents = await api.getRecentProjects();
  } catch { /* 拉取失败按空列表处理 */ }
  if (!recents || !recents.length) {
    toast('暂无最近项目');
    return;
  }
  const rect = projectPathEl.getBoundingClientRect();
  recentDropdown = el('div', {
    class: 'recent-dropdown',
    style: `top:${rect.bottom + 6}px; left:${rect.left}px;`,
  });
  for (const path of recents) {
    recentDropdown.appendChild(el('div', {
      class: 'recent-item',
      text: path,
      title: path,
      onClick: () => {
        closeRecentDropdown();
        if (path !== state.folder) loadProject(path);
      },
    }));
  }
  document.body.appendChild(recentDropdown);
}

projectPathEl.addEventListener('click', toggleRecentDropdown);
document.addEventListener('click', (ev) => {
  if (!recentDropdown) return;
  const target = /** @type {Node | null} */ (ev.target);
  if (recentDropdown.contains(target) || projectPathEl.contains(target)) return;
  closeRecentDropdown();
});

// 文件监听：变化防抖 2s 后自动重新扫描
/** @type {ReturnType<typeof setTimeout> | null} */
let watchTimer = null;
if (typeof api.onFsChanged === 'function') {
  api.onFsChanged(() => {
    if (watchTimer) clearTimeout(watchTimer);
    watchTimer = setTimeout(async () => {
      if (!state.folder) return;
      try {
        const updated = await loadChanges(state.folder);
        if (updated) toast('检测到文件变化，已自动重新扫描');
      } catch { /* 自动重扫失败时静默，等待下次变化 */ }
    }, 2000);
  });
}

const ctx = { api, state, bus, selectFolder, el, errText, notify, toast, changesFingerprint, emptyState };
ctx.showRunDetails = createRunDetails(ctx);

const tabs = [overviewTab, reviewTab, explainTab, fullExplainTab, settingsTab, planTab];
const tabBar = /** @type {HTMLElement} */ (document.getElementById('tab-bar'));
const tabContent = /** @type {HTMLElement} */ (document.getElementById('tab-content'));
const mounted = new Map();
let activeId = null;

const svgWrap = (inner) =>
  `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
  `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const TAB_ICONS = {
  overview: svgWrap('<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>'),
  review: svgWrap('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  explain: svgWrap('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
  fullExplain: svgWrap('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>'),
  settings: svgWrap('<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>'),
  plan: svgWrap('<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>'),
};

function activateTab(id) {
  if (id === activeId) return;
  activeId = id;
  for (const btn of tabBar.children) {
    const tabBtn = /** @type {HTMLElement} */ (btn);
    tabBtn.classList.toggle('active', tabBtn.dataset.tabId === id);
  }
  for (const [tabId, panel] of mounted) {
    panel.hidden = tabId !== id;
  }
  if (!mounted.has(id)) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    const panel = el('div', { class: 'tab-panel', dataset: { tabId: id } });
    tabContent.append(panel);
    tab.mount(panel, ctx);
    mounted.set(id, panel);
  }
  const panel = mounted.get(id);
  panel.classList.remove('panel-enter');
  void panel.offsetWidth; // 重触发动画
  panel.classList.add('panel-enter');
}

for (const tab of tabs) {
  const btn = el('button', {
    class: 'tab-btn',
    dataset: { tabId: tab.id },
    title: `${tab.title}（⌘${tabs.indexOf(tab) + 1}）`,
    onClick: () => activateTab(tab.id),
  });
  btn.innerHTML = `${TAB_ICONS[tab.id] || ''}<span>${tab.title}</span>`;
  tabBar.append(btn);
}

// 「改动总览」文件项的 AI 按钮：切到 Review tab 后通知其消费 pendingAnalyzeFile
bus.addEventListener('file:analyze', () => {
  activateTab('review');
  bus.dispatchEvent(new CustomEvent('file:analyze:ready'));
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
    .catch(() => { /* 剪贴板不可用时静默 */ });
});

// 快捷键：⌘1~6 切 tab，⌘R 重新扫描，⌘K 命令面板
document.addEventListener('keydown', (ev) => {
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
function closeShortcuts() {
  if (shortcutOverlay) {
    shortcutOverlay.remove();
    shortcutOverlay = null;
  }
}
function showShortcuts() {
  if (shortcutOverlay) {
    closeShortcuts();
    return;
  }
  shortcutOverlay = el('div', { class: 'modal-overlay' });
  const panel = el('div', { class: 'commit-modal' });
  panel.appendChild(el('div', { class: 'commit-modal-title' }, '快捷键说明'));
  const list = el('div', { class: 'shortcut-list' });
  for (const [key, desc] of [
    [`⌘1 ~ ⌘${tabs.length}`, '切换 Tab'],
    ['⌘K', '命令面板'],
    ['⌘R', '重新扫描改动'],
    ['⌘Enter', '开始 AI 分析（多角度 Review）'],
    ['⌘F', '搜索改动（改动总览）'],
    ['j / k', '上/下切换文件（改动总览）'],
    ['点击改动行', 'AI 逐句解析'],
    ['拖动 / ⌥+点击', '框选多行解析'],
    ['点击类名', '按类解析'],
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
}
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && shortcutOverlay) {
    closeShortcuts();
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
    };
    items.push(
      { group: '动作', label: '重新扫描改动', hint: '⌘R', iconHtml: ACTION_ICONS.rescan, run: () => rescan() },
      { group: '动作', label: '运行详情', iconHtml: ACTION_ICONS.runs, run: () => ctx.showRunDetails() },
      { group: '动作', label: '选择项目文件夹…', iconHtml: ACTION_ICONS.folder, run: () => selectFolder() },
      {
        group: '动作', label: `切换主题（当前：${THEME_META[themeManager.mode].label}）`,
        iconHtml: THEME_META[themeManager.mode].icon,
        run: () => themeBtn.click(),
      },
      { group: '动作', label: '快捷键说明', hint: '?', iconHtml: ACTION_ICONS.shortcuts, run: () => showShortcuts() },
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
    } catch { /* 最近项目拉取失败时仅提供页面与动作 */ }
    // 当前改动文件：选中后跳到总览对应文件
    const changedFiles = state.changes && Array.isArray(state.changes.files) ? state.changes.files : [];
    const fileIcon = svgWrap('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>');
    for (const f of changedFiles.slice(0, 30)) {
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

activateTab(tabs[0].id);

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
    } catch { /* 最近项目不可用时按空启动 */ }
  });
}

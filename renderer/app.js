import overviewTab from './tabs/overview.js';
import reviewTab from './tabs/review.js';
import explainTab from './tabs/explain.js';
import fullExplainTab from './tabs/fullExplain.js';
import settingsTab from './tabs/settings.js';
import planTab from './tabs/plan.js';
import { createRunDetails } from './runDetails.js';

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

// 右下角浮层提示，2.5s 自动消失
function toast(msg) {
  const node = el('div', { class: 'toast', text: msg });
  document.body.appendChild(node);
  setTimeout(() => {
    node.classList.add('toast-out');
    setTimeout(() => node.remove(), 300);
  }, 2500);
}

async function loadProject(folder) {
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
  } catch (err) {
    alert('加载改动失败：' + errText(err));
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
    alert('加载改动失败：' + errText(err));
  }
}

async function rescan() {
  if (!state.folder) {
    alert('请先选择项目文件夹');
    return;
  }
  try {
    setLoading(true);
    await loadChanges(state.folder, { force: true });
  } catch (err) {
    alert('重新扫描失败：' + errText(err));
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

const ctx = { api, state, bus, selectFolder, el, errText, notify, toast, changesFingerprint };
ctx.showRunDetails = createRunDetails(ctx);

const tabs = [overviewTab, reviewTab, explainTab, fullExplainTab, settingsTab, planTab];
const tabBar = /** @type {HTMLElement} */ (document.getElementById('tab-bar'));
const tabContent = /** @type {HTMLElement} */ (document.getElementById('tab-content'));
const mounted = new Map();
let activeId = null;

const svgWrap = (inner) =>
  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
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

// 快捷键：⌘1~6 切 tab，⌘R 重新扫描
document.addEventListener('keydown', (ev) => {
  if (!ev.metaKey || ev.shiftKey || ev.altKey || ev.ctrlKey) return;
  if (ev.key >= '1' && ev.key <= String(tabs.length)) {
    ev.preventDefault();
    activateTab(tabs[Number(ev.key) - 1].id);
  } else if (ev.key === 'r') {
    ev.preventDefault();
    rescan();
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
    ['⌘R', '重新扫描改动'],
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

selectBtn.addEventListener('click', selectFolder);
rescanBtn.addEventListener('click', rescan);
rescanBtn.disabled = true;

activateTab(tabs[0].id);

// 命令行带路径启动时直接加载，如 `npm start -- /path/to/project`
if (typeof api.getInitialFolder === 'function') {
  api.getInitialFolder().then((folder) => {
    if (folder) loadProject(folder);
  });
}

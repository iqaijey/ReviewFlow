// 项目级工作区 UI 状态（localStorage）：按项目目录隔离，最多保留 20 个项目（按 lastUsedAt LRU 淘汰），
// 容忍损坏 JSON（直接丢弃），所有写入支持 ~300ms 防抖且不阻塞渲染。

export const WORKSPACE_KEY_PREFIX = 'rf.ws.v1:';
export const GLOBAL_ACTIVE_TAB_KEY = 'rf.ws.v1.__activeTab';
export const MAX_PROJECTS = 20;
export const SAVE_DEBOUNCE_MS = 300;

/**
 * @typedef {{
 *   mode: string,
 *   base: string | null,
 *   commits: string[] | null,
 * }} WorkspaceSourceState
 */

/**
 * @typedef {{
 *   lastUsedAt: number,
 *   source: WorkspaceSourceState,
 *   selectedFilePath: string | null,
 *   scrollPositions: Record<string, number>,
 *   readMarkers: Record<string, string>,
 *   collapsedHunks: Record<string, string[]>,
 *   searchText: string,
 *   reviewMode: 'overall' | 'files' | 'history',
 * }} ProjectWorkspaceState
 */

/**
 * @returns {Storage | null}
 */
function getStorage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * @returns {ProjectWorkspaceState}
 */
export function createDefaultProjectState() {
  return {
    lastUsedAt: Date.now(),
    source: {
      mode: 'uncommitted',
      base: null,
      commits: null,
    },
    selectedFilePath: null,
    scrollPositions: {},
    readMarkers: {},
    collapsedHunks: {},
    searchText: '',
    reviewMode: 'overall',
  };
}

/**
 * @param {any} raw
 * @returns {WorkspaceSourceState}
 */
function normalizeSource(raw) {
  if (!raw || typeof raw !== 'object') {
    return { mode: 'uncommitted', base: null, commits: null };
  }
  const mode = typeof raw.mode === 'string' && raw.mode.trim()
    ? raw.mode.trim()
    : 'uncommitted';
  const base = typeof raw.base === 'string' && raw.base.trim()
    ? raw.base.trim()
    : null;
  const commits = Array.isArray(raw.commits)
    ? raw.commits.map((c) => String(c || '').trim()).filter(Boolean)
    : null;
  return {
    mode,
    base,
    commits: commits && commits.length ? commits : null,
  };
}

/**
 * @param {any} raw
 * @returns {'overall' | 'files' | 'history'}
 */
export function normalizeReviewMode(raw) {
  if (raw === 'files' || raw === 'per-file') return 'files';
  if (raw === 'history') return 'history';
  return 'overall';
}

/**
 * @param {any} raw
 * @returns {ProjectWorkspaceState | null}
 */
function normalizeProjectState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const defaults = createDefaultProjectState();
  const lastUsedAt = Number.isFinite(raw.lastUsedAt) && raw.lastUsedAt > 0
    ? Number(raw.lastUsedAt)
    : defaults.lastUsedAt;
  const source = normalizeSource(raw.source);
  const selectedFilePath = typeof raw.selectedFilePath === 'string' && raw.selectedFilePath
    ? raw.selectedFilePath
    : null;

  /** @type {Record<string, number>} */
  const scrollPositions = {};
  if (raw.scrollPositions && typeof raw.scrollPositions === 'object' && !Array.isArray(raw.scrollPositions)) {
    for (const [k, v] of Object.entries(raw.scrollPositions)) {
      const n = Number(v);
      if (k && Number.isFinite(n) && n >= 0) {
        scrollPositions[k] = Math.round(n);
      }
    }
  }

  /** @type {Record<string, string>} */
  const readMarkers = {};
  if (raw.readMarkers && typeof raw.readMarkers === 'object' && !Array.isArray(raw.readMarkers)) {
    for (const [k, v] of Object.entries(raw.readMarkers)) {
      if (k && typeof v === 'string' && v) {
        readMarkers[k] = v;
      }
    }
  }

  /** @type {Record<string, string[]>} */
  const collapsedHunks = {};
  if (raw.collapsedHunks && typeof raw.collapsedHunks === 'object' && !Array.isArray(raw.collapsedHunks)) {
    for (const [k, v] of Object.entries(raw.collapsedHunks)) {
      if (k && Array.isArray(v)) {
        const headers = v.filter((h) => typeof h === 'string' && h);
        if (headers.length) collapsedHunks[k] = headers;
      }
    }
  }

  const searchText = typeof raw.searchText === 'string' ? raw.searchText : '';
  const reviewMode = normalizeReviewMode(raw.reviewMode);

  return {
    lastUsedAt,
    source,
    selectedFilePath,
    scrollPositions,
    readMarkers,
    collapsedHunks,
    searchText,
    reviewMode,
  };
}

/**
 * @param {string} folder
 * @returns {string}
 */
export function projectStorageKey(folder) {
  return `${WORKSPACE_KEY_PREFIX}${folder}`;
}

/**
 * 扫描并清理损坏条目，同时按 lastUsedAt 淘汰超出上限的旧项目状态。
 * @param {Storage} storage
 */
function pruneWorkspaceProjects(storage) {
  /** @type {Array<{ key: string, lastUsedAt: number }>} */
  const validEntries = [];
  /** @type {string[]} */
  const corruptKeys = [];

  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key || !key.startsWith(WORKSPACE_KEY_PREFIX)) continue;
      const rawText = storage.getItem(key);
      if (!rawText) {
        corruptKeys.push(key);
        continue;
      }
      try {
        const parsed = JSON.parse(rawText);
        const normalized = normalizeProjectState(parsed);
        if (!normalized) {
          corruptKeys.push(key);
        } else {
          validEntries.push({ key, lastUsedAt: normalized.lastUsedAt });
        }
      } catch {
        corruptKeys.push(key);
      }
    }
  } catch {
    return;
  }

  for (const badKey of corruptKeys) {
    try { storage.removeItem(badKey); } catch { console.warn('清理损坏的工作区状态失败'); }
  }

  if (validEntries.length <= MAX_PROJECTS) return;
  validEntries.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  for (const stale of validEntries.slice(MAX_PROJECTS)) {
    try { storage.removeItem(stale.key); } catch { console.warn('清理过期的工作区状态失败'); }
  }
}

/**
 * 创建工作区状态管理器（带内存缓存与 ~300ms 防抖落盘）。
 */
export function createWorkspaceState() {
  /** @type {Map<string, ProjectWorkspaceState>} */
  const cache = new Map();
  /** @type {Map<string, ReturnType<typeof setTimeout>>} */
  const timers = new Map();
  /** @type {ReturnType<typeof setTimeout> | null} */
  let tabTimer = null;
  /** @type {string | null} */
  let cachedActiveTab = null;

  /**
   * @param {string} folder
   * @param {ProjectWorkspaceState} state
   */
  function writeNow(folder, state) {
    const storage = getStorage();
    if (!storage || !folder) return;
    const key = projectStorageKey(folder);
    try {
      storage.setItem(key, JSON.stringify(state));
      pruneWorkspaceProjects(storage);
    } catch {
      console.warn('保存工作区状态失败');
    }
  }

  /**
   * @param {string} folder
   */
  function scheduleWrite(folder) {
    if (!folder) return;
    const prev = timers.get(folder);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      timers.delete(folder);
      const current = cache.get(folder);
      if (current) writeNow(folder, current);
    }, SAVE_DEBOUNCE_MS);
    timers.set(folder, timer);
  }

  /**
   * 读取项目状态（若损坏则从 localStorage 移除并返回默认态）。
   * @param {string | null | undefined} folder
   * @returns {ProjectWorkspaceState}
   */
  function getProject(folder) {
    if (!folder) return createDefaultProjectState();
    const hit = cache.get(folder);
    if (hit) return hit;

    const storage = getStorage();
    const key = projectStorageKey(folder);
    if (storage) {
      /** @type {string | null} */
      let rawText = null;
      try {
        rawText = storage.getItem(key);
      } catch {
        rawText = null;
      }
      if (rawText != null) {
        try {
          const parsed = JSON.parse(rawText);
          const normalized = normalizeProjectState(parsed);
          if (normalized) {
            cache.set(folder, normalized);
            return normalized;
          }
        } catch {
          console.warn('工作区状态格式损坏');
        }
        try { storage.removeItem(key); } catch { console.warn('移除损坏的工作区状态失败'); }
      }
    }

    const fresh = createDefaultProjectState();
    cache.set(folder, fresh);
    return fresh;
  }

  /**
   * 更新项目状态并防抖落盘。
   * @param {string | null | undefined} folder
   * @param {Partial<ProjectWorkspaceState> | ((prev: ProjectWorkspaceState) => Partial<ProjectWorkspaceState> | void)} updater
   * @returns {ProjectWorkspaceState}
   */
  function updateProject(folder, updater) {
    if (!folder) return createDefaultProjectState();
    const prev = getProject(folder);
    const patch = typeof updater === 'function' ? (updater(prev) || {}) : (updater || {});
    const merged = normalizeProjectState({
      ...prev,
      ...patch,
      lastUsedAt: Date.now(),
    }) || createDefaultProjectState();
    cache.set(folder, merged);
    scheduleWrite(folder);
    return merged;
  }

  /**
   * 标记项目刚被访问（刷新 LRU 时间戳并触发淘汰检查）。
   * @param {string | null | undefined} folder
   * @returns {ProjectWorkspaceState}
   */
  function touchProject(folder) {
    return updateProject(folder, {});
  }

  /**
   * 读取全局上次激活的 Tab ID。
   * @returns {string | null}
   */
  function getLastActiveTab() {
    if (cachedActiveTab) return cachedActiveTab;
    const storage = getStorage();
    if (!storage) return null;
    try {
      const raw = storage.getItem(GLOBAL_ACTIVE_TAB_KEY);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed === 'string' && parsed) {
          cachedActiveTab = parsed;
          return parsed;
        }
        if (parsed && typeof parsed === 'object' && typeof parsed.tabId === 'string' && parsed.tabId) {
          cachedActiveTab = parsed.tabId;
          return parsed.tabId;
        }
      } catch {
        // 丢弃损坏 JSON
        try { storage.removeItem(GLOBAL_ACTIVE_TAB_KEY); } catch { console.warn('清理上次标签页状态失败'); }
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * 防抖保存全局激活的 Tab ID。
   * @param {string} tabId
   */
  function setLastActiveTab(tabId) {
    if (!tabId || typeof tabId !== 'string') return;
    cachedActiveTab = tabId;
    if (tabTimer) clearTimeout(tabTimer);
    tabTimer = setTimeout(() => {
      tabTimer = null;
      const storage = getStorage();
      if (!storage || !cachedActiveTab) return;
      try {
        storage.setItem(GLOBAL_ACTIVE_TAB_KEY, JSON.stringify({ tabId: cachedActiveTab }));
      } catch {
        // 忽略存储异常
      }
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * 立即刷写所有待落盘的更改（供测试或退出前需要时调用）。
   */
  function flush() {
    for (const [folder, timer] of timers.entries()) {
      clearTimeout(timer);
      timers.delete(folder);
      const current = cache.get(folder);
      if (current) writeNow(folder, current);
    }
    if (tabTimer) {
      clearTimeout(tabTimer);
      tabTimer = null;
      const storage = getStorage();
      if (storage && cachedActiveTab) {
        try {
          storage.setItem(GLOBAL_ACTIVE_TAB_KEY, JSON.stringify({ tabId: cachedActiveTab }));
        } catch {
          // 忽略
        }
      }
    }
  }

  return {
    getProject,
    updateProject,
    touchProject,
    getLastActiveTab,
    setLastActiveTab,
    flush,
  };
}

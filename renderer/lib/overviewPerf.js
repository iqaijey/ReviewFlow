// 改动总览性能与交互纯函数助手：搜索索引、Diff 分块调度计算、未读跳转与分隔条边界裁剪

export const INITIAL_DIFF_ROW_BUDGET = 400;
export const CHUNK_DIFF_ROW_BUDGET = 400;
export const FILE_LIST_INCREMENTAL_THRESHOLD = 300;
export const FILE_LIST_INITIAL_BATCH = 200;
export const FILE_LIST_BATCH_SIZE = 150;
export const MIN_FILE_LIST_WIDTH = 160;
export const MIN_DIFF_VIEW_WIDTH = 240;
export const SPLITTER_KEYBOARD_STEP = 20;
export const SPLITTER_KEYBOARD_LARGE_STEP = 60;
export const ESTIMATED_ROW_HEIGHT_PX = 20;

/**
 * 计算文件指纹（若后端已给 diffFingerprint 则直接复用，否则按内容哈希兜底）。
 * @param {any} file
 * @returns {string}
 */
export function computeFileFingerprint(file) {
  if (!file) return '';
  if (typeof file.diffFingerprint === 'string' && file.diffFingerprint) {
    return file.diffFingerprint;
  }
  let h = 0;
  /** @param {string} s */
  const mix = (s) => {
    for (let i = 0; i < s.length; i += 1) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
  };
  mix(String(file.path || ''));
  mix(String(file.status || ''));
  for (const hk of (file.hunks || [])) {
    mix(String(hk.header || ''));
    for (const l of (hk.lines || [])) {
      mix(`${l.type ? l.type[0] : ''}${l.content || ''}`);
    }
  }
  return `fp:${h}`;
}

/**
 * @typedef {{
 *   file: any,
 *   pathLower: string,
 *   diffTextLower: string,
 * }} SearchIndexEntry
 */

/**
 * @typedef {{
 *   entries: SearchIndexEntry[],
 *   byFile: WeakMap<object, SearchIndexEntry>,
 *   byPath: Map<string, SearchIndexEntry>,
 * }} ChangesSearchIndex
 */

/**
 * 在每次 changes:loaded 时一次性构建全量搜索索引（路径小写 + 合并 diff 文本小写）。
 * @param {any} changes
 * @returns {ChangesSearchIndex}
 */
export function buildChangesSearchIndex(changes) {
  /** @type {SearchIndexEntry[]} */
  const entries = [];
  /** @type {WeakMap<object, SearchIndexEntry>} */
  const byFile = new WeakMap();
  /** @type {Map<string, SearchIndexEntry>} */
  const byPath = new Map();

  const files = changes && Array.isArray(changes.files) ? changes.files : [];
  for (const file of files) {
    if (!file || typeof file !== 'object') continue;
    const pathStr = String(file.path || '');
    const pathLower = pathStr.toLowerCase();
    /** @type {string[]} */
    const parts = [];
    const hunks = Array.isArray(file.hunks) ? file.hunks : [];
    for (const hk of hunks) {
      if (!hk) continue;
      if (hk.header) parts.push(String(hk.header));
      const lines = Array.isArray(hk.lines) ? hk.lines : [];
      for (const line of lines) {
        if (line && line.content) parts.push(String(line.content));
      }
    }
    const diffTextLower = parts.join('\n').toLowerCase();
    const entry = { file, pathLower, diffTextLower };
    entries.push(entry);
    byFile.set(file, entry);
    if (pathStr && !byPath.has(pathStr)) {
      byPath.set(pathStr, entry);
    }
  }

  return { entries, byFile, byPath };
}

/**
 * 判断单个文件是否命中搜索词（路径或 diff 内容包含 query）。
 * @param {ChangesSearchIndex | null | undefined} index
 * @param {any} file
 * @param {string} query
 * @returns {boolean}
 */
export function matchesFileSearch(index, file, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  if (!file) return false;
  const hit = (index && typeof file === 'object' && index.byFile.get(file))
    || (index && file.path ? index.byPath.get(String(file.path)) : null);
  if (hit) {
    return hit.pathLower.includes(q) || hit.diffTextLower.includes(q);
  }
  const pathLower = String(file.path || '').toLowerCase();
  if (pathLower.includes(q)) return true;
  const hunks = Array.isArray(file.hunks) ? file.hunks : [];
  for (const hk of hunks) {
    if (hk && String(hk.header || '').toLowerCase().includes(q)) return true;
    for (const l of (hk && Array.isArray(hk.lines) ? hk.lines : [])) {
      if (l && String(l.content || '').toLowerCase().includes(q)) return true;
    }
  }
  return false;
}

/**
 * 用预构建的搜索索引过滤文件列表。
 * @param {ChangesSearchIndex | null | undefined} index
 * @param {any[]} files
 * @param {string} query
 * @returns {any[]}
 */
export function filterFilesWithIndex(index, files, query) {
  const list = Array.isArray(files) ? files : [];
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter((f) => matchesFileSearch(index, f, q));
}

/**
 * 预计算某文件全部改动行（add/del）的全局可点击序号（cpos），
 * 使懒渲染或折叠跳过 hunk 时，后续 hunk 的 cpos 依然稳定一致。
 * @param {any} file
 * @returns {{ hunkStartCpos: number[], totalClickable: number, hunkLineCounts: number[], totalLines: number }}
 */
export function computeDiffHunkOffsets(file) {
  const hunks = file && Array.isArray(file.hunks) ? file.hunks : [];
  /** @type {number[]} */
  const hunkStartCpos = [];
  /** @type {number[]} */
  const hunkLineCounts = [];
  let totalClickable = 0;
  let totalLines = 0;

  for (const hk of hunks) {
    hunkStartCpos.push(totalClickable);
    const lines = hk && Array.isArray(hk.lines) ? hk.lines : [];
    hunkLineCounts.push(lines.length);
    totalLines += lines.length;
    for (const l of lines) {
      if (l && (l.type === 'add' || l.type === 'del')) {
        totalClickable += 1;
      }
    }
  }
  return { hunkStartCpos, totalClickable, hunkLineCounts, totalLines };
}

/**
 * 计算从 startHunkIndex 开始、在 rowBudget 行预算内本批应渲染的 hunk 区间 [startHunkIndex, endHunkIndex)。
 * 已折叠的 hunk 仅渲染头部（计 0 行），但始终推进；保证每次至少推进 1 个 hunk。
 * @param {{
 *   hunks: Array<{ header?: string, lines?: any[] }>,
 *   startHunkIndex: number,
 *   rowBudget?: number,
 *   minTargetHunkIndex?: number,
 *   minTargetRows?: number,
 *   isHunkCollapsed?: (header: string, index: number) => boolean,
 * }} opts
 * @returns {{ endHunkIndex: number, renderedRows: number, hasMore: boolean }}
 */
export function planHunkRenderBatch({
  hunks,
  startHunkIndex,
  rowBudget = INITIAL_DIFF_ROW_BUDGET,
  minTargetHunkIndex = -1,
  minTargetRows = 0,
  isHunkCollapsed = () => false,
}) {
  const list = Array.isArray(hunks) ? hunks : [];
  const total = list.length;
  const start = Math.max(0, Math.min(startHunkIndex, total));
  if (start >= total) {
    return { endHunkIndex: total, renderedRows: 0, hasMore: false };
  }

  const effectiveBudget = Math.max(1, rowBudget, minTargetRows);
  let idx = start;
  let renderedRows = 0;

  while (idx < total) {
    const hk = list[idx] || {};
    const collapsed = Boolean(isHunkCollapsed(String(hk.header || ''), idx));
    const lineCount = collapsed ? 0 : (Array.isArray(hk.lines) ? hk.lines.length : 0);

    // 至少推进一个 hunk；若指定了必须覆盖的 minTargetHunkIndex，也继续推进直到覆盖它
    if (idx > start && idx > minTargetHunkIndex && renderedRows >= effectiveBudget) {
      break;
    }

    renderedRows += lineCount;
    idx += 1;

    if (idx > minTargetHunkIndex && renderedRows >= effectiveBudget) {
      break;
    }
  }

  return {
    endHunkIndex: idx,
    renderedRows,
    hasMore: idx < total,
  };
}

/**
 * 根据目标恢复滚动像素高度估算至少需要渲染多少行，确保切文件/恢复状态时容器高度足够。
 * @param {number} savedScrollTop
 * @param {number} [viewportHeight]
 * @param {number} [rowHeight]
 * @returns {number}
 */
export function estimateRequiredRowsForScroll(
  savedScrollTop,
  viewportHeight = 800,
  rowHeight = ESTIMATED_ROW_HEIGHT_PX,
) {
  const scroll = Number(savedScrollTop);
  if (!Number.isFinite(scroll) || scroll <= 0) return INITIAL_DIFF_ROW_BUDGET;
  const vh = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 800;
  const rh = Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : ESTIMATED_ROW_HEIGHT_PX;
  const needed = Math.ceil((scroll + vh * 1.25) / rh);
  return Math.max(INITIAL_DIFF_ROW_BUDGET, needed);
}

/**
 * 查找下一个未读文件（从 currentFile 之后开始环形查找，若当前文件未选中则从头开始）。
 * @param {any[]} files
 * @param {any} currentFile
 * @param {Record<string, string>} readMarkers
 * @returns {any | null}
 */
export function findNextUnreadFile(files, currentFile, readMarkers) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return null;
  const markers = readMarkers && typeof readMarkers === 'object' ? readMarkers : {};
  const isRead = (f) => {
    if (!f || !f.path) return false;
    const saved = markers[f.path];
    return Boolean(saved && saved === computeFileFingerprint(f));
  };

  const curIdx = currentFile
    ? list.findIndex((f) => f === currentFile || (f && currentFile.path && f.path === currentFile.path))
    : -1;

  for (let offset = 1; offset <= list.length; offset += 1) {
    const idx = (curIdx + offset) % list.length;
    const candidate = list[idx];
    if (candidate && !isRead(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * 计算左/右方向键或拖拽后的合法文件列表宽度范围。
 * @param {number} desiredWidth
 * @param {number} bodyWidth
 * @param {number} [minWidth]
 * @param {number} [minDiffWidth]
 * @returns {{ width: number, min: number, max: number }}
 */
export function clampSplitterWidth(
  desiredWidth,
  bodyWidth,
  minWidth = MIN_FILE_LIST_WIDTH,
  minDiffWidth = MIN_DIFF_VIEW_WIDTH,
) {
  const min = Math.max(100, Math.round(Number(minWidth) || MIN_FILE_LIST_WIDTH));
  const rawMax = Number.isFinite(bodyWidth) && bodyWidth > 0
    ? Math.round(bodyWidth - minDiffWidth)
    : 600;
  const max = Math.max(min, rawMax);
  const w = Number.isFinite(desiredWidth) ? Math.round(desiredWidth) : 300;
  const width = Math.min(Math.max(w, min), max);
  return { width, min, max };
}

const path = require('path');
const { writeFileAtomic, readJsonFile: readJson } = require('./atomicFile');
const { randomUUID } = require('crypto');
const { normalizeFinding, hash, STATUSES, applyCapacity, parseLocation } = require('./findings');

const MAX_REVIEWS_PER_FOLDER = 20;
const MAX_RECENT_PROJECTS = 10;

function storeFile(name) {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), name);
}

function writeJson(file, data) {
  writeFileAtomic(file, JSON.stringify(data, null, 2), 'utf8');
}

function readContainer(name) {
  const value = readJson(storeFile(name), {});
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 存储结构无效，请保留文件并修复后重试`);
  return value;
}

function normalizeHistory(raw, folder, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const createdAt = Number.isSafeInteger(raw.createdAt) ? raw.createdAt : 0;
  return { ...raw, schemaVersion: 2,
    id: typeof raw.id === 'string' && raw.id ? raw.id : `legacy-${hash(JSON.stringify([folder, raw.markdown, index]))}`,
    title: typeof raw.title === 'string' && raw.title ? raw.title : '未命名评审', createdAt,
    updatedAt: Number.isSafeInteger(raw.updatedAt) ? raw.updatedAt : createdAt,
    kind: typeof raw.kind === 'string' ? raw.kind : 'review', markdown: typeof raw.markdown === 'string' ? raw.markdown : '',
    stats: raw.stats || null, pinned: raw.pinned === true, provenance: raw.provenance || null,
    coverageNotices: Array.isArray(raw.coverageNotices) ? raw.coverageNotices.filter((s) => typeof s === 'string') : [],
    findings: Array.isArray(raw.findings) ? raw.findings.map((f, i) => normalizeFinding(f, folder, i)).filter(Boolean) : [],
    verificationResults: Array.isArray(raw.verificationResults) ? raw.verificationResults : [], perModel: Array.isArray(raw.perModel) ? raw.perModel : [],
    noiseLevel: ['quiet', 'balanced', 'detailed'].includes(raw.noiseLevel) ? raw.noiseLevel : null };
}

function folderList(all, folder) {
  if (Object.hasOwn(all, folder) && !Array.isArray(all[folder])) throw new Error('项目存储结构无效：应为数组');
  return Object.hasOwn(all, folder) ? all[folder] : [];
}

/** @param {{folder:string,title?:string,stats?:Record<string,unknown>|null,markdown?:string,kind?:string,id?:string,findings?:import('./findingModel').Finding[],verificationResults?:Array<Record<string,unknown>>,perModel?:Array<Record<string,unknown>>,noiseLevel?:string|null,provenance?:import('./reviewSnapshot').Provenance|null,chatContext?:import('./chatStore').ChatContext|null,coverageNotices?:string[]}} payload */
function saveReview({ folder, title, stats, markdown, kind, id = randomUUID(), findings = [], verificationResults = [], perModel = [], noiseLevel = null, provenance = null, chatContext = null, coverageNotices = [] }) {
  if (!folder || typeof folder !== 'string') throw new Error('保存评审失败：缺少项目路径');
  const file = storeFile('review-history.json');
  const all = readContainer('review-history.json');
  const list = folderList(all, folder).map((raw, i) => normalizeHistory(raw, folder, i)).filter(Boolean);
  const existing = list.find((entry) => entry.id === id);
  const entry = {
    schemaVersion: 2, id,
    title: title || '未命名评审',
    createdAt: existing ? existing.createdAt : Date.now(), updatedAt: Date.now(), pinned: existing ? existing.pinned : false,
    provenance: provenance || existing?.provenance || null, findings, verificationResults, perModel, noiseLevel,
    chatContext: chatContext || existing?.chatContext || null,
    coverageNotices,
    kind: kind || 'review',
    stats: stats || null,
    markdown: markdown || '',
  };
  list.unshift(entry);
  all[folder] = retainReviews(list.filter((it, i) => i === 0 || it.id !== id));
  writeJson(file, all);
  const persistenceWarnings = cleanupRemovedThreads(folder, list, all[folder]);
  return { ...entry, ...(persistenceWarnings.length ? { persistenceWarnings } : {}) };
}

function cleanupRemovedThreads(folder, previous, retained) {
  return previous.filter((entry) => !retained.some((keep) => keep.id === entry.id))
    .flatMap((entry) => require('./chatStore').deleteLinked(folder, entry.id));
}

function retainReviews(list) {
  let count = 0;
  return list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt)
    .filter((entry) => entry.pinned || ++count <= MAX_REVIEWS_PER_FOLDER);
}

/** @param {string} folder @param {{query?:string,kind?:string}} [options] */
function listReviews(folder, options = {}) {
  if (typeof folder !== 'string' || !folder) throw new Error('读取评审失败：缺少项目路径');
  if (!options || typeof options !== 'object' || Array.isArray(options) || (options.query !== undefined && typeof options.query !== 'string') || (options.kind !== undefined && typeof options.kind !== 'string')) throw new Error('评审筛选条件无效');
  const all = readContainer('review-history.json');
  const query = (options.query || '').toLowerCase();
  return folderList(all, folder).map((raw, i) => normalizeHistory(raw, folder, i)).filter(Boolean)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt)
    .filter((entry) => (!options.kind || entry.kind === options.kind) && (!query || [entry.title, entry.markdown,
      ...(entry.provenance?.files || []).flatMap((f) => [f.path, f.oldPath]),
      ...(entry.provenance?.backends || []).flatMap((b) => [b.backend, b.requestedModel, b.resolvedModel]),
      ...entry.perModel.flatMap((m) => [m.label, m.backend, m.model]), entry.stats?.backend, entry.stats?.model,
    ].filter((v) => typeof v === 'string').join('\n').toLowerCase().includes(query)));
}

function getReview({ folder, id }) {
  if (typeof id !== 'string' || !id) throw new Error('缺少评审记录 id');
  return listReviews(folder).find((entry) => entry.id === id) || null;
}
function deleteReview({ folder, id }) {
  const entry = getReview({ folder, id });
  if (!entry) {
    const persistenceWarnings = require('./chatStore').deleteLinked(folder, id);
    return { deleted: false, ...(persistenceWarnings.length ? { persistenceWarnings } : {}) };
  }
  const all = readContainer('review-history.json');
  all[folder] = listReviews(folder).filter((entry) => entry.id !== id);
  writeJson(storeFile('review-history.json'), all);
  const persistenceWarnings = require('./chatStore').deleteLinked(folder, id);
  return { deleted: true, ...(persistenceWarnings.length ? { persistenceWarnings } : {}) };
}
function mutateReview(folder, id, update) {
  const all = readContainer('review-history.json');
  const list = listReviews(folder);
  const entry = list.find((entry) => entry.id === id);
  if (typeof id !== 'string' || !id || !entry) throw new Error('评审记录不存在');
  update(entry);
  entry.updatedAt = Math.max(Date.now(), entry.updatedAt + 1);
  all[folder] = retainReviews(list);
  writeJson(storeFile('review-history.json'), all);
  const persistenceWarnings = cleanupRemovedThreads(folder, list, all[folder]);
  return { ...entry, ...(persistenceWarnings.length ? { persistenceWarnings } : {}) };
}
function renameReview({ folder, id, title }) {
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 200) throw new Error('评审标题须为 1–200 个字符');
  return mutateReview(folder, id, (entry) => { entry.title = title.trim(); });
}
function setReviewPinned({ folder, id, pinned }) {
  if (typeof pinned !== 'boolean') throw new Error('固定状态必须为布尔值');
  return mutateReview(folder, id, (entry) => { entry.pinned = pinned; });
}

// 按 id 原地更新评审记录的 stats（维度标记回写），不再整条重写历史
function updateReviewStats({ folder, id, stats }) {
  if (!folder || typeof folder !== 'string') throw new Error('更新评审失败：缺少项目路径');
  if (!id || typeof id !== 'string') throw new Error('更新评审失败：缺少记录 id');
  const file = storeFile('review-history.json');
  const all = readContainer('review-history.json');
  const list = listReviews(folder);
  all[folder] = list;
  const entry = list.find((it) => it && it.id === id);
  if (!entry) throw new Error('评审记录不存在');
  entry.stats = { ...(entry.stats || {}), ...(stats || {}) };
  entry.updatedAt = Math.max(Date.now(), entry.updatedAt + 1);
  writeJson(file, all);
  return entry;
}

function getRecentProjects() {
  const list = readJson(storeFile('recent-projects.json'), []);
  return Array.isArray(list) ? list.filter((p) => typeof p === 'string') : [];
}

function addRecentProject(folder) {
  if (!folder || typeof folder !== 'string') return getRecentProjects();
  const list = [folder, ...getRecentProjects().filter((p) => p !== folder)];
  const trimmed = list.slice(0, MAX_RECENT_PROJECTS);
  writeJson(storeFile('recent-projects.json'), trimmed);
  return trimmed;
}

// ---------- 评审问题清单（review-checklist.json，按 folder 存）----------
function listChecklist(folder) {
  if (typeof folder !== 'string' || !folder) throw new Error('读取清单失败：缺少项目路径');
  const all = readContainer('review-checklist.json');
  return folderList(all, folder).map((raw, i) => {
    const item = normalizeFinding(raw, folder, i);
    if (item && !item.location) {
      const paths = [...item.text.matchAll(/(?:^|[\s`（(])([^\s`（）():]+\.[a-zA-Z0-9]+)(?=[:#])/g)].map((m) => ({ path: m[1] }));
      item.location = parseLocation(item.text, paths).location;
      if (item.location) item.fingerprint = require('./findings').fingerprint(item);
    }
    return item;
  }).filter((item) => item !== null);
}

// 整体替换某 folder 的清单（分析完成后用新解析结果合并回写）
function saveChecklist(folder, items) {
  if (!folder || typeof folder !== 'string') throw new Error('保存清单失败：缺少项目路径');
  const file = storeFile('review-checklist.json');
  if (!Array.isArray(items)) throw new Error('保存清单失败：items 必须为数组');
  const all = readContainer('review-checklist.json');
  const existing = listChecklist(folder);
  const list = items.map((raw, i) => normalizeFinding({ ...existing.find((f) => f.id === raw?.id), ...raw }, folder, i)).filter((item) => item !== null);
  const capped = applyCapacity(list);
  if (capped.persistenceWarnings.length) throw new Error(capped.persistenceWarnings[0]);
  all[folder] = capped.checklist;
  writeJson(file, all);
  return all[folder];
}

function setChecklistStatus({ folder, id, status, dismissal = undefined, expectedUpdatedAt = undefined }) {
  if (!folder || typeof folder !== 'string') throw new Error('更新清单失败：缺少项目路径');
  if (!STATUSES.includes(status)) throw new Error('无效的清单状态');
  const file = storeFile('review-checklist.json');
  const all = readContainer('review-checklist.json');
  const list = listChecklist(folder);
  const item = list.find((it) => it && it.id === id);
  if (!item) throw new Error('清单条目不存在');
  if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== item.updatedAt) throw new Error('问题已更新，请刷新清单后重试');
  if (status === 'wontfix' && dismissal !== undefined) item.dismissal = require('./projectRules').validateDismissal(dismissal);
  else if (status === 'wontfix' && expectedUpdatedAt !== undefined) throw new Error('不处理必须选择原因');
  else if (status === 'pending') item.dismissal = null;
  item.status = status;
  item.updatedAt = Math.max(Date.now(), item.updatedAt + 1);
  all[folder] = list;
  // 旧 UI 无原因的不处理不追溯计入建议。
  if (status === 'wontfix' && dismissal !== undefined) require('./projectRules').recordDismissal(folder, item);
  writeJson(file, all);
  return list;
}

function getDismissals(folder) {
  if (typeof folder !== 'string' || !folder) throw new Error('缺少项目路径');
  const all = readContainer('review-dismissals.json');
  const value = Object.hasOwn(all, folder) ? all[folder] : { events: [], suggestions: [] };
  if (!value || !Array.isArray(value.events) || !Array.isArray(value.suggestions)) throw new Error('不处理事件存储结构无效');
  return value;
}
function saveDismissals(folder, value) {
  getDismissals(folder);
  const all = readContainer('review-dismissals.json');
  all[folder] = { events: value.events.slice(-500), suggestions: value.suggestions.slice(-100) };
  writeJson(storeFile('review-dismissals.json'), all);
  return all[folder];
}

module.exports = {
  saveReview, listReviews, getReview, deleteReview, renameReview, setReviewPinned, updateReviewStats, getRecentProjects, addRecentProject,
  listChecklist, saveChecklist, setChecklistStatus, getDismissals, saveDismissals,
};

const fs = require('fs');
const path = require('path');

const MAX_REVIEWS_PER_FOLDER = 20;
const MAX_RECENT_PROJECTS = 10;

function storeFile(name) {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), name);
}

function readJson(file, fallback) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function saveReview({ folder, title, stats, markdown, kind }) {
  if (!folder || typeof folder !== 'string') throw new Error('保存评审失败：缺少项目路径');
  const file = storeFile('review-history.json');
  const all = readJson(file, {});
  const list = Array.isArray(all[folder]) ? all[folder] : [];
  const entry = {
    id: Date.now().toString(36),
    title: title || '未命名评审',
    createdAt: Date.now(),
    kind: kind || 'review',
    stats: stats || null,
    markdown: markdown || '',
  };
  list.unshift(entry);
  all[folder] = list.slice(0, MAX_REVIEWS_PER_FOLDER);
  writeJson(file, all);
  return entry;
}

function listReviews(folder) {
  const all = readJson(storeFile('review-history.json'), {});
  const list = Array.isArray(all[folder]) ? all[folder] : [];
  return list;
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
const CHECKLIST_STATUSES = ['pending', 'fixed', 'wontfix'];

function normalizeChecklistItem(item) {
  if (!item || typeof item.text !== 'string' || !item.text.trim()) return null;
  return {
    id: typeof item.id === 'string' && item.id ? item.id : `i${Date.now().toString(36)}`,
    text: item.text.trim(),
    status: CHECKLIST_STATUSES.includes(item.status) ? item.status : 'pending',
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
  };
}

function listChecklist(folder) {
  const all = readJson(storeFile('review-checklist.json'), {});
  const list = Array.isArray(all[folder]) ? all[folder] : [];
  return list.map(normalizeChecklistItem).filter(Boolean);
}

// 整体替换某 folder 的清单（分析完成后用新解析结果合并回写）
function saveChecklist(folder, items) {
  if (!folder || typeof folder !== 'string') throw new Error('保存清单失败：缺少项目路径');
  const file = storeFile('review-checklist.json');
  const all = readJson(file, {});
  const list = (Array.isArray(items) ? items : []).map(normalizeChecklistItem).filter(Boolean);
  all[folder] = list.slice(0, 200);
  writeJson(file, all);
  return all[folder];
}

function setChecklistStatus({ folder, id, status }) {
  if (!folder || typeof folder !== 'string') throw new Error('更新清单失败：缺少项目路径');
  if (!CHECKLIST_STATUSES.includes(status)) throw new Error('无效的清单状态');
  const file = storeFile('review-checklist.json');
  const all = readJson(file, {});
  const list = Array.isArray(all[folder]) ? all[folder] : [];
  const item = list.find((it) => it && it.id === id);
  if (!item) throw new Error('清单条目不存在');
  item.status = status;
  writeJson(file, all);
  return listChecklist(folder);
}

module.exports = {
  saveReview, listReviews, getRecentProjects, addRecentProject,
  listChecklist, saveChecklist, setChecklistStatus,
};

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

function saveReview({ folder, title, stats, markdown }) {
  if (!folder || typeof folder !== 'string') throw new Error('保存评审失败：缺少项目路径');
  const file = storeFile('review-history.json');
  const all = readJson(file, {});
  const list = Array.isArray(all[folder]) ? all[folder] : [];
  const entry = {
    id: Date.now().toString(36),
    title: title || '未命名评审',
    createdAt: Date.now(),
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

module.exports = { saveReview, listReviews, getRecentProjects, addRecentProject };

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_PLANS_PER_FOLDER = 10;

function plansRoot() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'plans');
}

function assertFolder(folder) {
  if (!folder || typeof folder !== 'string' || !folder.trim()) {
    throw new Error('操作失败：缺少项目路径');
  }
}

function folderDir(folder) {
  const hash = crypto.createHash('sha1').update(String(folder)).digest('hex').slice(0, 16);
  return path.join(plansRoot(), hash);
}

function planDir(folder, planId) {
  const safeId = path.basename(String(planId || ''));
  return path.join(folderDir(folder), safeId);
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

function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

function newPlanId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function sanitizeImageName(name) {
  // 仅保留安全的文件名字符，防止路径穿越
  const base = path.basename(String(name || ''))
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .trim();
  if (!base || base === '.' || base === '..') return 'image.png';
  return base.slice(0, 100);
}

function mimeFor(name) {
  const ext = path.extname(name).toLowerCase();
  const map = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
  };
  return map[ext] || 'image/png';
}

function readMeta(dir) {
  const meta = readJson(path.join(dir, 'meta.json'), null);
  if (!meta || typeof meta !== 'object') return null;
  if (!Array.isArray(meta.images)) meta.images = [];
  return meta;
}

function loadActiveId(folder) {
  const data = readJson(path.join(folderDir(folder), 'active.json'), null);
  return data && typeof data.planId === 'string' ? data.planId : null;
}

function listPlanIds(folder) {
  const dir = folderDir(folder);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => readMeta(path.join(dir, name)));
}

function listPlans(folder) {
  assertFolder(folder);
  const dir = folderDir(folder);
  const activeId = loadActiveId(folder);
  return listPlanIds(folder)
    .map((id) => {
      const meta = readMeta(path.join(dir, id));
      const prdText = readText(path.join(dir, id, 'prd.txt'));
      return {
        id: meta.id || id,
        title: meta.title || '未命名方案',
        createdAt: meta.createdAt || 0,
        prdFileName: meta.prdFileName || '',
        imageCount: meta.images.length,
        hasPlan: !!meta.hasPlan,
        active: id === activeId,
        prdExcerpt: prdText.slice(0, 80),
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

function createPlan({ folder, title, prdFileName, prdText }) {
  assertFolder(folder);
  const dir = folderDir(folder);
  const id = newPlanId();
  const meta = {
    id,
    title: (title && String(title).trim()) || '未命名方案',
    createdAt: Date.now(),
    prdFileName: prdFileName || '',
    images: [],
    hasPlan: false,
  };
  const pdir = path.join(dir, id);
  fs.mkdirSync(path.join(pdir, 'images'), { recursive: true });
  writeJson(path.join(pdir, 'meta.json'), meta);
  fs.writeFileSync(path.join(pdir, 'prd.txt'), prdText || '', 'utf8');

  const existing = listPlanIds(folder)
    .map((pid) => ({ id: pid, meta: readMeta(path.join(dir, pid)) }))
    .sort((a, b) => (b.meta.createdAt || 0) - (a.meta.createdAt || 0));
  for (const item of existing.slice(MAX_PLANS_PER_FOLDER)) {
    deletePlan(folder, item.id);
  }
  return meta;
}

function addPlanImage({ folder, planId, name, base64 }) {
  assertFolder(folder);
  const pdir = planDir(folder, planId);
  const meta = readMeta(pdir);
  if (!meta) throw new Error('添加图片失败：方案不存在');
  if (!base64 || typeof base64 !== 'string') throw new Error('添加图片失败：图片数据为空');

  let safeName = sanitizeImageName(name);
  const imageDir = path.join(pdir, 'images');
  fs.mkdirSync(imageDir, { recursive: true });
  let target = path.join(imageDir, safeName);
  if (fs.existsSync(target) && !meta.images.includes(safeName)) {
    const ext = path.extname(safeName);
    const stem = path.basename(safeName, ext);
    safeName = `${stem}-${Date.now().toString(36)}${ext}`;
    target = path.join(imageDir, safeName);
  }
  const raw = base64.replace(/^data:[^;]+;base64,/, '');
  fs.writeFileSync(target, Buffer.from(raw, 'base64'));
  if (!meta.images.includes(safeName)) {
    meta.images.push(safeName);
    writeJson(path.join(pdir, 'meta.json'), meta);
  }
  return { name: safeName };
}

function removePlanImage({ folder, planId, name }) {
  assertFolder(folder);
  const pdir = planDir(folder, planId);
  const meta = readMeta(pdir);
  if (!meta) return;
  const safeName = sanitizeImageName(name);
  try {
    fs.unlinkSync(path.join(pdir, 'images', safeName));
  } catch {}
  const idx = meta.images.indexOf(safeName);
  if (idx !== -1) {
    meta.images.splice(idx, 1);
    writeJson(path.join(pdir, 'meta.json'), meta);
  }
}

function getPlanDetail(folder, planId) {
  assertFolder(folder);
  const pdir = planDir(folder, planId);
  const meta = readMeta(pdir);
  if (!meta) return null;
  const images = meta.images
    .map((name) => {
      try {
        const buf = fs.readFileSync(path.join(pdir, 'images', name));
        return { name, dataUrl: `data:${mimeFor(name)};base64,${buf.toString('base64')}` };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return {
    id: meta.id || planId,
    title: meta.title || '未命名方案',
    createdAt: meta.createdAt || 0,
    prdFileName: meta.prdFileName || '',
    prdText: readText(path.join(pdir, 'prd.txt')),
    images,
    planMarkdown: readText(path.join(pdir, 'plan.md')),
    active: loadActiveId(folder) === path.basename(pdir),
  };
}

function savePlanResult({ folder, planId, markdown }) {
  assertFolder(folder);
  const pdir = planDir(folder, planId);
  const meta = readMeta(pdir);
  if (!meta) throw new Error('保存方案失败：方案不存在');
  fs.writeFileSync(path.join(pdir, 'plan.md'), markdown || '', 'utf8');
  meta.hasPlan = true;
  writeJson(path.join(pdir, 'meta.json'), meta);
}

function deletePlan(folder, planId) {
  assertFolder(folder);
  const dir = folderDir(folder);
  const safeId = path.basename(String(planId || ''));
  fs.rmSync(path.join(dir, safeId), { recursive: true, force: true });
  if (loadActiveId(folder) === safeId) {
    try {
      fs.unlinkSync(path.join(dir, 'active.json'));
    } catch {}
  }
}

function setActivePlan(folder, planIdOrNull) {
  assertFolder(folder);
  const dir = folderDir(folder);
  if (planIdOrNull == null || planIdOrNull === '') {
    try {
      fs.unlinkSync(path.join(dir, 'active.json'));
    } catch {}
    return;
  }
  const safeId = path.basename(String(planIdOrNull));
  if (!readMeta(path.join(dir, safeId))) throw new Error('设置启用方案失败：方案不存在');
  writeJson(path.join(dir, 'active.json'), { planId: safeId });
}

function getActivePlan(folder) {
  assertFolder(folder);
  const activeId = loadActiveId(folder);
  if (!activeId) return null;
  const pdir = planDir(folder, activeId);
  const meta = readMeta(pdir);
  if (!meta) return null;
  return {
    id: meta.id || activeId,
    title: meta.title || '未命名方案',
    planMarkdown: readText(path.join(pdir, 'plan.md')),
    prdText: readText(path.join(pdir, 'prd.txt')),
  };
}

module.exports = {
  listPlans,
  createPlan,
  addPlanImage,
  removePlanImage,
  getPlanDetail,
  savePlanResult,
  deletePlan,
  setActivePlan,
  getActivePlan,
};

const fs = require('fs');
const path = require('path');

// .reviewflow.md 项目级评审规范：按 mtime 缓存，mtime 变化后重读
const projectRulesCache = new Map();
const PROJECT_RULES_MAX_CHARS = 4000;

function loadProjectRules(folder) {
  if (!folder) return '';
  const file = path.join(folder, '.reviewflow.md');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return '';
  }
  const cached = projectRulesCache.get(file);
  if (cached && cached.mtime === stat.mtimeMs) return cached.content;
  let content;
  try {
    content = fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
  if (content.length > PROJECT_RULES_MAX_CHARS) {
    content = `${content.slice(0, PROJECT_RULES_MAX_CHARS)}\n（内容过长已截断）`;
  }
  projectRulesCache.set(file, { mtime: stat.mtimeMs, content });
  return content;
}

// 评审类 system prompt 末尾追加项目评审规范（.reviewflow.md 为空时原样返回）
function withProjectRules(system, folder) {
  const rules = loadProjectRules(folder);
  return rules ? `${system}\n\n## 项目评审规范（.reviewflow.md）\n${rules}` : system;
}

// 需求方案上下文（评审依据）：非字符串或空白串时不注入
function normalizePlanContext(planContext) {
  return typeof planContext === 'string' && planContext.trim() ? planContext.trim() : '';
}

function imageMime(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  }[ext] || 'image/png';
}

module.exports = { loadProjectRules, withProjectRules, normalizePlanContext, imageMime };

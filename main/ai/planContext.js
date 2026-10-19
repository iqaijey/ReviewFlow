const fs = require('fs');
const path = require('path');
const { hash } = require('../reviewSnapshot');
const effectiveRules = require('../effectiveRules');

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
    content = effectiveRules.parseRules(fs.readFileSync(file, 'utf8')).text;
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
/** @param {string} system @param {string} folder @param {string[]} [paths] */
function withProjectRules(system, folder, paths = undefined) {
  const rules = paths === undefined ? loadProjectRules(folder) : captureProjectRules(folder, paths).text;
  return rules ? `${system}\n\n## 项目评审规范（.reviewflow.md）\n${rules}` : system;
}

function captureProjectRules(folder, paths = []) {
  return effectiveRules.captureRules(folder, paths);
}
function rulesForPaths(captured, paths) {
  const rules = effectiveRules.relevantRules(captured.ruleFiles, paths);
  const effective = effectiveRules.renderRules(rules);
  return { ...effective, injectedHash: hash(effective.text) };
}
function withCapturedRules(system, rules) {
  return rules.text ? `${system}\n\n## 项目评审规范（.reviewflow.md）\n${rules.text}` : system;
}

// 需求方案上下文（评审依据）：非字符串或空白串时不注入
function normalizePlanContext(planContext) {
  return typeof planContext === 'string' && planContext.trim() ? planContext.trim() : '';
}

function storedPlanContext(folder, planId) {
  if (planId === undefined || planId === null || planId === '') return '';
  if (typeof planId !== 'string' || path.basename(planId) !== planId || !/^[a-zA-Z0-9-]+$/.test(planId)) throw new Error('方案 id 无效');
  const plan = require('../planStore').getPlanDetail(folder, planId);
  if (!plan) throw new Error('方案不存在或已删除');
  if (!plan.planMarkdown) return '';
  const markdown = plan.planMarkdown.length > 6000 ? `${plan.planMarkdown.slice(0, 6000)}\n\n（方案内容过长，已截断至 6000 字）` : plan.planMarkdown;
  const prd = plan.prdText.length > 500 ? `${plan.prdText.slice(0, 500)}…（PRD 过长已截断）` : plan.prdText;
  return `## 需求方案（评审依据）\n\n方案标题：${plan.title || '未命名方案'}\n\n${markdown}${prd ? `\n\n### PRD 摘要\n\n${prd}` : ''}`;
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

module.exports = { PROJECT_RULES_MAX_CHARS, loadProjectRules, withProjectRules, captureProjectRules, rulesForPaths, withCapturedRules, normalizePlanContext, storedPlanContext, imageMime };

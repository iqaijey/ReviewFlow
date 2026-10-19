export const BACKEND_LABELS = { api: 'API', opencode: 'OpenCode', kimi: 'Kimi CLI', codex: 'Codex' };
export const MODEL_FIELDS = { api: 'model', opencode: 'opencodeModel', kimi: 'kimiModel', codex: 'codexModel' };

export const pad = (n) => String(n).padStart(2, '0');

// {backend, model, effort, promptTokens, completionTokens, durationMs}
// → "API · k3-256k · 思考 high · 1,234 tokens · 12.3s"
export function formatStats(stats) {
  const parts = [];
  if (stats && stats.backend) parts.push(BACKEND_LABELS[stats.backend] || stats.backend);
  if (stats && stats.model) parts.push(stats.model);
  if (stats && stats.backend) parts.push(stats.effort ? `思考 ${stats.effort}` : '默认强度');
  if (stats && stats.promptTokens != null && stats.completionTokens != null) {
    parts.push(`${(stats.promptTokens + stats.completionTokens).toLocaleString()} tokens`);
  }
  if (stats && stats.durationMs != null) {
    parts.push(`${(stats.durationMs / 1000).toFixed(1)}s`);
  }
  return parts.join(' · ');
}

// 历史与聊天保留原有的类型检查及显式数值转换，不与 tab 的直接相加混用。
export function formatStoredStats(stats) {
  if (!stats || typeof stats !== 'object') return '';
  const parts = [];
  if (stats.backend) parts.push(BACKEND_LABELS[stats.backend] || String(stats.backend));
  if (stats.model) parts.push(String(stats.model));
  if (stats.backend) parts.push(stats.effort ? `思考 ${stats.effort}` : '默认强度');
  if (stats.promptTokens != null && stats.completionTokens != null) {
    parts.push(`${(Number(stats.promptTokens) + Number(stats.completionTokens)).toLocaleString()} tokens`);
  }
  if (stats.durationMs != null) {
    parts.push(`${(Number(stats.durationMs) / 1000).toFixed(1)}s`);
  }
  return parts.join(' · ');
}

/** @param {number} amount */
function formatCostAmount(amount) {
  if (!Number.isFinite(amount)) return '0.00';
  if (amount > 0 && amount < 0.01) return amount.toFixed(4);
  return amount.toFixed(2);
}

/** @param {RunEstimate} est */
export function formatRunEstimate(est) {
  let text = `预计：${est.calls} 次调用 · 约 ${(Number(est.inputTokens) || 0).toLocaleString()} 输入 tokens`;
  if (est.cost && typeof est.cost.min === 'number' && typeof est.cost.max === 'number') {
    const sym = est.cost.currency === 'USD' ? '$' : '¥';
    text += ` · ${sym}${formatCostAmount(est.cost.min)} – ${sym}${formatCostAmount(est.cost.max)}`;
  }
  const notes = Array.isArray(est.notes) ? est.notes.filter(Boolean) : [];
  return { text, tooltip: notes.join('\n') };
}

// 注入 prompt 的方案长度上限，避免方案过长撑爆 prompt
const PLAN_CONTEXT_MAX_CHARS = 6000;
const PLAN_PRD_EXCERPT_CHARS = 500;

export const planReviewEnabled = () => localStorage.getItem('planReviewEnabled') !== '0';

// 拉取当前项目启用的需求方案并构造注入文本；未开启、无方案或接口缺失时返回 null
/** @param {AutoReviewApi} api */
export async function loadPlanContext(api, folder) {
  if (!folder || !planReviewEnabled() || typeof api.getActivePlan !== 'function') return null;
  /** @type {Awaited<ReturnType<AutoReviewApi['getActivePlan']>>} */
  let plan = null;
  try {
    plan = await api.getActivePlan(folder);
  } catch {
    console.warn('读取参照方案失败');
    return null;
  }
  if (!plan || !plan.planMarkdown) return null;
  let markdown = String(plan.planMarkdown);
  if (markdown.length > PLAN_CONTEXT_MAX_CHARS) {
    markdown = `${markdown.slice(0, PLAN_CONTEXT_MAX_CHARS)}\n\n（方案内容过长，已截断至 ${PLAN_CONTEXT_MAX_CHARS} 字）`;
  }
  const prdText = String(plan.prdText || '');
  const prdExcerpt = prdText.length > PLAN_PRD_EXCERPT_CHARS
    ? `${prdText.slice(0, PLAN_PRD_EXCERPT_CHARS)}…（PRD 过长已截断）`
    : prdText;
  const title = plan.title || '未命名方案';
  let section = `## 需求方案（评审依据）\n\n方案标题：${title}\n\n${markdown}`;
  if (prdExcerpt) section += `\n\n### PRD 摘要\n\n${prdExcerpt}`;
  return { id: String(plan.id || ''), title, section };
}

export function countChanges(files) {
  let add = 0, del = 0;
  for (const f of files)
    for (const h of f.hunks)
      for (const l of h.lines) {
        if (l.type === 'add') add++;
        else if (l.type === 'del') del++;
      }
  return { add, del };
}

export function changesTitle(files) {
  const d = new Date();
  const { add, del } = countChanges(files);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())} · ${files.length} 文件 +${add} -${del}`;
}

export function defaultExportName(prefix, ext) {
  const d = new Date();
  return `${prefix}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
}

export function copyMarkdown(markdown, toast) {
  navigator.clipboard.writeText(markdown)
    .then(() => { if (toast) toast('已复制到剪贴板'); })
    .catch(() => { if (toast) toast('复制失败，请重试', 'error'); });
}

export async function exportReview(api, toast, errText, payload) {
  try {
    const saved = await api.exportReview(payload());
    if (saved && toast) toast(`已保存到 ${saved}`);
  } catch (err) {
    toast('导出失败：' + errText(err), 'error');
  }
}

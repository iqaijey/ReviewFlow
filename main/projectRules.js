const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { hash, normalizeDescription, dice } = require('./findings');
const { writeFileAtomic } = require('./atomicFile');
const { parseRules, renderRules } = require('./effectiveRules');
const { readRepoFile } = require('./safeRead');
/** @typedef {{schemaVersion:2,id:string,findingId:string,category:string,scope:string,text:string,reason:string,note:string,createdAt:number}} DismissalEvent */
/** @typedef {{schemaVersion:2,id:string,memberFindingIds:string[],representativeText:string,category:string,scope:string,reason:string,note:string,snippet:string,state:'suggested'|'dismissed'|'applied'}} RuleSuggestion */
const REASONS = { false_positive: '误报', intentional: '有意为之', handled_elsewhere: '别处已处理', other: '其他' };
const previews = new Map();
function validateDismissal(raw) {
  if (!raw || !Object.hasOwn(REASONS, raw.reason)) throw new Error('请选择有效的不处理原因');
  const note = typeof raw.note === 'string' ? raw.note.trim() : '';
  if (note.length > 500 || (raw.reason === 'other' && !note)) throw new Error('其他原因必须填写说明，最多 500 字');
  return { reason: raw.reason, note, createdAt: Date.now() };
}
function sameGroup(event, representative) {
  return event.category === representative.category && event.scope === representative.scope && event.reason === representative.reason
    && (event.reason !== 'other' || normalizeDescription(event.note) === normalizeDescription(representative.note))
    && dice(normalizeDescription(event.text), normalizeDescription(representative.text)) >= 0.85;
}
function buildSnippet(group) {
  const text = group.text.replace(/[\r\n`]/g, ' ');
  const note = group.note.replace(/[\r\n]/g, ' ');
  return `### ReviewFlow 评审约定\n- 范围：\`${group.scope}\`\n- 对类似“${text}”的提醒，先核对项目上下文和已有前置校验，再依据具体证据判断是否为缺陷。\n- 项目说明：${REASONS[group.reason]}${note ? `；${note}` : ''}。`;
}
/** @param {{events:DismissalEvent[],suggestions:RuleSuggestion[]}} data */
function suggestRules(data) {
  const groups = [];
  for (const event of data.events) {
    let group = groups.find((g) => sameGroup(event, g.representative));
    if (!group) { group = { representative: event, ids: new Set() }; groups.push(group); }
    group.ids.add(event.findingId);
  }
  const suggestions = structuredClone(data.suggestions);
  for (const group of groups.filter((g) => g.ids.size >= 3)) {
    const r = group.representative;
    const id = hash(JSON.stringify(['rule-v2', r.category, r.scope, r.reason, normalizeDescription(r.text), r.reason === 'other' ? normalizeDescription(r.note) : '']));
    const existing = suggestions.find((s) => s.id === id);
    if (existing) { existing.memberFindingIds = [...new Set([...existing.memberFindingIds, ...group.ids])]; continue; }
    suggestions.push({ schemaVersion: 2, id, memberFindingIds: [...group.ids], representativeText: r.text,
      category: r.category, scope: r.scope, reason: r.reason, note: r.note, snippet: buildSnippet(r), state: 'suggested' });
  }
  return { events: data.events.slice(-500), suggestions: suggestions.slice(-100) };
}
function recordDismissal(folder, item) {
  const store = require('./store');
  const data = store.getDismissals(folder);
  const dismissal = item.dismissal;
  if (!dismissal) return data;
  const scope = item.location ? `${path.posix.dirname(item.location.path).replace(/^\.$/, '')}/`.replace(/^\/$/, './') : './';
  const event = { schemaVersion: 2, id: randomUUID(), findingId: item.id, category: item.category, scope,
    text: item.text, reason: dismissal.reason, note: dismissal.note, createdAt: dismissal.createdAt };
  return store.saveDismissals(folder, suggestRules({ events: [...data.events, event], suggestions: data.suggestions }));
}
function listSuggestions({ folder }) { return require('./store').getDismissals(folder).suggestions; }
function dismissSuggestion({ folder, id }) {
  const store = require('./store'), data = store.getDismissals(folder);
  const suggestion = data.suggestions.find((s) => s.id === id);
  if (!suggestion) throw new Error('规则建议不存在');
  if (suggestion.state === 'applied') throw new Error('规则已应用，不能撤销项目文件');
  suggestion.state = 'dismissed';
  store.saveDismissals(folder, data);
  return suggestion;
}
function readRules(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('缺少有效项目绝对路径');
  if (!fs.statSync(folder).isDirectory()) throw new Error('项目路径不是目录');
  const file = path.join(folder, '.reviewflow.md');
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('.reviewflow.md 必须是普通文件，不能是符号链接');
    const bytes = readRepoFile(folder, '.reviewflow.md', { maxBytes: 16 * 1024 * 1024 });
    return { file, bytes, expectedHash: hash(bytes), text: bytes.toString('utf8') };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { file, bytes: Buffer.alloc(0), expectedHash: null, text: '' };
  }
}
function previewAppend({ folder, suggestionId, snippet }) {
  const suggestion = listSuggestions({ folder }).find((s) => s.id === suggestionId);
  if (!suggestion) throw new Error('规则建议不存在，请刷新建议');
  if (typeof snippet !== 'string' || !snippet.trim() || snippet.length > 20000) throw new Error('规则内容不能为空且最多 20000 字');
  const current = readRules(folder);
  const marker = `<!-- reviewflow-rule:${suggestionId} -->`;
  const suffix = current.text.includes(marker) ? '' : `${current.bytes.length ? '\n\n' : ''}${marker}\n${snippet.trim()}\n`;
  const previewId = randomUUID();
  const resultingText = current.text + suffix;
  const effective = renderRules([{ path: '.reviewflow.md', raw: resultingText, text: parseRules(resultingText).text, mtime: 0, size: Buffer.byteLength(resultingText) }]);
  const truncatedByPromptLimit = Boolean(suffix) && effective.truncated;
  // 预览只存主进程，确认不能替换路径或内容；限制未确认预览数量。
  if (previews.size >= 100) previews.delete(previews.keys().next().value);
  previews.set(previewId, { folder, suggestionId, expectedHash: current.expectedHash, suffix, marker, truncatedByPromptLimit });
  return { previewId, expectedHash: current.expectedHash, resultingText, truncatedByPromptLimit };
}
function appendRule({ folder, previewId, confirmed }) {
  if (confirmed !== true) throw new Error('追加规则需要明确确认');
  const preview = previews.get(previewId);
  if (!preview || preview.folder !== folder) throw new Error('预览不存在，请重新预览');
  const store = require('./store'), data = store.getDismissals(folder);
  const suggestion = data.suggestions.find((s) => s.id === preview.suggestionId);
  if (!suggestion) throw new Error('规则建议不存在');
  const current = readRules(folder);
  if (!current.text.includes(preview.marker)) {
    if (current.expectedHash !== preview.expectedHash) throw new Error('项目规则已变化，请刷新预览后重试');
    writeFileAtomic(current.file, Buffer.concat([current.bytes, Buffer.from(preview.suffix, 'utf8')]));
  }
  suggestion.state = 'applied';
  store.saveDismissals(folder, data);
  return { fileHash: current.text.includes(preview.marker) ? current.expectedHash : hash(Buffer.concat([current.bytes, Buffer.from(preview.suffix)])), suggestion,
    persistenceWarnings: preview.truncatedByPromptLimit ? ['追加规则超出仅根规则时提示词注入的 4000 字范围，可能未完整生效；有自己的 .reviewflow.md 的目录使用 8000 字预算，请调整项目规则顺序。'] : [] };
}
module.exports = { validateDismissal, sameGroup, buildSnippet, suggestRules, recordDismissal, listSuggestions, dismissSuggestion, previewAppend, appendRule };

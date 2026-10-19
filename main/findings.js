const { randomUUID } = require('crypto');
const model = require('./findingModel');
const { CATEGORIES, normalizeDescription, normalizePath, normalizeFinding, fingerprint, lineRange, dice } = model;
/** @typedef {import('./findingModel').Finding} Finding */
/** @typedef {import('./findingModel').Location} Location */

// 围栏中的示例不是模型结论；仅去掉围栏，不改变标题层级。
function unfencedLines(markdown) {
  let fence = '';
  return String(markdown || '').replace(/\r\n?/g, '\n').split('\n').filter((line) => {
    const m = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (m) {
      if (!fence) fence = m[1];
      else if (m[1][0] === fence[0] && m[1].length >= fence.length) fence = '';
      return false;
    }
    return !fence;
  });
}
/** @param {Location} location */
function extractAnchor(location, files) {
  if (location.startLine == null) return null;
  const file = files.find((f) => f.path === location.path || (location.side === 'old' && f.oldPath === location.path));
  if (!file) return null;
  const key = location.side === 'old' ? 'oldLine' : 'newLine';
  const lines = (file.hunks || []).flatMap((h) => h.lines || []).filter((l) => Number.isSafeInteger(l[key]) && typeof l.content === 'string');
  const hits = lines.map((l, i) => l[key] === location.startLine ? i : -1).filter((i) => i >= 0);
  if (hits.length !== 1) return null;
  const start = hits[0];
  const endLine = location.endLine ?? location.startLine;
  const range = lines.slice(start).filter((l) => l[key] <= endLine);
  const target = range.slice(0, 3);
  if (!target.length) return null;
  const end = start + range.length;
  return { target: target.map((l) => l.content), before: lines.slice(Math.max(0, start - 3), start).map((l) => l.content), after: lines.slice(end, end + 3).map((l) => l.content) };
}
/** @returns {{text:string,location:Location|null}} */
function parseLocation(text, files = []) {
  const canonical = text.match(/^@("(?:\\.|[^"\\])*"):(new|old):(\?|\d+(?:-\d+)?)\s*\|\s*(.+)$/);
  if (canonical) {
    try {
      const path = normalizePath(JSON.parse(canonical[1]));
      const [start, end = start] = canonical[3].split('-');
      return { text: canonical[4], location: path ? { path, side: canonical[2] === 'old' ? 'old' : 'new', ...lineRange(start, end), anchor: null } : null };
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return { text, location: null };
    }
  }
  if (/^@\?\s*\|/.test(text)) return { text: text.replace(/^@\?\s*\|\s*/, ''), location: null };
  const hits = [];
  for (const file of files) {
    for (const path of [file.path, file.oldPath].filter(Boolean)) {
      const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp('(?<![\\w/])' + escaped + '(?::(\\d+)(?:-(\\d+))?|#L(\\d+)(?:-L?(\\d+))?|[`\\s]*第\\s*(\\d+)\\s*行)', 'g');
      for (const m of text.matchAll(re)) hits.push({ path, side: file.status === 'deleted' || path === file.oldPath ? 'old' : 'new', range: lineRange(m[1] || m[3] || m[5], m[2] || m[4] || m[1] || m[3] || m[5]), token: m[0] });
    }
  }
  if (hits.length !== 1) return { text, location: null };
  const hit = hits[0];
  return { text: text.replace(hit.token, '').replace(/^[\s`：:|，-]+/, '').trim() || text,
    location: { path: normalizePath(hit.path), side: hit.side === 'old' ? 'old' : 'new', ...hit.range, anchor: null } };
}
function parseIssueList(markdown, files = []) {
  let level = 0, found = false, explicitNone = false;
  /** @type {Finding[]} */
  const findings = [];
  const aliases = { 高: '高', 高危: '高', p0: '高', high: '高', 中: '中', 中危: '中', p1: '中', medium: '中', 低: '低', 低危: '低', p2: '低', low: '低' };
  for (const line of unfencedLines(markdown)) {
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      if (level && heading[1].length <= level) level = 0;
      if (heading[2].replace(/[*`]/g, '').startsWith('问题清单')) { level = heading[1].length; found = true; }
      continue;
    }
    if (!level) continue;
    if (/^\s*无[。.!！]?\s*$/.test(line)) { explicitNone = true; continue; }
    const bullet = line.match(/^\s*(?:[-*+]\s+|\d+[.)、]\s*)(?:\[[ xX]?\]\s*)?(.+?)\s*$/);
    if (!bullet) continue;
    let text = bullet[1], severity = null, category = '其他', tag;
    while ((tag = text.match(/^(?:\[([^\]]+)\]|【([^】]+)】)\s*/))) {
      const value = (tag[1] || tag[2]).trim();
      severity = aliases[value.toLowerCase()] || severity;
      if (CATEGORIES.includes(value)) category = value;
      text = text.slice(tag[0].length);
    }
    if (!text.trim() || text.trim() === '无') continue;
    const parsed = parseLocation(text, files);
    if (parsed.location) parsed.location.anchor = extractAnchor(parsed.location, files);
    const item = normalizeFinding({ ...parsed, severity, category, id: randomUUID(), createdAt: 0 });
    if (item) findings.push(item);
  }
  return { parsed: found && (explicitNone || findings.length > 0), findings: dedupeFindings(findings) };
}
function parseVerificationLines(markdown, stored) {
  const result = [];
  for (const line of unfencedLines(markdown)) {
    const match = line.match(/^\s*(?:[-*+]\s*)?(\[id=([^\]\r\n]+)\]|.+?)\s*(?:=>|⇒|→|：)\s*(已修复|仍存在|部分修复|已过时)(?:\s*\|\s*(.*)|\s*[（(](.*)[）)])?\s*$/);
    if (!match) continue;
    const candidates = match[2] ? stored.filter((f) => f.id === match[2]) : stored.filter((f) => normalizeDescription(f.text) === normalizeDescription(match[1]));
    if (candidates.length === 1) result.push({ id: candidates[0].id, verdict: match[3], note: (match[4] || match[5] || '').trim() });
  }
  return result;
}
/** @param {Finding[]} items */
function dedupeFindings(items) {
  return items.filter((item, i) => !items.slice(0, i).some((old) => old.fingerprint === item.fingerprint
    && JSON.stringify(old.location) === JSON.stringify(item.location)));
}
/** @param {Finding} item @param {Finding[]} stored @returns {Finding|null} */
function matchFinding(item, stored) {
  const exact = stored.filter((f) => f.fingerprint === item.fingerprint);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    const located = exact.filter((f) => f.location && item.location && f.location.side === item.location.side && f.location.startLine === item.location.startLine);
    return located.length === 1 ? located[0] : null;
  }
  const text = normalizeDescription(item.text);
  const descriptions = stored.filter((f) => normalizeDescription(f.text) === text && (!f.location || !item.location || f.location.path === item.location.path));
  if (descriptions.length === 1) return descriptions[0];
  if (descriptions.length > 1 || text.length < 12 || !item.location) return null;
  const candidates = stored.filter((f) => f.location && f.location.path === item.location?.path && f.location.side === item.location.side && f.category === item.category && normalizeDescription(f.text).length >= 12)
    .map((f) => ({ item: f, score: dice(text, normalizeDescription(f.text)) })).sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score < 0.90 || (candidates[1] && best.score - candidates[1].score < 0.10)) return null;
  const a = item.location, b = best.item.location;
  const near = b && a.startLine != null && b.startLine != null && a.startLine <= (b.endLine ?? b.startLine) + 10 && b.startLine <= (a.endLine ?? a.startLine) + 10;
  const anchorKey = (l) => l && l.anchor && l.anchor.target.length ? JSON.stringify(l.anchor) : null;
  const anchor = anchorKey(a);
  const uniqueAnchor = anchor && anchorKey(b) === anchor && candidates.filter((c) => anchorKey(c.item.location) === anchor).length === 1;
  return near || uniqueAnchor ? best.item : null;
}
/** @param {Finding[]} items */
function applyCapacity(items) {
  const checklist = [...items];
  const terminal = checklist.filter((f) => ['fixed', 'outdated', 'wontfix'].includes(f.status)).sort((a, b) => a.createdAt - b.createdAt);
  while (checklist.length > 200 && terminal.length) {
    const item = terminal.shift();
    if (item) checklist.splice(checklist.indexOf(item), 1);
  }
  const overflow = checklist.length > 200;
  return { checklist: checklist.slice(0, 200), persistenceWarnings: overflow ? ['问题清单已达 200 条；未淘汰待处理问题，新增溢出问题保留在本次评审历史中。'] : [] };
}
/** @param {{stored:Finding[],markdown:string,files?:import('./reviewSnapshot').SnapshotInput[],captured?:Array<{id:string,updatedAt:number}>,reviewId:string,now?:number}} input */
function reconcile({ stored, markdown, files = [], captured = [], reviewId, now = Date.now() }) {
  /** @type {Finding[]} */
  const all = structuredClone(stored);
  const parsed = parseIssueList(markdown, files);
  const originals = [...all];
  const seen = new Set(), claimed = new Set();
  for (const incoming of parsed.findings) {
    const old = matchFinding(incoming, originals.filter((f) => !claimed.has(f.id)));
    if (old) {
      seen.add(old.id); claimed.add(old.id);
      const capture = captured.find((c) => c.id === old.id);
      // 人工编辑赢过运行时快照；复现元数据也不能覆盖新编辑。
      if (capture && capture.updatedAt !== old.updatedAt) continue;
      Object.assign(old, { text: incoming.text, severity: incoming.severity ?? old.severity, category: incoming.category, location: incoming.location || old.location, lastSeenReviewId: reviewId });
      old.fingerprint = fingerprint(old);
      if (old.status === 'fixed' || old.status === 'outdated') old.status = 'pending';
    } else {
      all.push({ ...incoming, createdAt: now, updatedAt: now, firstSeenReviewId: reviewId, lastSeenReviewId: reviewId });
    }
  }
  const verdicts = parseVerificationLines(markdown, stored);
  const verificationResults = [];
  const statuses = { 已修复: 'fixed', 仍存在: 'pending', 部分修复: 'partial', 已过时: 'outdated' };
  for (const id of new Set(verdicts.map((v) => v.id))) {
    const item = all.find((f) => f.id === id), original = stored.find((f) => f.id === id);
    const capture = captured.find((c) => c.id === id);
    if (!item || !original || !capture) continue;
    const entries = verdicts.filter((v) => v.id === id);
    const contradictory = new Set(entries.map((v) => v.verdict)).size > 1;
    const v = entries[0];
    const conflict = capture.updatedAt !== original.updatedAt ? '用户在运行开始后修改了问题'
      : !['pending', 'partial'].includes(original.status) ? '问题已由用户关闭或不处理'
        : contradictory ? '同一次评审返回矛盾结论'
          : seen.has(id) && ['已修复', '已过时'].includes(v.verdict) ? '本次问题清单仍包含此问题' : null;
    const verification = { reviewId, verdict: v.verdict, note: v.note, applied: !conflict, conflict };
    item.verification = verification;
    if (!conflict) { item.status = statuses[v.verdict]; item.lastVerifiedAt = now; item.updatedAt = Math.max(now, original.updatedAt + 1); }
    verificationResults.push({ id, ...verification });
  }
  for (const item of all) if (seen.has(item.id) && !captured.some((c) => c.id === item.id && c.updatedAt !== stored.find((f) => f.id === item.id)?.updatedAt)) item.updatedAt = Math.max(now, item.updatedAt);
  return { findings: all, verificationResults, ...applyCapacity(all), parsed: parsed.parsed };
}
module.exports = { ...model, parseLocation, parseIssueList, parseVerificationLines, extractAnchor, dedupeFindings, matchFinding, applyCapacity, reconcile };

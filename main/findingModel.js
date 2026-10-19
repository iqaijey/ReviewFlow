const { createHash } = require('crypto');

/** @typedef {'pending'|'fixed'|'partial'|'outdated'|'wontfix'} FindingStatus */
/** @typedef {'安全'|'正确性'|'性能'|'可维护性'|'需求符合度'|'其他'} Category */
/** @typedef {{target:string[],before:string[],after:string[]}} Anchor */
/** @typedef {{path:string,side:'new'|'old',startLine:number|null,endLine:number|null,anchor:Anchor|null}} Location */
/** @typedef {{reason:'false_positive'|'intentional'|'handled_elsewhere'|'other',note:string,createdAt:number}} Dismissal */
/** @typedef {'已修复'|'仍存在'|'部分修复'|'已过时'} Verdict */
/** @typedef {{reviewId:string,verdict:Verdict,note:string,applied:boolean,conflict:string|null}} Verification */
/** @typedef {{schemaVersion:2,id:string,text:string,severity:'高'|'中'|'低'|null,category:Category,location:Location|null,fingerprint:string,status:FindingStatus,dismissal:Dismissal|null,createdAt:number,updatedAt:number,firstSeenReviewId:string|null,lastSeenReviewId:string|null,lastVerifiedAt:number|null,verification:Verification|null}} Finding */
const CATEGORIES = ['安全', '正确性', '性能', '可维护性', '需求符合度', '其他'];
const STATUSES = ['pending', 'fixed', 'partial', 'outdated', 'wontfix'];
/** @param {string | Buffer} text */
function hash(text) { return createHash('sha256').update(text).digest('hex'); }
/** @param {string} text */
function normalizeDescription(text) {
  return String(text).normalize('NFKC').toLowerCase()
    .replace(/@"(?:\\.|[^"\\])*":(?:new|old):(?:\?|\d+(?:-\d+)?)\s*\|\s*/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/(^|\s)_{1,2}(.+?)_{1,2}(?=\s|$)/g, '$1$2')
    .replace(/[*`~]/g, '').replace(/\s+/g, ' ').trim();
}
/** @param {string} value */
function normalizePath(value) {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized && !normalized.startsWith('/') && !/^[A-Za-z]:/.test(normalized) && !normalized.split('/').includes('..') ? normalized : '';
}
/** @param {{text:string,category:string,location:Location|null}} item */
function fingerprint(item) {
  return hash(JSON.stringify(['finding-v2', item.location ? normalizePath(item.location.path) : '', item.category, normalizeDescription(item.text)]));
}
function lineRange(start, end = start) {
  const a = Number(start), b = Number(end);
  return Number.isSafeInteger(a) && a > 0 && Number.isSafeInteger(b) && b >= a
    ? { startLine: a, endLine: b } : { startLine: null, endLine: null };
}
/** @returns {Location|null} */
function normalizeLocation(raw) {
  if (!raw || typeof raw.path !== 'string' || !normalizePath(raw.path)) return null;
  const anchor = raw.anchor && ['target', 'before', 'after'].every((k) => Array.isArray(raw.anchor[k]) && raw.anchor[k].every((x) => typeof x === 'string'))
    ? { target: raw.anchor.target.slice(0, 3), before: raw.anchor.before.slice(0, 3), after: raw.anchor.after.slice(0, 3) } : null;
  return { path: normalizePath(raw.path), side: raw.side === 'old' ? 'old' : 'new', ...lineRange(raw.startLine, raw.endLine ?? raw.startLine), anchor };
}
/** @returns {Finding|null} */
function normalizeFinding(raw, folder = '', index = 0) {
  if (!raw || typeof raw.text !== 'string' || !raw.text.trim()) return null;
  const createdAt = Number.isSafeInteger(raw.createdAt) ? raw.createdAt : 0;
  /** @type {Finding} */
  const item = {
    schemaVersion: 2, id: typeof raw.id === 'string' && raw.id ? raw.id : `legacy-${hash(JSON.stringify([folder, raw.text, index]))}`,
    text: raw.text.trim(), severity: ['高', '中', '低'].includes(raw.severity) ? raw.severity : null,
    category: CATEGORIES.includes(raw.category) ? raw.category : '其他', location: normalizeLocation(raw.location), fingerprint: '',
    status: STATUSES.includes(raw.status) ? raw.status : 'pending', createdAt,
    updatedAt: Number.isSafeInteger(raw.updatedAt) ? raw.updatedAt : createdAt,
    dismissal: raw.dismissal && ['false_positive', 'intentional', 'handled_elsewhere', 'other'].includes(raw.dismissal.reason)
      ? { reason: raw.dismissal.reason, note: typeof raw.dismissal.note === 'string' ? raw.dismissal.note.slice(0, 500) : '', createdAt: Number.isSafeInteger(raw.dismissal.createdAt) ? raw.dismissal.createdAt : createdAt } : null,
    firstSeenReviewId: typeof raw.firstSeenReviewId === 'string' ? raw.firstSeenReviewId : null,
    lastSeenReviewId: typeof raw.lastSeenReviewId === 'string' ? raw.lastSeenReviewId : null,
    lastVerifiedAt: Number.isSafeInteger(raw.lastVerifiedAt) ? raw.lastVerifiedAt : null,
    verification: raw.verification && ['已修复', '仍存在', '部分修复', '已过时'].includes(raw.verification.verdict)
      && typeof raw.verification.reviewId === 'string' ? { reviewId: raw.verification.reviewId, verdict: raw.verification.verdict,
        note: typeof raw.verification.note === 'string' ? raw.verification.note : '', applied: raw.verification.applied === true,
        conflict: typeof raw.verification.conflict === 'string' ? raw.verification.conflict : null } : null,
  };
  item.fingerprint = fingerprint(item);
  return item;
}
/** @param {string} a @param {string} b */
function dice(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map();
  for (let i = 0; i < a.length - 1; i++) counts.set(a.slice(i, i + 2), (counts.get(a.slice(i, i + 2)) || 0) + 1);
  let shared = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const pair = b.slice(i, i + 2), n = counts.get(pair) || 0;
    if (n) { shared++; counts.set(pair, n - 1); }
  }
  return 2 * shared / (a.length + b.length - 2);
}
module.exports = { hash, CATEGORIES, STATUSES, normalizeDescription, normalizePath, fingerprint, lineRange, normalizeLocation, normalizeFinding, dice };

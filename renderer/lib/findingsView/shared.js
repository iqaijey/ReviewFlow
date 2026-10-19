/** @type {Record<DismissalReason, string>} */
export const DISMISSAL_REASON_LABELS = {
  false_positive: '误报',
  intentional: '有意为之',
  handled_elsewhere: '别处已处理',
  other: '其他',
};

/** @type {Array<[DismissalReason, string]>} */
export const DISMISSAL_REASON_OPTIONS = [
  ['false_positive', '误报'],
  ['intentional', '有意为之'],
  ['handled_elsewhere', '别处已处理'],
  ['other', '其他'],
];

/** @type {Record<FindingStatus, string>} */
export const STATUS_LABELS = {
  pending: '待处理',
  partial: '部分修复',
  fixed: '已修复',
  outdated: '已过时',
  wontfix: '不处理',
};

/** @type {Array<FindingCategory>} */
export const CATEGORIES = ['安全', '正确性', '性能', '可维护性', '需求符合度', '其他'];

/**
 * @param {FindingLocation | null | undefined} location
 * @returns {string}
 */
export function formatFindingLocation(location) {
  if (!location || !location.path) return '位置未知';
  const start = location.startLine;
  const end = location.endLine;
  if (start == null) return location.path;
  if (end != null && end > start) return `${location.path}:${start}-${end}`;
  return `${location.path}:${start}`;
}


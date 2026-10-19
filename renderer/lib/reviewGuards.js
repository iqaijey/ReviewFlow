/** @param {Array<{ kind: string, markdown: string, createdAt: number }>} entries */
export function newestOverallReview(entries) {
  return entries.filter((entry) => (!entry.kind || entry.kind === 'review') && entry.markdown.trim())
    .reduce((latest, entry) => !latest || entry.createdAt > latest.createdAt ? entry : latest, /** @type {(typeof entries)[number] | null} */ (null));
}

/**
 * @template T
 * @param {{ selectedLine?: T | null }} state
 * @param {() => void} activate
 * @param {(detail: T) => void} dispatch
 * @param {T} detail
 */
export function routeExplainRequest(state, activate, dispatch, detail) {
  // 首次挂载不回放旧选区，挂载后只派发本次请求。
  state.selectedLine = null;
  activate();
  state.selectedLine = detail;
  dispatch(detail);
}

/**
 * @param {(tag: string, attrs?: Record<string, unknown>, children?: unknown) => HTMLElement} el
 * @param {HTMLElement} host
 * @param {string[] | undefined} notices
 */
export function renderCoverageNotices(el, host, notices) {
  host.textContent = '';
  host.hidden = !notices?.length;
  if (!notices?.length) return;
  const block = el('div', { class: 'findings-warning-banner coverage-notices', role: 'status' });
  for (const notice of notices) block.appendChild(el('div', {}, notice));
  host.appendChild(block);
}

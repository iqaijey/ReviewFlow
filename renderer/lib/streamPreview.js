import { renderMarkdown } from '../markdown.js';

export const STREAM_THROTTLE_MS = 200;
export const STREAM_PLAIN_FALLBACK_CHARS = 200 * 1024;
const NEAR_BOTTOM_PX = 56;

/**
 * @param {string} text
 * @returns {string}
 */
export function closeUnclosedFence(text) {
  const src = String(text ?? '');
  if (!src) return '';
  const lines = src.split('\n');
  let inFence = false;
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
    }
  }
  if (!inFence) return src;
  return src.endsWith('\n') ? `${src}\`\`\`` : `${src}\n\`\`\``;
}

/**
 * @param {HTMLElement | null} node
 * @returns {HTMLElement | null}
 */
function findScrollContainer(node) {
  let cur = node ? node.parentElement : null;
  while (cur) {
    if (typeof getComputedStyle === 'function') {
      const style = getComputedStyle(cur);
      if (style && /(auto|scroll)/.test(style.overflowY || '')) {
        return cur;
      }
    }
    if (cur.classList && (cur.classList.contains('tab-panel') || cur.classList.contains('review-result'))) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return null;
}

/**
 * @param {HTMLElement | null} scroller
 * @returns {boolean}
 */
function isNearBottom(scroller) {
  if (!scroller) return false;
  const { scrollTop, scrollHeight, clientHeight } = scroller;
  if (typeof scrollHeight !== 'number' || typeof clientHeight !== 'number') return false;
  if (scrollHeight <= clientHeight) return false;
  return scrollHeight - (scrollTop || 0) - clientHeight <= NEAR_BOTTOM_PX;
}

/**
 * @param {{
 *   el: (tag: string, attrs?: Record<string, any>, children?: any) => HTMLElement,
 *   api: AutoReviewApi,
 *   runId: string,
 *   parent: HTMLElement,
 *   className?: string,
 *   throttleMs?: number,
 *   onFirstChunk?: (() => void) | null,
 * }} opts
 */
export function createStreamPreview({
  el,
  api,
  runId,
  parent,
  className = 'stream-preview',
  throttleMs = STREAM_THROTTLE_MS,
  onFirstChunk = null,
}) {
  const streamBox = el('div', { class: `${className} md` });
  /** @type {string | null} */
  let latest = null;
  /** @type {number} */
  let rafId = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timerId = null;
  let lastRenderAt = 0;
  let disposed = false;
  let firstChunkFired = false;

  const scheduleFrame = (fn) => {
    if (typeof requestAnimationFrame === 'function') {
      return requestAnimationFrame(fn);
    }
    return Number(setTimeout(fn, 0));
  };

  const cancelFrame = (id) => {
    if (!id) return;
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(id);
    } else {
      clearTimeout(id);
    }
  };

  const flushRender = () => {
    rafId = 0;
    if (disposed || latest == null) return;
    lastRenderAt = Date.now();
    if (!streamBox.parentNode && parent) {
      parent.appendChild(streamBox);
    }
    const scroller = findScrollContainer(streamBox);
    const shouldFollow = isNearBottom(scroller);
    if (latest.length > STREAM_PLAIN_FALLBACK_CHARS) {
      streamBox.classList.remove('md');
      streamBox.classList.add('stream-preview-plain');
      streamBox.textContent = latest;
    } else {
      streamBox.classList.add('md');
      streamBox.classList.remove('stream-preview-plain');
      streamBox.innerHTML = renderMarkdown(closeUnclosedFence(latest));
    }
    if (shouldFollow && scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  };

  const requestFlush = () => {
    if (disposed || rafId) return;
    rafId = scheduleFrame(flushRender);
  };

  const rawUnsub = api && typeof api.onAiChunk === 'function'
    ? api.onAiChunk(({ runId: chunkRunId, text }) => {
        if (disposed || chunkRunId !== runId || typeof text !== 'string') return;
        latest = text;
        if (!firstChunkFired && text.length > 0) {
          firstChunkFired = true;
          if (typeof onFirstChunk === 'function') onFirstChunk();
        }
        const elapsed = Date.now() - lastRenderAt;
        if (elapsed >= throttleMs && !timerId) {
          requestFlush();
          return;
        }
        if (!timerId) {
          const wait = Math.max(0, throttleMs - elapsed);
          timerId = setTimeout(() => {
            timerId = null;
            requestFlush();
          }, wait);
        }
      })
    : null;

  const unsubscribe = () => {
    if (disposed) return;
    disposed = true;
    latest = null;
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
    if (rafId) {
      cancelFrame(rafId);
      rafId = 0;
    }
    if (typeof rawUnsub === 'function') {
      rawUnsub();
    }
    if (streamBox.parentNode) {
      streamBox.remove();
    }
  };

  return { streamBox, unsubscribe };
}

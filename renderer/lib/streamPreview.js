// 流式输出预览：onAiChunk 推送的是累计全文，这里用 rAF 合并刷新（每帧最多一次 textContent
// 赋值），避免长输出时每个 chunk 都触发一次全文本重排。生成结束后由调用方用正式结果替换，
// 所以无需 flush，直接 remove 即可。
export function createStreamPreview({ el, api, runId, parent, className = 'stream-preview' }) {
  const streamBox = el('div', { class: className, style: 'white-space: pre-wrap' });
  let latest = null;
  let rafId = 0;
  const unsubscribe = typeof api.onAiChunk === 'function'
    ? api.onAiChunk(({ runId: chunkRunId, text }) => {
        if (chunkRunId !== runId) return;
        latest = text;
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
          rafId = 0;
          if (latest == null) return;
          if (!streamBox.parentNode) parent.appendChild(streamBox);
          streamBox.textContent = latest;
        });
      })
    : null;
  return { streamBox, unsubscribe };
}

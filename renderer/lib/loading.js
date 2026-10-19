// AI 运行中的加载态：spinner + 文案 + 运行详情入口 + skeleton 微光行
// skeleton 在 CLI 后端（无流式 chunk）的长等待期间提供进度感
export function createLoadingNode(el, ctx, text) {
  const loading = el('div', { class: 'review-loading ai-loading' });
  const head = el('div', { class: 'ai-loading-head' });
  head.appendChild(el('span', { class: 'spinner' }));
  head.appendChild(el('span', {}, text));
  head.appendChild(el('button', {
    class: 'run-link', type: 'button',
    onClick: () => ctx.showRunDetails(),
  }, '运行详情'));
  loading.appendChild(head);
  const skeleton = el('div', { class: 'ai-skeleton' });
  for (const w of ['92%', '100%', '78%', '96%', '60%']) {
    skeleton.appendChild(el('div', { class: 'ai-skeleton-line', style: `width:${w}` }));
  }
  loading.appendChild(skeleton);
  return loading;
}

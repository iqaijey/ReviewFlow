import { MIN_FILE_LIST_WIDTH, MIN_DIFF_VIEW_WIDTH, SPLITTER_KEYBOARD_STEP, SPLITTER_KEYBOARD_LARGE_STEP, clampSplitterWidth } from '../../lib/overviewPerf.js';

export function mountSplitter(context) {
  const MIN_LIST_W = MIN_FILE_LIST_WIDTH;
  const syncSplitterAria = (widthPx) => {
    const bodyW = context.body.getBoundingClientRect().width;
    const { width, min, max } = clampSplitterWidth(widthPx, bodyW, MIN_LIST_W, MIN_DIFF_VIEW_WIDTH);
    context.splitter.setAttribute('aria-valuemin', String(min));
    context.splitter.setAttribute('aria-valuemax', String(max));
    context.splitter.setAttribute('aria-valuenow', String(width));
    return width;
  };
  const applySplitterWidth = (desiredW, persist = false) => {
    const bodyW = context.body.getBoundingClientRect().width;
    const { width } = clampSplitterWidth(desiredW, bodyW, MIN_LIST_W, MIN_DIFF_VIEW_WIDTH);
    context.fileList.style.width = `${width}px`;
    syncSplitterAria(width);
    if (persist) {
      context.api.saveSettings({ overviewWidth: width }).catch((err) => context.toast('保存布局失败：' + context.errText(err), 'error'));
    }
    return width;
  };
  context.fileList.style.width = '300px';
  context.api.getSettings().then((s) => {
    if (s && Number(s.overviewWidth) >= MIN_LIST_W) {
      const w = Math.round(Number(s.overviewWidth));
      context.fileList.style.width = `${w}px`;
      syncSplitterAria(w);
    }
  }).catch((err) => context.toast('读取布局失败：' + context.errText(err), 'error'));
  context.splitter.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    context.splitter.classList.add('active');
    const startX = ev.clientX;
    const startW = context.fileList.getBoundingClientRect().width;
    const onMove = (e) => {
      applySplitterWidth(startW + e.clientX - startX, false);
    };
    const onUp = () => {
      context.splitter.classList.remove('active');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onUp);
      const w = Math.round(context.fileList.getBoundingClientRect().width);
      syncSplitterAria(w);
      context.api.saveSettings({ overviewWidth: w }).catch((err) => context.toast('保存布局失败：' + context.errText(err), 'error'));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onUp); // 窗口外松开鼠标时兜底收尾
  });
  context.splitter.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight' && ev.key !== 'Home' && ev.key !== 'End') return;
    ev.preventDefault();
    ev.stopPropagation();
    const currentW = context.fileList.getBoundingClientRect().width || parseFloat(context.fileList.style.width) || 300;
    const step = ev.shiftKey ? SPLITTER_KEYBOARD_LARGE_STEP : SPLITTER_KEYBOARD_STEP;
    if (ev.key === 'ArrowLeft') {
      applySplitterWidth(currentW - step, true);
    } else if (ev.key === 'ArrowRight') {
      applySplitterWidth(currentW + step, true);
    } else if (ev.key === 'Home') {
      applySplitterWidth(MIN_LIST_W, true);
    } else if (ev.key === 'End') {
      const bodyW = context.body.getBoundingClientRect().width || 900;
      applySplitterWidth(bodyW - MIN_DIFF_VIEW_WIDTH, true);
    }
  });

}

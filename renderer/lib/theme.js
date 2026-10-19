// 主题管理：浅色 / 深色 / 跟随系统，localStorage 持久化
// 通过 html[data-theme] 切换 styles.css 中的令牌组；onChange 用于同步窗口底色等
const STORAGE_KEY = 'theme';
const MODES = ['light', 'dark', 'auto'];

/**
 * @param {{ onChange?: (mode: string, resolved: string) => void }} [options]
 */
export function createThemeManager({ onChange } = {}) {
  let mode = 'auto';
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && MODES.includes(saved)) mode = saved;
  } catch { console.warn('读取主题偏好失败'); }
  const media = window.matchMedia('(prefers-color-scheme: dark)');

  const resolvedMode = () => (mode === 'auto' ? (media.matches ? 'dark' : 'light') : mode);

  function apply() {
    const resolved = resolvedMode();
    document.documentElement.dataset.theme = resolved;
    if (typeof onChange === 'function') onChange(mode, resolved);
  }

  function setMode(next) {
    if (!MODES.includes(next)) return;
    mode = next;
    try { localStorage.setItem(STORAGE_KEY, next); } catch { console.warn('保存主题偏好失败'); }
    apply();
  }

  function cycle() {
    setMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
  }

  // 跟随系统模式下，系统主题变化时实时切换
  media.addEventListener('change', () => {
    if (mode === 'auto') apply();
  });

  apply();

  return {
    get mode() { return mode; },
    get resolved() { return resolvedMode(); },
    setMode,
    cycle,
  };
}

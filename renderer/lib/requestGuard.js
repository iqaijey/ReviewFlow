/** @param {() => string | null} getFolder */
export function createRequestGuard(getFolder) {
  let generation = 0;
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @type {{ folder: string | null, done: Promise<void>, release: () => void } | null} */
  let pendingSource = null;
  const capture = () => {
    const folder = getFolder();
    const request = generation;
    return { folder, isCurrent: () => request === generation && getFolder() === folder };
  };
  return {
    capture,
    begin() {
      generation++;
      for (const listener of listeners) listener();
      return capture();
    },
    holdSource() {
      pendingSource?.release();
      /** @type {() => void} */
      let release = () => {};
      const done = new Promise(/** @param {(value?: void) => void} resolve */ (resolve) => { release = resolve; });
      const pending = { folder: getFolder(), done, release };
      pendingSource = pending;
      return () => { if (pendingSource === pending) pendingSource = null; release(); };
    },
    async waitForSource() {
      // 只等待调用时所属项目的来源选择；项目切换后即使新项目又有待定来源也立即退出
      const folder = getFolder();
      while (pendingSource && pendingSource.folder === folder && getFolder() === folder) await pendingSource.done;
    },
    clearSource() { pendingSource?.release(); pendingSource = null; },
    invalidate() { generation++; },
    /** @param {() => void} listener */
    onBegin(listener) { listeners.add(listener); },
  };
}

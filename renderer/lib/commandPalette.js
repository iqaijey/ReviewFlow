// ⌘K 命令面板：子序列模糊匹配 + 键盘导航，数据源由调用方提供（getItems 可为异步）
// item: { group, label, path?, hint?, iconHtml?, run() }
export function createCommandPalette({ el, getItems }) {
  /** @type {HTMLElement | null} */
  let overlay = null;
  /** @type {HTMLInputElement | null} */
  let input = null;
  /** @type {HTMLElement | null} */
  let listEl = null;
  let allItems = [];
  let filtered = [];
  let activeIndex = 0;
  let loadSeq = 0;

  const isOpen = () => overlay !== null;

  function close() {
    const ov = overlay;
    if (!ov) return;
    ov.remove();
    overlay = null;
    input = null;
    listEl = null;
  }

  // 子序列匹配：返回命中下标数组，未命中返回 null
  function matchIndexes(query, text) {
    if (!query) return [];
    const q = query.toLowerCase();
    const t = String(text || '').toLowerCase();
    const idx = [];
    let qi = 0;
    for (let i = 0; i < t.length && qi < q.length; i += 1) {
      if (t[i] === q[qi]) { idx.push(i); qi += 1; }
    }
    return qi === q.length ? idx : null;
  }

  function scoreOf(query, item) {
    const labelHit = matchIndexes(query, item.label);
    const pathHit = item.path ? matchIndexes(query, item.path) : null;
    if (!query) return { score: 0, labelHit: [] };
    if (labelHit) {
      // 开头命中与连续命中加分
      let score = 10;
      if (labelHit[0] === 0) score += 5;
      for (let i = 1; i < labelHit.length; i += 1) {
        if (labelHit[i] === labelHit[i - 1] + 1) score += 2;
      }
      return { score, labelHit };
    }
    if (pathHit) return { score: 1, labelHit: [] };
    return null;
  }

  // label 高亮：命中字符包 <mark>；label 可能来自磁盘路径，全程用 textContent 防注入
  function labelNode(label, hitIdx) {
    const span = el('span', {});
    const hits = new Set(hitIdx || []);
    let buf = '';
    let inHit = false;
    const flush = () => {
      if (!buf) return;
      span.appendChild(inHit
        ? el('mark', {}, buf)
        : document.createTextNode(buf));
      buf = '';
    };
    for (let i = 0; i < label.length; i += 1) {
      const hit = hits.has(i);
      if (hit !== inHit) flush();
      inHit = hit;
      buf += label[i];
    }
    flush();
    return span;
  }

  function refresh() {
    const list = listEl;
    if (!list) return;
    const query = input ? input.value.trim() : '';
    filtered = allItems
      .map((item) => ({ item, matched: scoreOf(query, item) }))
      .filter((x) => x.matched !== null)
      .sort((a, b) => (b.matched?.score || 0) - (a.matched?.score || 0))
      .map((x) => ({ ...x.item, _hit: x.matched?.labelHit || [] }));
    activeIndex = 0;
    renderList();
  }

  function renderList() {
    const list = listEl;
    if (!list) return;
    list.textContent = '';
    if (!filtered.length) {
      list.appendChild(el('div', { class: 'palette-empty' }, '没有匹配的命令'));
      return;
    }
    let lastGroup = null;
    filtered.forEach((item, i) => {
      if (item.group !== lastGroup) {
        lastGroup = item.group;
        list.appendChild(el('div', { class: 'palette-group' }, item.group));
      }
      const btn = el('button', {
        class: `palette-item${i === activeIndex ? ' active' : ''}`,
        type: 'button',
        onClick: () => { close(); item.run(); },
      });
      if (item.iconHtml) {
        const icon = el('span', { class: 'palette-item-icon' });
        icon.innerHTML = item.iconHtml;
        btn.appendChild(icon);
      }
      btn.appendChild(labelNode(item.label, item._hit));
      if (item.path) btn.appendChild(el('span', { class: 'palette-item-path' }, item.path));
      if (item.hint) btn.appendChild(el('span', { class: 'palette-kbd' }, item.hint));
      btn.addEventListener('mousemove', () => {
        if (activeIndex !== i) { activeIndex = i; paintActive(); }
      });
      list.appendChild(btn);
    });
  }

  // 只重绘选中态，避免鼠标移动时重建整个列表
  function paintActive() {
    const list = listEl;
    if (!list) return;
    const items = list.querySelectorAll('.palette-item');
    items.forEach((node, i) => node.classList.toggle('active', i === activeIndex));
  }

  function scrollActiveIntoView() {
    const list = listEl;
    if (!list) return;
    const node = list.querySelectorAll('.palette-item')[activeIndex];
    if (node) node.scrollIntoView({ block: 'nearest' });
  }

  async function open() {
    if (overlay) { close(); return; }
    const ov = el('div', { class: 'palette-overlay' });
    const inp = /** @type {HTMLInputElement} */ (el('input', {
      class: 'palette-input', type: 'text',
      placeholder: '搜索页面、动作、最近项目…', spellcheck: 'false',
    }));
    const list = el('div', { class: 'palette-list' });
    overlay = ov;
    input = inp;
    listEl = list;
    const panel = el('div', { class: 'palette' });
    const searchRow = el('div', { class: 'palette-search' });
    searchRow.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
      '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
    searchRow.appendChild(inp);
    panel.appendChild(searchRow);
    panel.appendChild(list);
    // 底部按键提示条（Raycast/Linear 风格）
    const footer = el('div', { class: 'palette-footer' });
    for (const [key, label] of [['↑↓', '选择'], ['↵', '执行'], ['esc', '关闭']]) {
      const hint = el('span', {});
      hint.appendChild(el('span', { class: 'palette-kbd' }, key));
      hint.appendChild(document.createTextNode(label));
      footer.appendChild(hint);
    }
    panel.appendChild(footer);
    ov.appendChild(panel);
    ov.addEventListener('click', (ev) => {
      if (ev.target === ov) close();
    });
    inp.addEventListener('input', refresh);
    inp.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        ev.preventDefault();
        if (!filtered.length) return;
        const step = ev.key === 'ArrowDown' ? 1 : -1;
        activeIndex = (activeIndex + step + filtered.length) % filtered.length;
        paintActive();
        scrollActiveIntoView();
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        const item = filtered[activeIndex];
        if (item) { close(); item.run(); }
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        close();
      }
    });
    document.body.appendChild(ov);
    inp.focus();
    // 数据源可异步（最近项目走 IPC）；过期响应丢弃
    const seq = ++loadSeq;
    try {
      const items = await getItems();
      if (seq !== loadSeq || !overlay) return;
      allItems = Array.isArray(items) ? items : [];
      refresh();
    } catch {
      allItems = [];
      refresh();
    }
  }

  return {
    open,
    close,
    isOpen,
    toggle: () => (isOpen() ? close() : open()),
  };
}

import { computeFileFingerprint } from '../../lib/overviewPerf.js';

export function createSelection(context) {
  // ---------- 按类选择与显式解析操作条 ----------
  const classSel = new Map(); // key: `${file.path}#${name}#${startLine}` → { file, cls }
  const classKey = (file, c) => `${file.path}#${c.name}#${c.startLine}`;

  const classLabel = (c) => (c.kind === 'class' ? `class ${c.name}` : `${c.name}()`);

  // 类范围内的改动行（add/del），newLine 优先、del 行退回 oldLine 近似判断
  const classChangedLines = (file, c) => {
    const inRange = (n) => n != null && n >= c.startLine && n <= c.endLine;
    const segs = [];
    for (const hunk of file.hunks) {
      const lines = hunk.lines.filter((l) =>
        (l.type === 'add' || l.type === 'del') &&
        (inRange(l.newLine) || inRange(l.oldLine)));
      if (lines.length) segs.push({ hunk, lines });
    }
    return segs;
  };

  const buildClassSelectionDetail = () => {
    if (!classSel.size) return null;
    const segments = [];
    for (const { file, cls } of classSel.values()) {
      for (const seg of classChangedLines(file, cls)) {
        segments.push({
          file,
          classInfo: cls,
          hunk: {
            header: `${classLabel(cls)} · ${file.path}:${cls.startLine}-${cls.endLine}`,
            lines: seg.hunk.lines,
          },
          lines: seg.lines,
        });
      }
    }
    if (!segments.length) return null;
    return { classSelection: true, segments };
  };

  const syncSelectionBar = () => {
    if (!context.pendingSelection) {
      context.selectionSummary.textContent = '';
      context.selectionBar.hidden = true;
      return;
    }
    if (context.pendingSelection.classSelection && classSel.size > 0) {
      const count = classSel.size;
      const labelText = `解析所选类（${count}）`;
      context.explainSelectionBtn.textContent = labelText;
      context.explainSelectionBtn.setAttribute('aria-label', `${labelText}（⌘E）`);
      context.selectionSummary.textContent = `已选 ${count} 个类/函数`;
    } else {
      const totalLines = context.pendingSelection.segments
        ? context.pendingSelection.segments.reduce((n, s) => n + s.lines.length, 0)
        : 1;
      const labelText = '解析选区（⌘E）';
      context.explainSelectionBtn.textContent = labelText;
      context.explainSelectionBtn.setAttribute('aria-label', labelText);
      context.selectionSummary.textContent = `已选 ${totalLines} 行改动`;
    }
    if (!context.selectionBar.parentNode && context.diffView.firstChild) {
      context.diffView.appendChild(context.selectionBar);
    }
    context.selectionBar.hidden = false;
  };

  const clearLineSelectionDOM = () => {
    context.currentSelectedCpos = new Set();
    context.diffView.querySelectorAll('.diff-line.line-selected, .diff-line[aria-selected="true"]').forEach((n) => {
      n.classList.remove('line-selected');
      n.setAttribute('aria-selected', 'false');
    });
  };

  const clearAllSelection = () => {
    context.pendingSelection = null;
    context.state.selAnchor = null;
    clearLineSelectionDOM();
    if (classSel.size) {
      classSel.clear();
      context.fileList.querySelectorAll('.class-chip.active').forEach((chip) => {
        chip.classList.remove('active');
        chip.setAttribute('aria-pressed', 'false');
      });
    }
    syncSelectionBar();
  };

  const triggerExplicitExplain = () => {
    if (!context.pendingSelection) return false;
    context.state.selectedLine = context.pendingSelection;
    context.bus.dispatchEvent(new CustomEvent('explain:request', { detail: context.pendingSelection }));
    return true;
  };

  context.explainSelectionBtn.addEventListener('click', () => {
    triggerExplicitExplain();
  });

  context.clearSelectionBtn.addEventListener('click', () => {
    clearAllSelection();
  });

  const toggleClass = (file, c, chip) => {
    const key = classKey(file, c);
    if (classSel.has(key)) {
      classSel.delete(key);
      chip.classList.remove('active');
      chip.setAttribute('aria-pressed', 'false');
    } else {
      classSel.set(key, { file, cls: c });
      chip.classList.add('active');
      chip.setAttribute('aria-pressed', 'true');
    }
    clearLineSelectionDOM();
    context.state.selAnchor = null;
    context.pendingSelection = buildClassSelectionDetail();
    syncSelectionBar();
  };

  return {
  get clearAllSelection() { return clearAllSelection; },
  get classSel() { return classSel; },
  get classKey() { return classKey; },
  get classLabel() { return classLabel; },
  get toggleClass() { return toggleClass; },
  get syncSelectionBar() { return syncSelectionBar; },
  get clearLineSelectionDOM() { return clearLineSelectionDOM; },
  get triggerExplicitExplain() { return triggerExplicitExplain; },
  };
}

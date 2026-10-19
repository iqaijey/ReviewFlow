import { computeFileFingerprint } from '../../lib/overviewPerf.js';

const SKIPPED_REASON_LABEL = {
  'too-large': '过大',
  binary: '二进制',
  unreadable: '无法读取',
};

const fallbackFileFingerprint = computeFileFingerprint;

export function createStats(context) {
  const readAllBtn = context.el('button', { class: 'btn stat-read-all', type: 'button' }, '全部已读');
  readAllBtn.addEventListener('click', () => {
    const files = context.state.changes ? context.state.changes.files : [];
    const readCount = context.countReadFiles(files);
    if (readCount >= files.length) {
      for (const f of files) delete context.readMarkers[f.path];
    } else {
      for (const f of files) {
        context.readMarkers[f.path] = fallbackFileFingerprint(f);
      }
    }
    context.persistProjectPatch({ readMarkers: { ...context.readMarkers } });
    context.renderFileList(context.state.changes);
    updateReadStat();
  });

  const updateReadStat = () => {
    const files = context.state.changes ? context.state.changes.files : [];
    const total = files.length;
    const readCount = context.countReadFiles(files);
    if (context.readStatEl) context.readStatEl.textContent = `已读 ${readCount}/${total}`;
    readAllBtn.textContent = total && readCount >= total ? '清零' : '全部已读';
    readAllBtn.style.display = total ? '' : 'none';
  };

  const renderStats = (changes) => {
    const files = changes.files;
    const excludedCount = files.filter((f) => f && f.excluded).length;
    const classCount = files.reduce(
      (n, f) => n + f.classes.filter((c) => c.changed).length, 0);
    let add = 0, del = 0;
    for (const f of files)
      for (const h of f.hunks)
        for (const l of h.lines) {
          if (l.type === 'add') add++;
          else if (l.type === 'del') del++;
        }
    const readCount = context.countReadFiles(files);
    context.statsBar.textContent = '';
    context.statsBar.appendChild(context.el('span', { class: 'stat-item' }, `共 ${files.length} 个文件改动`));
    if (excludedCount > 0) {
      context.statsBar.appendChild(context.el('span', { class: 'stat-item stat-excluded' }, `已排除 ${excludedCount} 个文件`));
    }
    context.statsBar.appendChild(context.el('span', { class: 'stat-item' }, `${classCount} 个类/函数受影响`));
    context.statsBar.appendChild(context.el('span', { class: 'stat-item stat-add' }, `+${add}`));
    context.statsBar.appendChild(context.el('span', { class: 'stat-item stat-del' }, `-${del}`));
    context.readStatEl = context.el('span', { class: 'stat-item stat-read' }, `已读 ${readCount}/${files.length}`);
    context.statsBar.appendChild(context.readStatEl);
    context.statsBar.appendChild(readAllBtn);
    updateReadStat();
    context.statsBar.appendChild(context.el('span', { class: 'stat-item stat-hint' },
      '点击改动行或拖动行号选区 · ⌘E 解析选区 · 代码文本可直接框选复制 · 点击类名按类选择'));
  };

  const renderSemanticsNote = (changes) => {
    const source = changes && changes.source ? changes.source : null;
    if (!source) {
      context.semanticsNote.hidden = true;
      context.semanticsNote.textContent = '';
      context.semanticsNote.classList.remove('is-warning');
      return;
    }
    if (source.nonContiguous) {
      const text = '所选提交不连续，按逐个提交拼接展示（同一文件可能出现多次）';
      context.semanticsNote.textContent = text;
      context.semanticsNote.title = text;
      context.semanticsNote.classList.add('is-warning');
      context.semanticsNote.hidden = false;
    } else if (source.semantics === 'commit-range') {
      const text = '已按提交区间合并为一份净改动';
      context.semanticsNote.textContent = text;
      context.semanticsNote.title = text;
      context.semanticsNote.classList.remove('is-warning');
      context.semanticsNote.hidden = false;
    } else {
      context.semanticsNote.hidden = true;
      context.semanticsNote.textContent = '';
      context.semanticsNote.classList.remove('is-warning');
    }
  };

  const renderLimitsBanner = (changes) => {
    context.limitsBanner.textContent = '';
    const limits = changes && changes.limits ? changes.limits : null;
    if (!limits) {
      context.limitsBanner.hidden = true;
      return;
    }
    const omitted = Array.isArray(limits.omittedFiles) ? limits.omittedFiles : [];
    const truncated = Array.isArray(limits.truncatedFiles) ? limits.truncatedFiles : [];
    const skipped = Array.isArray(limits.skippedUntracked) ? limits.skippedUntracked : [];
    const hasOmitted = (Number(limits.totalFiles) > Number(limits.maxFiles)) || omitted.length > 0;
    const hasTruncated = truncated.length > 0;
    const hasSkipped = skipped.length > 0;
    if (!hasOmitted && !hasTruncated && !hasSkipped) {
      context.limitsBanner.hidden = true;
      return;
    }

    const summaryParts = [];
    if (hasOmitted) {
      summaryParts.push(`共 ${limits.totalFiles} 个文件，仅显示前 ${limits.maxFiles} 个`);
    }
    if (hasTruncated) {
      summaryParts.push(`${truncated.length} 个文件的 diff 被截断`);
    }
    if (hasSkipped) {
      summaryParts.push(`${skipped.length} 个未跟踪文件未读取（过大/二进制/无法读取）`);
    }

    const head = context.el('div', { class: 'limits-banner-head' });
    head.appendChild(context.el('span', { class: 'limits-banner-summary' }, summaryParts.join(' · ')));
    const actions = context.el('div', { class: 'limits-banner-actions' });
    const toggleBtn = context.el('button', {
      class: 'btn limits-banner-btn',
      type: 'button',
      'aria-expanded': 'false',
    }, '查看');
    const dismissBtn = context.el('button', {
      class: 'btn limits-banner-btn',
      type: 'button',
      'aria-label': '关闭限流提示',
    }, '关闭');
    actions.appendChild(toggleBtn);
    actions.appendChild(dismissBtn);
    head.appendChild(actions);

    const details = context.el('div', { class: 'limits-banner-details', hidden: 'hidden' });
    if (hasOmitted && omitted.length > 0) {
      const group = context.el('div', { class: 'limits-detail-group' });
      group.appendChild(context.el('div', { class: 'limits-detail-title' }, '未显示的改动文件'));
      const ul = context.el('ul', { class: 'limits-detail-list' });
      for (const p of omitted) {
        ul.appendChild(context.el('li', {}, p));
      }
      group.appendChild(ul);
      details.appendChild(group);
    }
    if (hasTruncated) {
      const group = context.el('div', { class: 'limits-detail-group' });
      group.appendChild(context.el('div', { class: 'limits-detail-title' }, 'Diff 被截断的文件'));
      const ul = context.el('ul', { class: 'limits-detail-list' });
      for (const item of truncated) {
        ul.appendChild(context.el('li', {}, `${item.path}（已显示 ${item.shownLines} 行）`));
      }
      group.appendChild(ul);
      details.appendChild(group);
    }
    if (hasSkipped) {
      const group = context.el('div', { class: 'limits-detail-group' });
      group.appendChild(context.el('div', { class: 'limits-detail-title' }, '未读取的未跟踪文件'));
      const ul = context.el('ul', { class: 'limits-detail-list' });
      for (const item of skipped) {
        const reasonText = SKIPPED_REASON_LABEL[item.reason] || item.reason;
        ul.appendChild(context.el('li', {}, `${item.path}（${reasonText}）`));
      }
      group.appendChild(ul);
      details.appendChild(group);
    }

    toggleBtn.addEventListener('click', () => {
      const nowHidden = !details.hidden;
      details.hidden = nowHidden;
      toggleBtn.textContent = nowHidden ? '查看' : '收起';
      toggleBtn.setAttribute('aria-expanded', nowHidden ? 'false' : 'true');
    });
    dismissBtn.addEventListener('click', () => {
      context.limitsBanner.hidden = true;
    });

    context.limitsBanner.appendChild(head);
    context.limitsBanner.appendChild(details);
    context.limitsBanner.hidden = false;
  };

  return {
  get updateReadStat() { return updateReadStat; },
  get renderSemanticsNote() { return renderSemanticsNote; },
  get renderLimitsBanner() { return renderLimitsBanner; },
  get renderStats() { return renderStats; },
  };
}

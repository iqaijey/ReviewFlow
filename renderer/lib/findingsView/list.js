import { DISMISSAL_REASON_LABELS, STATUS_LABELS, CATEGORIES, formatFindingLocation } from './shared.js';

export function createList(context) {
  /**
   * @param {Finding} item
   */
  function severityKey(item) {
    if (item.severity === '高' || item.severity === '中' || item.severity === '低') {
      return item.severity;
    }
    return 'unlabeled';
  }

  /**
   * @param {Finding} item
   */
  function matchesFilters(item) {
    if (context.severityFilter !== 'all' && severityKey(item) !== context.severityFilter) return false;
    if (context.categoryFilter !== 'all' && (item.category || '其他') !== context.categoryFilter) return false;
    if (context.statusFilter !== 'all' && item.status !== context.statusFilter) return false;
    return true;
  }

  function render() {
    context.container.textContent = '';
    const activeSuggestions = context.suggestions.filter((s) => s && (!s.state || s.state === 'suggested'));
    if (!context.findings.length && !activeSuggestions.length) {
      context.container.style.display = 'none';
      return;
    }
    context.container.style.display = '';

    const panel = context.el('div', { class: 'findings-panel review-checklist' });

    if (context.findings.length) {
      const openFindings = context.findings.filter((it) => it.status === 'pending' || it.status === 'partial');
      const pendingCount = openFindings.length;
      const fixedCount = context.findings.filter((it) => it.status === 'fixed').length;
      for (const id of [...context.selectedIds]) {
        if (!context.findings.some((f) => f.id === id)) context.selectedIds.delete(id);
      }
      const header = context.el('div', { class: 'findings-header' });
      header.appendChild(context.el('div', { class: 'findings-title review-checklist-title' },
        `问题清单（共 ${context.findings.length} 条 · ${pendingCount} 条待跟进 · ${fixedCount} 条已修复）`));

      const headerActions = context.el('div', { class: 'findings-header-actions' });
      const handoffTargetIds = context.selectedIds.size
        ? [...context.selectedIds]
        : openFindings.map((it) => it.id);
      const handoffToolbarBtn = /** @type {HTMLButtonElement} */ (context.el('button', {
        class: 'btn finding-action-btn findings-handoff-toolbar-btn',
        type: 'button',
        title: context.selectedIds.size
          ? `已勾选 ${context.selectedIds.size} 条问题，点击生成交接提示词`
          : `未勾选问题时默认导出全部 ${openFindings.length} 条未关闭问题`,
        onClick: () => context.openHandoffDialog(handoffTargetIds, handoffToolbarBtn),
      }, context.selectedIds.size
        ? `复制修复任务（已选 ${context.selectedIds.size}）`
        : '复制修复任务（所选/全部未关闭）'));
      handoffToolbarBtn.disabled = handoffTargetIds.length === 0;
      headerActions.appendChild(handoffToolbarBtn);
      const clearBtn = /** @type {HTMLButtonElement} */ (context.el('button', {
        class: 'btn finding-action-btn findings-clear-btn',
        type: 'button',
        title: '删除本项目的全部问题记录（不影响评审历史）',
        onClick: () => context.clearAllFindings(clearBtn),
      }, '清空问题清单'));
      headerActions.appendChild(clearBtn);
      header.appendChild(headerActions);
      panel.appendChild(header);

      const sevCounts = { 高: 0, 中: 0, 低: 0, unlabeled: 0 };
      /** @type {Record<string, number>} */
      const catCounts = {};
      for (const c of CATEGORIES) catCounts[c] = 0;
      const statusCounts = { pending: 0, partial: 0, fixed: 0, outdated: 0, wontfix: 0 };

      for (const it of context.findings) {
        sevCounts[severityKey(it)] = (sevCounts[severityKey(it)] || 0) + 1;
        const cat = CATEGORIES.includes(it.category) ? it.category : '其他';
        catCounts[cat] = (catCounts[cat] || 0) + 1;
        if (Object.hasOwn(statusCounts, it.status)) {
          statusCounts[it.status] += 1;
        }
      }

      const filterBar = context.el('div', { class: 'findings-filters' });

      const sevSelectId = 'findings-filter-severity';
      const sevGroup = context.el('div', { class: 'findings-filter-group' });
      sevGroup.appendChild(context.el('label', { class: 'findings-filter-label', for: sevSelectId }, '严重度'));
      const sevSelect = /** @type {HTMLSelectElement} */ (context.el('select', {
        id: sevSelectId,
        class: 'findings-filter-select',
      }));
      sevSelect.appendChild(context.el('option', { value: 'all', text: `全部 (${context.findings.length})` }));
      sevSelect.appendChild(context.el('option', { value: '高', text: `高 (${sevCounts['高']})` }));
      sevSelect.appendChild(context.el('option', { value: '中', text: `中 (${sevCounts['中']})` }));
      sevSelect.appendChild(context.el('option', { value: '低', text: `低 (${sevCounts['低']})` }));
      sevSelect.appendChild(context.el('option', { value: 'unlabeled', text: `未标注 (${sevCounts.unlabeled})` }));
      sevSelect.value = context.severityFilter;
      sevSelect.addEventListener('change', () => {
        context.severityFilter = sevSelect.value;
        render();
      });
      sevGroup.appendChild(sevSelect);
      filterBar.appendChild(sevGroup);

      const catSelectId = 'findings-filter-category';
      const catGroup = context.el('div', { class: 'findings-filter-group' });
      catGroup.appendChild(context.el('label', { class: 'findings-filter-label', for: catSelectId }, '类别'));
      const catSelect = /** @type {HTMLSelectElement} */ (context.el('select', {
        id: catSelectId,
        class: 'findings-filter-select',
      }));
      catSelect.appendChild(context.el('option', { value: 'all', text: `全部 (${context.findings.length})` }));
      for (const cat of CATEGORIES) {
        catSelect.appendChild(context.el('option', { value: cat, text: `${cat} (${catCounts[cat] || 0})` }));
      }
      catSelect.value = context.categoryFilter;
      catSelect.addEventListener('change', () => {
        context.categoryFilter = catSelect.value;
        render();
      });
      catGroup.appendChild(catSelect);
      filterBar.appendChild(catGroup);

      const stSelectId = 'findings-filter-status';
      const stGroup = context.el('div', { class: 'findings-filter-group' });
      stGroup.appendChild(context.el('label', { class: 'findings-filter-label', for: stSelectId }, '状态'));
      const stSelect = /** @type {HTMLSelectElement} */ (context.el('select', {
        id: stSelectId,
        class: 'findings-filter-select',
      }));
      stSelect.appendChild(context.el('option', { value: 'all', text: `全部 (${context.findings.length})` }));
      for (const [stKey, stLabel] of /** @type {Array<[FindingStatus, string]>} */ (Object.entries(STATUS_LABELS))) {
        stSelect.appendChild(context.el('option', { value: stKey, text: `${stLabel} (${statusCounts[stKey] || 0})` }));
      }
      stSelect.value = context.statusFilter;
      stSelect.addEventListener('change', () => {
        context.statusFilter = stSelect.value;
        render();
      });
      stGroup.appendChild(stSelect);
      filterBar.appendChild(stGroup);

      if (context.severityFilter !== 'all' || context.categoryFilter !== 'all' || context.statusFilter !== 'all') {
        const resetBtn = context.el('button', {
          class: 'btn findings-filter-reset',
          type: 'button',
          onClick: () => {
            context.severityFilter = 'all';
            context.categoryFilter = 'all';
            context.statusFilter = 'all';
            render();
          },
        }, '重置筛选');
        filterBar.appendChild(resetBtn);
      }

      panel.appendChild(filterBar);

      const visibleFindings = context.findings.filter(matchesFilters);
      const listEl = context.el('div', { class: 'findings-list' });
      if (!visibleFindings.length) {
        listEl.appendChild(context.el('div', { class: 'finding-empty-filtered' }, '当前筛选条件下没有匹配的问题'));
      } else {
        for (const item of visibleFindings) {
          const row = context.el('div', {
            class: `finding-row checklist-item finding-status-${item.status} checklist-${item.status}`,
            dataset: { findingId: item.id },
          });
          const mainLine = context.el('div', { class: 'finding-main' });

          const selectBox = /** @type {HTMLInputElement} */ (context.el('input', {
            type: 'checkbox',
            class: 'finding-select-checkbox',
            'aria-label': `选择问题：${item.text.slice(0, 40)}`,
          }));
          selectBox.checked = context.selectedIds.has(item.id);
          selectBox.addEventListener('change', () => {
            if (selectBox.checked) context.selectedIds.add(item.id);
            else context.selectedIds.delete(item.id);
            render();
          });
          mainLine.appendChild(selectBox);

          const sev = severityKey(item);
          const sevClass = sev === '高'
            ? 'finding-severity-high'
            : sev === '中'
              ? 'finding-severity-medium'
              : sev === '低'
                ? 'finding-severity-low'
                : 'finding-severity-unlabeled';
          const sevLabel = sev === 'unlabeled' ? '未标注' : sev;
          mainLine.appendChild(context.el('span', { class: `finding-severity ${sevClass}` }, sevLabel));

          mainLine.appendChild(context.el('span', { class: 'finding-category' }, item.category || '其他'));

          const locText = formatFindingLocation(item.location);
          const hasLoc = Boolean(item.location && item.location.path);
          if (hasLoc) {
            const locBtn = context.el('button', {
              class: 'finding-location',
              type: 'button',
              title: `${locText}（点击跳转到改动总览对应位置）`,
              onClick: () => {
                context.bus.dispatchEvent(new CustomEvent('diff:jump', {
                  detail: {
                    folder: context.getFolder(),
                    diffFingerprint: null,
                    location: item.location || null,
                  },
                }));
              },
            }, locText);
            mainLine.appendChild(locBtn);
          } else {
            const locSpan = context.el('span', {
              class: 'finding-location finding-location-unknown',
              title: '该问题未关联具体位置',
            }, '位置未知');
            mainLine.appendChild(locSpan);
          }

          mainLine.appendChild(context.el('span', {
            class: `finding-status-badge status-${item.status}`,
          }, STATUS_LABELS[item.status] || item.status));

          mainLine.appendChild(context.el('span', { class: 'finding-text checklist-text' }, item.text));

          const actions = context.el('div', { class: 'finding-actions' });
          const isSaving = context.savingIds.has(item.id);
          const runningOp = context.runningOps.get(item.id) || null;
          const isBusy = isSaving || Boolean(runningOp);
          const isOpenFinding = item.status === 'pending' || item.status === 'partial';
          const appliedPatchId = context.appliedPatches.get(item.id) || null;

          if (isOpenFinding && hasLoc) {
            const genPatchBtn = /** @type {HTMLButtonElement} */ (context.el('button', {
              class: 'btn finding-action-btn',
              type: 'button',
              onClick: () => context.runGenerateFixPatch(item, genPatchBtn),
            }, '生成修复补丁'));
            genPatchBtn.disabled = isBusy;
            actions.appendChild(genPatchBtn);

            const verifyBtn = /** @type {HTMLButtonElement} */ (context.el('button', {
              class: 'btn finding-action-btn',
              type: 'button',
              onClick: () => context.runVerifyFinding(item),
            }, '复核此问题'));
            verifyBtn.disabled = isBusy;
            actions.appendChild(verifyBtn);
          }

          if (appliedPatchId) {
            const revertBtn = /** @type {HTMLButtonElement} */ (context.el('button', {
              class: 'btn finding-action-btn',
              type: 'button',
              onClick: () => context.runRevertFixPatch(item, revertBtn),
            }, '撤销补丁'));
            revertBtn.disabled = isBusy;
            actions.appendChild(revertBtn);
          }

          if (isOpenFinding) {
            const handoffBtn = /** @type {HTMLButtonElement} */ (context.el('button', {
              class: 'btn finding-action-btn',
              type: 'button',
              onClick: () => context.openHandoffDialog([item.id], handoffBtn),
            }, '复制修复任务'));
            handoffBtn.disabled = isBusy;
            actions.appendChild(handoffBtn);
          }

          if (item.status !== 'fixed') {
            const fixBtn = /** @type {HTMLButtonElement} */ (context.el('button', {
              class: 'btn finding-action-btn',
              type: 'button',
              onClick: () => context.mutateStatus(item, 'fixed'),
            }, '标记已修复'));
            fixBtn.disabled = isBusy;
            actions.appendChild(fixBtn);
          }

          if (item.status !== 'wontfix') {
            const dismissBtn = /** @type {HTMLButtonElement} */ (context.el('button', {
              class: 'btn finding-action-btn',
              type: 'button',
              onClick: () => context.openDismissDialog(item, dismissBtn),
            }, '不处理…'));
            dismissBtn.disabled = isBusy;
            actions.appendChild(dismissBtn);
          }

          if (item.status !== 'pending') {
            const reopenBtn = /** @type {HTMLButtonElement} */ (context.el('button', {
              class: 'btn finding-action-btn',
              type: 'button',
              onClick: () => context.mutateStatus(item, 'pending'),
            }, '重新打开'));
            reopenBtn.disabled = isBusy;
            actions.appendChild(reopenBtn);
          }

          mainLine.appendChild(actions);
          row.appendChild(mainLine);

          if (runningOp) {
            const statusWrap = context.el('div', { class: 'finding-run-status-wrap' });
            statusWrap.appendChild(runningOp.status.root);
            row.appendChild(statusWrap);
          }

          const inlineErr = context.findingErrors.get(item.id);
          if (inlineErr) {
            const errLine = context.el('div', { class: 'finding-meta-line finding-inline-error' });
            errLine.appendChild(context.el('span', { class: 'findings-error-inline' }, inlineErr.message));
            if (inlineErr.backendUnsupported) {
              const jumpHandoffBtn = /** @type {HTMLButtonElement} */ (context.el('button', {
                class: 'run-link finding-handoff-link',
                type: 'button',
                onClick: () => context.openHandoffDialog([item.id], jumpHandoffBtn),
              }, '改用「复制修复任务」生成交接提示词 →'));
              errLine.appendChild(jumpHandoffBtn);
            }
            row.appendChild(errLine);
          }

          if (item.verification) {
            const v = item.verification;
            const metaLine = context.el('div', { class: 'finding-meta-line finding-verification' });
            const revoked = isOpenFinding && v.note === '补丁已撤销，需重新复核';
            metaLine.appendChild(context.el('span', { class: 'finding-verdict-badge' },
              revoked ? `复核结论已作废：${v.note}` : `复核：${v.verdict}`));
            if (v.note && !revoked) {
              metaLine.appendChild(context.el('span', { class: 'finding-verdict-note' }, v.note));
            }
            if (v.conflict) {
              metaLine.appendChild(context.el('span', {
                class: 'finding-verdict-conflict',
              }, `冲突未自动应用：${v.conflict}`));
            }
            row.appendChild(metaLine);
          }

          if (item.status === 'wontfix' && item.dismissal) {
            const d = item.dismissal;
            const reasonText = DISMISSAL_REASON_LABELS[d.reason] || d.reason;
            const dismissLine = context.el('div', { class: 'finding-meta-line finding-dismissal' });
            dismissLine.appendChild(context.el('span', {},
              `不处理原因：${reasonText}${d.note ? ` — ${d.note}` : ''}`));
            row.appendChild(dismissLine);
          }

          listEl.appendChild(row);
        }
      }
      panel.appendChild(listEl);
    }

    if (activeSuggestions.length) {
      const sugBox = context.el('div', { class: 'rule-suggestions-box' });
      sugBox.appendChild(context.el('div', { class: 'rule-suggestions-title' },
        `项目评审约定建议（${activeSuggestions.length} 条，源自多次相似「不处理」判定）`));

      for (const sug of activeSuggestions) {
        const card = context.el('div', {
          class: 'rule-suggestion-item',
          dataset: { suggestionId: sug.id },
        });
        const head = context.el('div', { class: 'rule-suggestion-head' });
        head.appendChild(context.el('span', { class: 'finding-category' }, sug.category || '其他'));
        head.appendChild(context.el('span', { class: 'rule-suggestion-scope' }, `范围：${sug.scope || './'}`));
        const reasonLabel = DISMISSAL_REASON_LABELS[sug.reason] || sug.reason;
        head.appendChild(context.el('span', { class: 'rule-suggestion-reason' },
          `原因：${reasonLabel}${sug.note ? `（${sug.note}）` : ''}`));
        card.appendChild(head);

        card.appendChild(context.el('div', { class: 'rule-suggestion-text' }, sug.representativeText));

        const actRow = context.el('div', { class: 'rule-suggestion-actions' });
        const copyRuleBtn = context.el('button', {
          class: 'btn finding-action-btn',
          type: 'button',
          onClick: () => {
            navigator.clipboard.writeText(sug.snippet || '')
              .then(() => context.toast('已复制规则到剪贴板', 'success'))
              .catch(() => context.toast('复制失败，请手动复制', 'error'));
          },
        }, '复制规则');

        const dismissSugBtn = /** @type {HTMLButtonElement} */ (context.el('button', {
          class: 'btn finding-action-btn',
          type: 'button',
          onClick: async () => {
            const folder = context.getFolder();
            if (!folder) return;
            dismissSugBtn.disabled = true;
            try {
              await context.api.checklistDismissRuleSuggestion({ folder, id: sug.id });
              if (context.getFolder() !== folder) return;
              await context.refreshSuggestions(folder);
              if (context.getFolder() !== folder) return;
              render();
            } catch (err) {
              dismissSugBtn.disabled = false;
              context.toast('忽略规则建议失败：' + context.errText(err), 'error');
            }
          },
        }, '忽略'));

        const appendBtn = /** @type {HTMLButtonElement} */ (context.el('button', {
          class: 'btn btn-primary finding-action-btn',
          type: 'button',
          onClick: () => context.openRuleAppendDialog(sug, appendBtn),
        }, '追加到 .reviewflow.md…'));

        actRow.appendChild(copyRuleBtn);
        actRow.appendChild(dismissSugBtn);
        actRow.appendChild(appendBtn);
        card.appendChild(actRow);
        sugBox.appendChild(card);
      }
      panel.appendChild(sugBox);
    }

    context.container.appendChild(panel);
  }

  return {
    get render() { return render; },
  };
}

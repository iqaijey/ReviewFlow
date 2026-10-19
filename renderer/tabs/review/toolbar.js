import { loadPlanContext, MODEL_FIELDS } from '../../lib/aiShared.js';

const DIMENSIONS = [
  '改动概述', '安全性', '结构问题', '影响面',
  '逻辑严谨性', '臃肿与冗余', '可扩展性', '可复用性',
];

export function createToolbar(context) {
  // ---------- 整体分析 ----------
  const toolbar = context.el('div', { class: 'review-toolbar' });
  const chips = context.el('div', { class: 'review-chips' });
  // 固定 8 维度 + 设置里的自定义维度（每行一个）+ 参照方案时追加「需求符合度」
  const parseCustomDimensions = (raw) =>
    String(raw || '').split('\n').map((t) => t.trim()).filter(Boolean);
  let cachedCustomDims = [];
  let activePlanTitle = '';
  // 评审预设：'' 表示「（当前设置）」，选中预设后 dimensions/customPrompt 对本次评审生效
  let cachedPresets = [];
  let activePresetId = '';
  const activePreset = () => cachedPresets.find((p) => p && p.id === activePresetId) || null;
  const activeDims = () => {
    const p = activePreset();
    return p && Array.isArray(p.dimensions)
      ? p.dimensions.map((d) => String(d || '').trim()).filter(Boolean)
      : cachedCustomDims;
  };
  const rebuildChips = () => {
    chips.textContent = '';
    const dims = activePlanTitle
      ? DIMENSIONS.concat(activeDims(), ['需求符合度'])
      : DIMENSIONS.concat(activeDims());
    for (const dim of dims) {
      const chip = context.el('button', { class: 'review-chip', type: 'button' }, dim);
      chip.addEventListener('click', () => {
        const target = context.findSection(dim);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      chips.appendChild(chip);
    }
  };
  let cachedCustomPrompt = '';
  const presetSelect = context.el('select', {
    class: 'settings-input review-preset-select', title: '评审预设：在 AI 设置中管理',
  });
  const rebuildPresetOptions = () => {
    presetSelect.textContent = '';
    presetSelect.appendChild(context.el('option', { value: '', text: '（当前设置）' }));
    for (const p of cachedPresets) {
      presetSelect.appendChild(context.el('option', { value: p.id, text: p.name || p.id }));
    }
    presetSelect.value = activePresetId;
    presetSelect.style.display = cachedPresets.length ? '' : 'none';
  };
  presetSelect.addEventListener('change', async () => {
    activePresetId = presetSelect.value;
    rebuildChips();
    context.scheduleEstimateRefresh();
    const preset = activePreset();
    if (!preset) return;
    // 应用预设的 AI 设置：backend 与思考强度写回设置，model 落到对应后端的字段
    const patch = {};
    const modelField = MODEL_FIELDS[preset.backend];
    if (modelField) {
      patch.backend = preset.backend;
      if (typeof preset.model === 'string') patch[modelField] = preset.model;
    }
    if (typeof preset.effort === 'string') patch.reasoningEffort = preset.effort;
    if (!Object.keys(patch).length) return;
    try {
      await context.api.saveSettings(patch);
      context.bus.dispatchEvent(new CustomEvent('settings:saved'));
      if (context.toast) context.toast(`已应用预设「${preset.name}」`);
    } catch (err) {
      context.toast('应用预设失败：' + context.errText(err), 'error');
    }
  });
  const loadDimensions = () => {
    context.api.getSettings()
      .then((s) => {
        syncMultiLabels(s);
        cachedCustomPrompt = (s && s.customPrompt) || '';
        cachedCustomDims = parseCustomDimensions(s && s.customDimensions);
        cachedPresets = (Array.isArray(s && s.presets) ? s.presets : [])
          .filter((p) => p && typeof p.id === 'string' && p.id);
        if (activePresetId && !cachedPresets.some((p) => p.id === activePresetId)) {
          activePresetId = '';
        }
        rebuildPresetOptions();
        rebuildChips();
      })
      .catch((err) => context.toast('读取评审设置失败：' + context.errText(err), 'error'));
  };
  // 有启用方案时在 tab 顶部提示；× 临时关闭参照（写 localStorage，不删方案）
  const refreshPlanHint = async () => {
    const folder = context.state.folder;
    const plan = await loadPlanContext(context.api, folder);
    if (context.state.folder !== folder) return;
    activePlanTitle = plan ? plan.title : '';
    rebuildChips();
    context.planHint.textContent = '';
    if (!plan) {
      context.planHint.style.display = 'none';
      return;
    }
    context.planHint.style.display = '';
    const hintSpan = context.el('span', {});
    hintSpan.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;margin-right:4px"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>';
    hintSpan.appendChild(document.createTextNode(`参照方案：${plan.title}`));
    context.planHint.appendChild(hintSpan);
    const closeBtn = context.el('button', {
      class: 'run-link', type: 'button',
      title: '临时关闭，评审时不再参照需求方案',
      'aria-label': '临时关闭参照需求方案',
    }, '×');
    closeBtn.addEventListener('click', () => {
      localStorage.setItem('planReviewEnabled', '0');
      refreshPlanHint();
      context.rehydrateFileAnalyses();
      context.scheduleEstimateRefresh();
    });
    context.planHint.appendChild(closeBtn);
  };
  rebuildChips();
  rebuildPresetOptions();
  loadDimensions();
  refreshPlanHint();
  context.bus.addEventListener('settings:saved', () => {
    loadDimensions();
    context.rehydrateFileAnalyses();
    context.scheduleEstimateRefresh();
  });

  // ---------- 多模型并行评审：勾选多个后端并行评审，再由指定模型汇总 ----------
  const MULTI_BACKENDS = [['api', 'API'], ['opencode', 'OpenCode'], ['kimi', 'Kimi CLI'], ['codex', 'Codex']];
  const MULTI_MODEL_FIELD = MODEL_FIELDS;
  let multiOn = localStorage.getItem('multiReviewEnabled') === '1';
  const multiToggle = context.el('button', {
    class: 'review-chip', type: 'button',
    title: '多个模型并行评审同一份改动，再由汇总模型合并为一份报告（各模型独立消耗 token）',
  }, '多模型');
  const multiRow = context.el('div', { class: 'review-multi-row', style: 'display:none' });
  /** @type {Map<string, HTMLInputElement>} */
  const multiBoxes = new Map();
  for (const [value, label] of MULTI_BACKENDS) {
    const box = context.el('input', { type: 'checkbox' });
    const item = context.el('label', { class: 'review-multi-item' });
    item.appendChild(box);
    item.appendChild(context.el('span', { class: 'review-multi-name' }, label));
    item.appendChild(context.el('span', { class: 'review-multi-model', dataset: { backend: value } }, ''));
    multiBoxes.set(value, box);
    multiRow.appendChild(item);
  }
  multiRow.appendChild(context.el('span', { class: 'toolbar-label' }, '汇总模型'));
  const synSelect = context.el('select', {
    class: 'settings-input review-preset-select', title: '用哪个模型把多份评审合并为最终报告',
  });
  for (const [value, label] of MULTI_BACKENDS) {
    synSelect.appendChild(context.el('option', { value, text: label }));
  }
  multiRow.appendChild(synSelect);
  multiRow.appendChild(context.el('span', { class: 'settings-hint' }, '并行评审互不影响，单个失败不阻断；token 独立计费'));

  const persistMulti = () => {
    localStorage.setItem('multiReviewModels',
      JSON.stringify([...multiBoxes].filter(([, b]) => b.checked).map(([v]) => v)));
    localStorage.setItem('multiReviewSynthesizer', synSelect.value);
    context.scheduleEstimateRefresh();
  };
  try {
    const saved = JSON.parse(localStorage.getItem('multiReviewModels') || '[]');
    for (const v of saved) {
      const box = multiBoxes.get(v);
      if (box) box.checked = true;
    }
  } catch { console.warn('读取多模型选项失败'); }
  if (localStorage.getItem('multiReviewSynthesizer')) {
    synSelect.value = localStorage.getItem('multiReviewSynthesizer');
  }
  for (const box of multiBoxes.values()) box.addEventListener('change', persistMulti);
  synSelect.addEventListener('change', persistMulti);
  const syncMultiToggle = () => {
    multiToggle.classList.toggle('active', multiOn);
    multiRow.style.display = multiOn ? '' : 'none';
  };
  multiToggle.addEventListener('click', () => {
    multiOn = !multiOn;
    localStorage.setItem('multiReviewEnabled', multiOn ? '1' : '0');
    syncMultiToggle();
    context.scheduleEstimateRefresh();
  });
  syncMultiToggle();
  // 复选框标注各后端配置的模型名；汇总模型未选过时默认当前后端
  const syncMultiLabels = (s) => {
    if (!s) return;
    for (const [value] of MULTI_BACKENDS) {
      const span = multiRow.querySelector(`[data-backend="${value}"]`);
      if (span) span.textContent = `（${s[MULTI_MODEL_FIELD[value]] || '默认模型'}）`;
    }
    if (!localStorage.getItem('multiReviewSynthesizer') && s.backend) {
      synSelect.value = s.backend;
    }
  };

  const noiseWrap = context.el('div', { class: 'review-noise-wrap' });
  noiseWrap.appendChild(context.el('label', {
    class: 'toolbar-label',
    for: 'review-noise-override',
  }, '噪声'));
  const noiseSelect = /** @type {HTMLSelectElement} */ (context.el('select', {
    id: 'review-noise-override',
    class: 'settings-input review-noise-select',
    title: '本次评审噪声等级（默认跟随 AI 设置）',
  }));
  for (const [value, text] of [
    ['', '跟随设置'],
    ['quiet', '安静'],
    ['balanced', '均衡'],
    ['detailed', '详尽'],
  ]) {
    noiseSelect.appendChild(context.el('option', { value, text }));
  }
  noiseWrap.appendChild(noiseSelect);
  const selectedNoiseOverride = () => {
    const v = noiseSelect.value;
    return v === 'quiet' || v === 'balanced' || v === 'detailed' ? v : undefined;
  };
  noiseSelect.addEventListener('change', () => {
    context.rehydrateFileAnalyses();
    context.scheduleEstimateRefresh();
  });

  const estimateBadge = context.el('span', {
    class: 'run-estimate-badge',
    style: 'display:none',
  });

  const startBtn = context.el('button', { class: 'btn btn-primary', type: 'button' }, '开始 AI 分析');    // 「对比上次评审」开关：开启且存在历史评审时，把最近一次评审结论带给 AI 做对比
  const prevLabel = context.el('label', {
    class: 'review-preset-toggle', title: '开启后，评审会带上最近一次评审的结论，追加「与上次对比」小节',
    style: 'display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:12px;color:var(--text-dim)',
  });
  const prevSwitch = context.el('input', { type: 'checkbox' });
  prevSwitch.checked = localStorage.getItem('reviewPrevEnabled') === '1';
  prevSwitch.addEventListener('change', () => {
    localStorage.setItem('reviewPrevEnabled', prevSwitch.checked ? '1' : '0');
  });
  prevLabel.appendChild(prevSwitch);
  prevLabel.appendChild(context.el('span', {}, '对比上次评审'));
  const runLink = context.el('button', {
    class: 'run-link', type: 'button', title: '查看当前运行 / 暂停与继续',
    onClick: () => context.ctx.showRunDetails(),
  }, '运行详情');
  toolbar.appendChild(chips);
  toolbar.appendChild(presetSelect);
  toolbar.appendChild(noiseWrap);
  toolbar.appendChild(prevLabel);
  toolbar.appendChild(multiToggle);
  toolbar.appendChild(estimateBadge);
  toolbar.appendChild(startBtn);
  toolbar.appendChild(runLink);
  context.overallPanel.appendChild(toolbar);
  context.overallPanel.appendChild(multiRow);

  return {
  get startBtn() { return startBtn; },
  get estimateBadge() { return estimateBadge; },
  get multiOn() { return multiOn; },
  set multiOn(value) { multiOn = value; },
  get multiBoxes() { return multiBoxes; },
  get selectedNoiseOverride() { return selectedNoiseOverride; },
  get synSelect() { return synSelect; },
  get activePreset() { return activePreset; },
  get cachedCustomPrompt() { return cachedCustomPrompt; },
  set cachedCustomPrompt(value) { cachedCustomPrompt = value; },
  get prevSwitch() { return prevSwitch; },
  get refreshPlanHint() { return refreshPlanHint; },
  };
}

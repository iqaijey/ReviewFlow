// AI 设置：分组卡片布局 —— 接入方式 / 模型与参数 / 评审内容 / 评审预设 / 个性化与应用
const DEFAULTS = {
  provider: 'openai-compatible',
  backend: 'api',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  opencodeModel: '',
  kimiModel: '',
  codexModel: '',
  customPrompt: '',
  customDimensions: '',
  reasoningEffort: '',
};

export default {
  id: 'settings',
  title: 'AI 设置',

  mount(container, ctx) {
    const { el, api, errText, bus } = ctx;

    const form = el('div', { class: 'settings-form' });

    const messageBox = el('div', { class: 'settings-message' });
    const showMessage = (text, ok) => {
      messageBox.textContent = '';
      messageBox.appendChild(el('div', {
        class: ok ? 'settings-msg-ok' : 'settings-msg-err',
      }, text));
    };

    // 分组卡片：标题 + 副标题说明 + 内容区
    const makeCard = (title, subtitle) => {
      const card = el('section', { class: 'settings-card' });
      const head = el('div', { class: 'settings-card-head' });
      head.appendChild(el('div', { class: 'settings-card-title' }, title));
      if (subtitle) head.appendChild(el('div', { class: 'settings-card-sub' }, subtitle));
      card.appendChild(head);
      return card;
    };

    const makeField = (labelText, node) => {
      const field = el('div', { class: 'settings-field' });
      field.appendChild(el('label', { class: 'settings-label' }, labelText));
      field.appendChild(node);
      return field;
    };

    // 模型行：手动输入框，拉取成功后切换为原生 select 下拉；「手动」可切回
    const makeModelRow = (placeholderText, fetchSettings) => {
      const wrap = el('div', { class: 'settings-key-wrap' });
      const input = el('input', {
        class: 'settings-input', type: 'text',
        placeholder: placeholderText, spellcheck: 'false',
      });
      const select = el('select', { class: 'settings-input settings-model-select' });
      select.style.display = 'none';
      const fetchBtn = el('button', { class: 'btn settings-key-toggle', type: 'button' }, '拉取模型');
      const manualBtn = el('button', { class: 'btn settings-key-toggle', type: 'button' }, '手动');
      manualBtn.style.display = 'none';
      wrap.appendChild(input);
      wrap.appendChild(select);
      if (fetchSettings) wrap.appendChild(fetchBtn);
      wrap.appendChild(manualBtn);

      let models = [];
      // 只有用户手动改过的值，拉取后才保留进下拉；默认回填值不进列表
      let userEdited = false;
      input.addEventListener('input', () => { userEdited = true; });

      const rebuildOptions = (preferValue) => {
        select.textContent = '';
        const ids = [...models];
        if (preferValue && userEdited && !ids.includes(preferValue)) ids.unshift(preferValue);
        for (const id of ids) {
          select.appendChild(el('option', { value: id, text: id }));
        }
        if (preferValue && [...select.options].some((o) => o.value === preferValue)) {
          select.value = preferValue;
        }
      };

      fetchBtn.addEventListener('click', async () => {
        fetchBtn.disabled = true;
        showMessage('正在拉取模型列表…', true);
        try {
          const ids = await api.listModels(fetchSettings());
          if (!ids.length) {
            showMessage('接口返回的模型列表为空', false);
            return;
          }
          models = ids;
          rebuildOptions(row.getValue());
          input.style.display = 'none';
          manualBtn.style.display = '';
          select.style.display = '';
          showMessage(`已拉取 ${ids.length} 个模型`, true);
        } catch (err) {
          showMessage(errText(err), false);
        } finally {
          fetchBtn.disabled = false;
        }
      });

      manualBtn.addEventListener('click', () => {
        input.value = select.value || input.value;
        select.style.display = 'none';
        manualBtn.style.display = 'none';
        input.style.display = '';
        input.focus();
      });

      const row = {
        element: wrap,
        getValue: () => (select.style.display === 'none' ? input.value.trim() : select.value),
        setValue: (v) => {
          input.value = v;
          if (select.style.display !== 'none') rebuildOptions(v);
        },
      };
      return row;
    };

    // ---------- 接入方式（卡片式选择器） ----------
    const BACKENDS = [
      ['api', 'API Key', 'OpenAI 兼容接口，需提供 API Key'],
      ['opencode', '本地 OpenCode', 'OpenCode / OMO CLI，无需 Key'],
      ['kimi', '本地 Kimi CLI', 'Kimi Code CLI，无需 Key'],
      ['codex', '本地 Codex CLI', 'Codex CLI 只读沙箱，无需 Key'],
    ];
    const backendGrid = el('div', { class: 'settings-backend-grid' });
    const radios = {};
    const backendCards = {};
    for (const [value, name, desc] of BACKENDS) {
      const radio = el('input', {
        type: 'radio', name: 'backend', value, id: `backend-${value}`, class: 'backend-radio',
      });
      radios[value] = radio;
      const card = el('label', { class: 'backend-card', for: `backend-${value}` });
      card.appendChild(radio);
      card.appendChild(el('div', { class: 'backend-card-name' }, name));
      card.appendChild(el('div', { class: 'backend-card-desc' }, desc));
      backendCards[value] = card;
      backendGrid.appendChild(card);
    }

    const currentBackend = () =>
      BACKENDS.find(([v]) => radios[v].checked)?.[0] || 'api';

    // ---------- API Key 方式：连接字段 ----------
    const apiConnFields = el('div', { class: 'settings-backend-fields' });

    const baseUrlInput = el('input', {
      class: 'settings-input', type: 'text',
      placeholder: DEFAULTS.baseUrl, spellcheck: 'false',
    });
    apiConnFields.appendChild(makeField('接口地址（Base URL）', baseUrlInput));

    const keyWrap = el('div', { class: 'settings-key-wrap' });
    const apiKeyInput = el('input', {
      class: 'settings-input', type: 'password',
      placeholder: 'sk-...', spellcheck: 'false', autocomplete: 'off',
    });
    const toggleKey = el('button', { class: 'btn settings-key-toggle', type: 'button' }, '显示');
    toggleKey.addEventListener('click', () => {
      const show = apiKeyInput.type === 'password';
      apiKeyInput.type = show ? 'text' : 'password';
      toggleKey.textContent = show ? '隐藏' : '显示';
    });
    keyWrap.appendChild(apiKeyInput);
    keyWrap.appendChild(toggleKey);
    apiConnFields.appendChild(makeField('API Key', keyWrap));

    apiConnFields.appendChild(el('div', { class: 'settings-hint' },
      '兼容 OpenAI Chat Completions 接口的服务均可使用（如 OpenAI、DeepSeek、Kimi 等）'));
    apiConnFields.appendChild(el('div', { class: 'settings-hint' },
      'API Key 仅保存在本机应用数据目录，不会上传到任何第三方'));

    // ---------- 本地 OpenCode 方式：说明 ----------
    const opencodeConnFields = el('div', { class: 'settings-backend-fields' });
    opencodeConnFields.appendChild(el('div', { class: 'settings-hint' },
      '通过本机 opencode CLI 执行评审，使用你在 OpenCode / OMO 中已配置好的模型与登录态'));
    opencodeConnFields.appendChild(el('div', { class: 'settings-hint' },
      '需已安装 opencode 命令行（brew install opencode），本地模型响应可能较慢，请耐心等待'));

    // ---------- 本地 Kimi CLI 方式：说明 ----------
    const kimiConnFields = el('div', { class: 'settings-backend-fields' });
    kimiConnFields.appendChild(el('div', { class: 'settings-hint' },
      '通过本机 kimi CLI 执行评审（kimi -p），使用你在 Kimi Code CLI 中已配置好的模型与登录态'));

    // ---------- 本地 Codex CLI 方式：说明 ----------
    const codexConnFields = el('div', { class: 'settings-backend-fields' });
    codexConnFields.appendChild(el('div', { class: 'settings-hint' },
      '通过本机 codex CLI 执行评审（codex exec），只读沙箱模式，不会修改项目文件'));
    codexConnFields.appendChild(el('div', { class: 'settings-hint' },
      '需已安装并登录 codex（brew install codex && codex login）'));

    const cardBackend = makeCard('接入方式', '选择评审的执行方式，切换后显示对应的连接配置');
    cardBackend.appendChild(backendGrid);
    cardBackend.appendChild(apiConnFields);
    cardBackend.appendChild(opencodeConnFields);
    cardBackend.appendChild(kimiConnFields);
    cardBackend.appendChild(codexConnFields);
    form.appendChild(cardBackend);

    const currentSettings = () => ({
      provider: 'openai-compatible',
      backend: currentBackend(),
      baseUrl: baseUrlInput.value.trim() || DEFAULTS.baseUrl,
      apiKey: apiKeyInput.value.trim(),
      model: modelRow.getValue() || DEFAULTS.model,
      opencodeModel: opencodeModelRow.getValue(),
      kimiModel: kimiModelRow.getValue(),
      codexModel: codexModelRow.getValue(),
      customPrompt: customPromptInput.value.trim(),
      customDimensions: customDimensionsInput.value.trim(),
      reasoningEffort: effortSelect.value,
      timeoutMin: Math.max(1, Math.round(Number(timeoutInput.value) || 10)),
    });

    // ---------- 各接入方式的模型字段 ----------
    const apiModelFields = el('div', { class: 'settings-backend-fields' });
    const modelRow = makeModelRow(DEFAULTS.model, () => ({
      ...currentSettings(), backend: 'api',
    }));
    apiModelFields.appendChild(makeField('模型（Model）', modelRow.element));

    const opencodeModelFields = el('div', { class: 'settings-backend-fields' });
    const opencodeModelRow = makeModelRow('provider/model，留空使用 opencode 默认模型', () => ({
      ...currentSettings(), backend: 'opencode',
    }));
    opencodeModelFields.appendChild(makeField('模型（可选）', opencodeModelRow.element));

    const kimiModelFields = el('div', { class: 'settings-backend-fields' });
    const kimiModelRow = makeModelRow('模型别名，留空使用 kimi 默认模型', () => ({
      ...currentSettings(), backend: 'kimi',
    }));
    kimiModelFields.appendChild(makeField('模型（可选）', kimiModelRow.element));

    const codexModelFields = el('div', { class: 'settings-backend-fields' });
    const codexModelRow = makeModelRow('如 gpt-5-codex，留空使用 codex 默认模型', () => ({
      ...currentSettings(), backend: 'codex',
    }));
    codexModelFields.appendChild(makeField('模型（可选）', codexModelRow.element));

    // ---------- 超时时间 ----------
    const timeoutInput = el('input', {
      class: 'settings-input', type: 'number', min: '1', max: '120',
      spellcheck: 'false',
    });
    timeoutInput.value = '10';
    const timeoutField = makeField('超时时间（分钟）', timeoutInput);
    timeoutField.appendChild(el('div', { class: 'settings-hint' },
      '慢模型或大批量评审可能需要更久，超时可调大（1~120），对四种接入方式都生效'));

    // ---------- 思考强度 ----------
    const effortSelect = el('select', { class: 'settings-input settings-model-select' });
    for (const [value, label] of [
      ['', '默认（不指定）'],
      ['minimal', 'minimal'],
      ['low', 'low'],
      ['medium', 'medium'],
      ['high', 'high'],
      ['max', 'max'],
    ]) {
      effortSelect.appendChild(el('option', { value, text: label }));
    }
    const effortField = makeField('思考强度（可选）', effortSelect);
    effortField.appendChild(el('div', { class: 'settings-hint' },
      'API 映射为 reasoning_effort，OpenCode 为 --variant，Codex 为 model_reasoning_effort；Kimi CLI 读取其 config.toml；统计以实际生效值为准'));

    const cardModel = makeCard('模型与参数', '当前接入方式使用的模型、思考强度与超时');
    cardModel.appendChild(apiModelFields);
    cardModel.appendChild(opencodeModelFields);
    cardModel.appendChild(kimiModelFields);
    cardModel.appendChild(codexModelFields);
    cardModel.appendChild(timeoutField);
    cardModel.appendChild(effortField);
    form.appendChild(cardModel);

    // ---------- 接入方式切换 ----------
    const backendFieldsMap = {
      api: [apiConnFields, apiModelFields],
      opencode: [opencodeConnFields, opencodeModelFields],
      kimi: [kimiConnFields, kimiModelFields],
      codex: [codexConnFields, codexModelFields],
    };
    const syncBackendFields = () => {
      const active = currentBackend();
      for (const [value, fieldsList] of Object.entries(backendFieldsMap)) {
        for (const fields of fieldsList) {
          fields.style.display = value === active ? '' : 'none';
        }
      }
      for (const [value, card] of Object.entries(backendCards)) {
        card.classList.toggle('selected', value === active);
      }
    };
    for (const radio of Object.values(radios)) {
      radio.addEventListener('change', syncBackendFields);
    }

    // ---------- 自定义检查维度 ----------
    const customDimensionsInput = el('textarea', {
      class: 'settings-input settings-textarea', rows: '3',
      placeholder: '例如：\n性能\n日志规范\n错误处理',
      spellcheck: 'false',
    });
    const customDimensionsField = makeField('自定义检查维度（可选，每行一个）', customDimensionsInput);
    customDimensionsField.appendChild(el('div', { class: 'settings-hint' },
      '会在多角度 Review 中追加为新的评审小节'));

    // ---------- 自定义评审要求 ----------
    const customPromptInput = el('textarea', {
      class: 'settings-input settings-textarea', rows: '4',
      placeholder: '例如：重点关注内存泄漏与线程安全；objc 项目检查 retain cycle',
      spellcheck: 'false',
    });
    const customPromptField = makeField('自定义评审要求（可选）', customPromptInput);
    customPromptField.appendChild(el('div', { class: 'settings-hint' },
      '会追加到 AI 评审的系统指令中，对所有接入方式都生效'));

    const cardContent = makeCard('评审内容', '追加到 AI 评审指令中的自定义内容');
    cardContent.appendChild(customDimensionsField);
    cardContent.appendChild(customPromptField);
    form.appendChild(cardContent);

    // ---------- 评审预设 ----------
    const MODEL_FIELD_BY_BACKEND = { api: 'model', opencode: 'opencodeModel', kimi: 'kimiModel', codex: 'codexModel' };
    const modelRowByBackend = { api: modelRow, opencode: opencodeModelRow, kimi: kimiModelRow, codex: codexModelRow };
    let cachedPresets = [];

    const cardPreset = makeCard('评审预设', '把当前评审配置存为预设，可在多角度 Review 工具栏一键选用');
    const presetSaveRow = el('div', { class: 'preset-save-row' });
    const presetNameInput = el('input', {
      class: 'settings-input', type: 'text',
      placeholder: '预设名称，如：安全审查', spellcheck: 'false',
    });
    const savePresetBtn = el('button', { class: 'btn', type: 'button' }, '把当前设置存为预设');
    presetSaveRow.appendChild(presetNameInput);
    presetSaveRow.appendChild(savePresetBtn);
    cardPreset.appendChild(presetSaveRow);
    const presetList = el('div', { class: 'preset-list' });
    cardPreset.appendChild(presetList);
    cardPreset.appendChild(el('div', { class: 'settings-hint' },
      '预设记录当前的自定义维度、自定义评审要求、接入方式、模型与思考强度，仅保存在本机'));
    form.appendChild(cardPreset);

    const persistPresets = async (okText) => {
      try {
        await api.saveSettings({ presets: cachedPresets });
        bus.dispatchEvent(new CustomEvent('settings:saved'));
        if (okText) showMessage(okText, true);
        return true;
      } catch (err) {
        showMessage(`预设保存失败：${errText(err)}`, false);
        return false;
      }
    };

    // 应用预设：写回设置并同步表单控件
    const applyPreset = async (preset) => {
      const patch = {};
      const backend = MODEL_FIELD_BY_BACKEND[preset.backend] ? preset.backend : null;
      if (backend) {
        patch.backend = backend;
        if (typeof preset.model === 'string') patch[MODEL_FIELD_BY_BACKEND[backend]] = preset.model;
      }
      if (typeof preset.effort === 'string') patch.reasoningEffort = preset.effort;
      if (Array.isArray(preset.dimensions)) {
        patch.customDimensions = preset.dimensions.map((d) => String(d || '').trim()).filter(Boolean).join('\n');
      }
      if (typeof preset.customPrompt === 'string') patch.customPrompt = preset.customPrompt;
      try {
        await api.saveSettings(patch);
      } catch (err) {
        showMessage(`应用预设失败：${errText(err)}`, false);
        return;
      }
      if (backend) {
        (radios[backend] || radios.api).checked = true;
        syncBackendFields();
        if (typeof preset.model === 'string') modelRowByBackend[backend].setValue(preset.model);
      }
      if (typeof preset.effort === 'string') effortSelect.value = preset.effort;
      if (Array.isArray(preset.dimensions)) customDimensionsInput.value = patch.customDimensions;
      if (typeof preset.customPrompt === 'string') customPromptInput.value = preset.customPrompt;
      bus.dispatchEvent(new CustomEvent('settings:saved'));
      showMessage(`已应用预设「${preset.name}」`, true);
    };

    const renderPresetList = () => {
      presetList.textContent = '';
      if (!cachedPresets.length) {
        presetList.appendChild(el('div', { class: 'empty-hint' }, '暂无预设'));
        return;
      }
      for (const preset of cachedPresets) {
        const row = el('div', { class: 'preset-item' });
        row.appendChild(el('span', { class: 'preset-name' }, preset.name || preset.id));
        const meta = [
          BACKENDS.find(([v]) => v === preset.backend)?.[1],
          preset.model,
          preset.effort ? `思考 ${preset.effort}` : '',
        ].filter(Boolean).join(' · ');
        if (meta) row.appendChild(el('span', { class: 'preset-meta' }, meta));
        const applyBtn = el('button', { class: 'btn', type: 'button' }, '应用');
        applyBtn.addEventListener('click', () => applyPreset(preset));
        const delBtn = el('button', { class: 'btn', type: 'button' }, '删除');
        delBtn.addEventListener('click', async () => {
          cachedPresets = cachedPresets.filter((p) => p.id !== preset.id);
          renderPresetList();
          await persistPresets('预设已删除');
        });
        row.appendChild(applyBtn);
        row.appendChild(delBtn);
        presetList.appendChild(row);
      }
    };
    renderPresetList();

    savePresetBtn.addEventListener('click', async () => {
      const name = presetNameInput.value.trim();
      if (!name) {
        showMessage('请先填写预设名称', false);
        return;
      }
      const backend = currentBackend();
      const preset = {
        id: `p${Date.now().toString(36)}`,
        name,
        dimensions: customDimensionsInput.value.split('\n').map((t) => t.trim()).filter(Boolean),
        customPrompt: customPromptInput.value.trim(),
        backend,
        model: modelRowByBackend[backend].getValue(),
        effort: effortSelect.value,
      };
      cachedPresets = cachedPresets.concat([preset]);
      presetNameInput.value = '';
      renderPresetList();
      await persistPresets(`预设「${name}」已保存`);
    });

    // ---------- 个性化与应用 ----------
    const cardApp = makeCard('个性化与应用', '应用图标、版本与更新');

    const iconField = el('div', { class: 'settings-field' });
    iconField.appendChild(el('label', { class: 'settings-label' }, '应用图标'));
    const iconRow = el('div', { class: 'icon-row' });
    const iconPreview = el('img', { class: 'icon-preview', alt: '' });
    iconPreview.style.display = 'none';
    const iconPlaceholder = el('div', { class: 'icon-preview icon-placeholder' }, '默认');
    const pickIconBtn = el('button', { class: 'btn', type: 'button' }, '选择图片…');
    const resetIconBtn = el('button', { class: 'btn', type: 'button' }, '恢复默认');
    resetIconBtn.style.display = 'none';
    iconRow.appendChild(iconPlaceholder);
    iconRow.appendChild(iconPreview);
    iconRow.appendChild(pickIconBtn);
    iconRow.appendChild(resetIconBtn);
    iconField.appendChild(iconRow);
    iconField.appendChild(el('div', { class: 'settings-hint' },
      '选择正方形图片效果最佳；立即更新 Dock 图标，打包版同时写入应用包（Finder/Launchpad）'));
    cardApp.appendChild(iconField);

    const refreshIconUI = (preview) => {
      if (preview) {
        iconPreview.src = preview;
        iconPreview.style.display = '';
        iconPlaceholder.style.display = 'none';
        resetIconBtn.style.display = '';
      } else {
        iconPreview.style.display = 'none';
        iconPlaceholder.style.display = '';
        resetIconBtn.style.display = 'none';
      }
    };
    if (typeof api.currentIcon === 'function') {
      api.currentIcon().then(refreshIconUI).catch(() => {});
    }
    pickIconBtn.addEventListener('click', async () => {
      try {
        const picked = await api.pickIconImage();
        if (!picked) return;
        const { bundleUpdated } = await api.applyIcon(picked.path);
        refreshIconUI(picked.preview);
        ctx.toast(bundleUpdated
          ? '图标已更新（Dock 与应用包）'
          : 'Dock 图标已更新（应用包无写入权限，Finder 图标未变）');
      } catch (err) {
        showMessage(`设置图标失败：${errText(err)}`, false);
      }
    });
    resetIconBtn.addEventListener('click', async () => {
      try {
        await api.resetIcon();
        refreshIconUI(null);
        ctx.toast('已恢复默认图标');
      } catch (err) {
        showMessage(`恢复图标失败：${errText(err)}`, false);
      }
    });

    // ---------- 版本与更新 ----------
    const versionField = el('div', { class: 'settings-field update-field' });
    versionField.appendChild(el('label', { class: 'settings-label' }, '版本与更新'));
    const versionRow = el('div', { class: 'update-row' });
    const versionEl = el('div', { class: 'settings-version' }, '');
    const checkBtn = el('button', { class: 'btn', type: 'button' }, '检查更新');
    versionRow.appendChild(versionEl);
    versionRow.appendChild(checkBtn);
    versionField.appendChild(versionRow);
    const updateStatus = el('div', { class: 'update-status' });
    versionField.appendChild(updateStatus);
    cardApp.appendChild(versionField);
    form.appendChild(cardApp);

    let currentVersionText = '';
    if (typeof api.getVersion === 'function') {
      api.getVersion().then((v) => {
        currentVersionText = `ReviewFlow v${v}`;
        versionEl.textContent = currentVersionText;
      }).catch(() => {});
    }

    /** @type {(() => void) | null} */
    let offProgress = null;
    const setProgress = (percent, bar, label) => {
      bar.style.width = `${percent}%`;
      label.textContent = `${percent}%`;
    };

    const showUpdateAvailable = (info, { interactive }) => {
      updateStatus.textContent = '';
      updateStatus.appendChild(el('div', { class: 'settings-msg-ok' },
        `发现新版本 v${info.latestVersion}`));
      if (info.notes) {
        const notes = String(info.notes).slice(0, 500);
        updateStatus.appendChild(el('pre', { class: 'update-notes' }, notes));
      }
      if (!info.dmgUrl) {
        updateStatus.appendChild(el('div', { class: 'settings-msg-err' },
          '该版本未提供 arm64 安装包'));
        return;
      }
      if (!interactive) return;

      const downloadBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '下载更新');
      const progressWrap = el('div', { class: 'update-progress' });
      progressWrap.style.display = 'none';
      const progressBar = el('div', { class: 'update-progress-bar' });
      const progressLabel = el('span', { class: 'update-progress-label' }, '');
      progressWrap.appendChild(progressBar);
      progressWrap.appendChild(progressLabel);
      updateStatus.appendChild(downloadBtn);
      updateStatus.appendChild(progressWrap);

      const startDownload = async () => {
        downloadBtn.disabled = true;
        downloadBtn.textContent = '正在下载…';
        progressWrap.style.display = '';
        setProgress(0, progressBar, progressLabel);
        if (offProgress) offProgress();
        offProgress = api.onUpdateProgress((percent) => {
          setProgress(percent, progressBar, progressLabel);
        });
        try {
          await api.downloadUpdate(info.dmgUrl);
          ctx.toast('下载完成，已打开安装包，拖入「应用程序」完成更新');
          downloadBtn.textContent = '重新打开安装包';
        } catch (err) {
          if (offProgress) {
            offProgress();
            offProgress = null;
          }
          progressWrap.style.display = 'none';
          updateStatus.appendChild(el('div', { class: 'settings-msg-err' }, errText(err)));
          downloadBtn.textContent = '重试下载';
        } finally {
          downloadBtn.disabled = false;
        }
      };
      downloadBtn.addEventListener('click', startDownload);
    };

    const runCheck = async ({ silent }) => {
      try {
        const info = await api.checkUpdates();
        if (!info.hasUpdate) {
          if (!silent) {
            updateStatus.textContent = '';
            updateStatus.appendChild(el('div', { class: 'settings-msg-ok' }, '已是最新版本'));
          }
          return;
        }
        if (silent) {
          ctx.notify('发现新版本', `ReviewFlow v${info.latestVersion} 可用，前往「AI 设置」更新`);
        } else {
          showUpdateAvailable(info, { interactive: true });
        }
      } catch (err) {
        if (!silent) {
          updateStatus.textContent = '';
          updateStatus.appendChild(el('div', { class: 'settings-msg-err' }, errText(err)));
        }
      }
    };

    checkBtn.addEventListener('click', async () => {
      checkBtn.disabled = true;
      updateStatus.textContent = '';
      updateStatus.appendChild(el('div', { class: 'settings-msg-ok' }, '正在检查更新…'));
      try {
        await runCheck({ silent: false });
      } finally {
        checkBtn.disabled = false;
      }
    });

    if (typeof api.checkUpdates === 'function') {
      runCheck({ silent: true });
    }

    // ---------- 吸底操作条 ----------
    const actions = el('div', { class: 'settings-actions' });
    const saveBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '保存');
    const testBtn = el('button', { class: 'btn', type: 'button' }, '测试连接');
    actions.appendChild(saveBtn);
    actions.appendChild(testBtn);
    actions.appendChild(messageBox);
    form.appendChild(actions);

    container.appendChild(form);

    api.getSettings().then((s) => {
      const merged = { ...DEFAULTS, ...(s || {}) };
      (radios[merged.backend] || radios.api).checked = true;
      syncBackendFields();
      baseUrlInput.value = merged.baseUrl;
      apiKeyInput.value = merged.apiKey;
      modelRow.setValue(merged.model);
      opencodeModelRow.setValue(merged.opencodeModel);
      kimiModelRow.setValue(merged.kimiModel || '');
      codexModelRow.setValue(merged.codexModel || '');
      customPromptInput.value = merged.customPrompt || '';
      customDimensionsInput.value = merged.customDimensions || '';
      cachedPresets = (Array.isArray(merged.presets) ? merged.presets : [])
        .filter((p) => p && typeof p.id === 'string' && p.id);
      renderPresetList();
      effortSelect.value = merged.reasoningEffort || '';
      timeoutInput.value = String(merged.timeoutMin || 10);
    }).catch(() => {
      radios.api.checked = true;
      syncBackendFields();
      baseUrlInput.value = DEFAULTS.baseUrl;
      modelRow.setValue(DEFAULTS.model);
    });

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        await api.saveSettings(currentSettings());
        showMessage('已保存', true);
        bus.dispatchEvent(new CustomEvent('settings:saved'));
      } catch (err) {
        showMessage(`保存失败：${errText(err)}`, false);
      } finally {
        saveBtn.disabled = false;
      }
    });

    testBtn.addEventListener('click', async () => {
      testBtn.disabled = true;
      messageBox.textContent = '';
      const loadingMsg = el('div', { class: 'settings-msg-ok' });
      loadingMsg.appendChild(el('span', { class: 'spinner spinner-inline' }));
      loadingMsg.appendChild(document.createTextNode(' 正在测试连接… '));
      loadingMsg.appendChild(el('button', {
        class: 'run-link', type: 'button',
        onClick: () => ctx.showRunDetails(),
      }, '运行详情'));
      messageBox.appendChild(loadingMsg);
      try {
        const result = await api.testConnection(currentSettings());
        showMessage(result.message, !!result.ok);
      } catch (err) {
        showMessage(`测试失败：${errText(err)}`, false);
      } finally {
        testBtn.disabled = false;
      }
    });
  },
};

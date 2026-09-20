// AI 设置：接入方式（API Key / 本地 OpenCode）+ 各方式的参数配置
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
  reasoningEffort: '',
};

export default {
  id: 'settings',
  title: 'AI 设置',

  mount(container, ctx) {
    const { el, api, errText } = ctx;

    const form = el('div', { class: 'settings-form' });

    const showMessage = (text, ok) => {
      messageBox.textContent = '';
      messageBox.appendChild(el('div', {
        class: ok ? 'settings-msg-ok' : 'settings-msg-err',
      }, text));
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

    // ---------- 接入方式 ----------
    const BACKENDS = [
      ['api', ' API Key（OpenAI 兼容接口）'],
      ['opencode', ' 本地 OpenCode / OMO（无需 Key）'],
      ['kimi', ' 本地 Kimi CLI（无需 Key）'],
      ['codex', ' 本地 Codex CLI（无需 Key）'],
    ];
    const backendField = el('div', { class: 'settings-field' });
    backendField.appendChild(el('label', { class: 'settings-label' }, '接入方式'));
    const backendGroup = el('div', { class: 'settings-backend-group' });
    const radios = {};
    for (const [value, label] of BACKENDS) {
      const radio = el('input', {
        type: 'radio', name: 'backend', value, id: `backend-${value}`,
      });
      radios[value] = radio;
      const option = el('label', { class: 'settings-backend-option', for: `backend-${value}` });
      option.appendChild(radio);
      option.appendChild(document.createTextNode(label));
      backendGroup.appendChild(option);
    }
    backendField.appendChild(backendGroup);
    form.appendChild(backendField);

    const currentBackend = () =>
      BACKENDS.find(([v]) => radios[v].checked)?.[0] || 'api';

    const makeField = (labelText, node) => {
      const field = el('div', { class: 'settings-field' });
      field.appendChild(el('label', { class: 'settings-label' }, labelText));
      field.appendChild(node);
      return field;
    };

    // ---------- API Key 方式 ----------
    const apiFields = el('div', { class: 'settings-backend-fields' });

    const baseUrlInput = el('input', {
      class: 'settings-input', type: 'text',
      placeholder: DEFAULTS.baseUrl, spellcheck: 'false',
    });
    apiFields.appendChild(makeField('接口地址（Base URL）', baseUrlInput));

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
    apiFields.appendChild(makeField('API Key', keyWrap));

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
      reasoningEffort: effortSelect.value,
    });

    const modelRow = makeModelRow(DEFAULTS.model, () => ({
      ...currentSettings(), backend: 'api',
    }));
    apiFields.appendChild(makeField('模型（Model）', modelRow.element));

    apiFields.appendChild(el('div', { class: 'settings-hint' },
      '兼容 OpenAI Chat Completions 接口的服务均可使用（如 OpenAI、DeepSeek、Kimi 等）'));
    apiFields.appendChild(el('div', { class: 'settings-hint' },
      'API Key 仅保存在本机应用数据目录，不会上传到任何第三方'));
    form.appendChild(apiFields);

    // ---------- 本地 OpenCode 方式 ----------
    const opencodeFields = el('div', { class: 'settings-backend-fields' });

    const opencodeModelRow = makeModelRow('provider/model，留空使用 opencode 默认模型', () => ({
      ...currentSettings(), backend: 'opencode',
    }));
    opencodeFields.appendChild(makeField('模型（可选）', opencodeModelRow.element));

    opencodeFields.appendChild(el('div', { class: 'settings-hint' },
      '通过本机 opencode CLI 执行评审，使用你在 OpenCode / OMO 中已配置好的模型与登录态'));
    opencodeFields.appendChild(el('div', { class: 'settings-hint' },
      '需已安装 opencode 命令行（brew install opencode），本地模型响应可能较慢，请耐心等待'));
    form.appendChild(opencodeFields);

    // ---------- 本地 Kimi CLI 方式 ----------
    const kimiFields = el('div', { class: 'settings-backend-fields' });
    const kimiModelRow = makeModelRow('模型别名，留空使用 kimi 默认模型', () => ({
      ...currentSettings(), backend: 'kimi',
    }));
    kimiFields.appendChild(makeField('模型（可选）', kimiModelRow.element));
    kimiFields.appendChild(el('div', { class: 'settings-hint' },
      '通过本机 kimi CLI 执行评审（kimi -p），使用你在 Kimi Code CLI 中已配置好的模型与登录态'));
    form.appendChild(kimiFields);

    // ---------- 本地 Codex CLI 方式 ----------
    const codexFields = el('div', { class: 'settings-backend-fields' });
    const codexModelRow = makeModelRow('如 gpt-5-codex，留空使用 codex 默认模型', () => ({
      ...currentSettings(), backend: 'codex',
    }));
    codexFields.appendChild(makeField('模型（可选）', codexModelRow.element));
    codexFields.appendChild(el('div', { class: 'settings-hint' },
      '通过本机 codex CLI 执行评审（codex exec），只读沙箱模式，不会修改项目文件'));
    codexFields.appendChild(el('div', { class: 'settings-hint' },
      '需已安装并登录 codex（brew install codex && codex login）'));
    form.appendChild(codexFields);

    // ---------- 接入方式切换 ----------
    const backendFieldsMap = {
      api: apiFields, opencode: opencodeFields, kimi: kimiFields, codex: codexFields,
    };
    const syncBackendFields = () => {
      const active = currentBackend();
      for (const [value, fields] of Object.entries(backendFieldsMap)) {
        fields.style.display = value === active ? '' : 'none';
      }
    };
    for (const radio of Object.values(radios)) {
      radio.addEventListener('change', syncBackendFields);
    }

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
    form.appendChild(effortField);

    // ---------- 自定义评审要求 ----------
    const customPromptInput = el('textarea', {
      class: 'settings-input settings-textarea', rows: '4',
      placeholder: '例如：重点关注内存泄漏与线程安全；objc 项目检查 retain cycle',
      spellcheck: 'false',
    });
    const customPromptField = makeField('自定义评审要求（可选）', customPromptInput);
    customPromptField.appendChild(el('div', { class: 'settings-hint' },
      '会追加到 AI 评审的系统指令中，对两种接入方式都生效'));
    form.appendChild(customPromptField);

    // ---------- 操作区 ----------
    const actions = el('div', { class: 'settings-actions' });
    const saveBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '保存');
    const testBtn = el('button', { class: 'btn', type: 'button' }, '测试连接');
    actions.appendChild(saveBtn);
    actions.appendChild(testBtn);
    form.appendChild(actions);

    const messageBox = el('div', { class: 'settings-message' });
    form.appendChild(messageBox);

    container.appendChild(form);

    // ---------- 应用图标 ----------
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
    container.appendChild(iconField);

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
    container.appendChild(versionField);

    let currentVersionText = '';
    if (typeof api.getVersion === 'function') {
      api.getVersion().then((v) => {
        currentVersionText = `ReviewFlow v${v}`;
        versionEl.textContent = currentVersionText;
      }).catch(() => {});
    }

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
      effortSelect.value = merged.reasoningEffort || '';
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

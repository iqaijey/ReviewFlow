// 需求方案：上传 PRD + 设计稿 → AI 生成技术方案，作为后续评审依据
import { renderMarkdown } from '../markdown.js';

const BACKEND_LABELS = { api: 'API', opencode: 'OpenCode', kimi: 'Kimi CLI', codex: 'Codex' };

function formatStats(stats) {
  const parts = [];
  if (stats && stats.backend) parts.push(BACKEND_LABELS[stats.backend] || stats.backend);
  if (stats && stats.model) parts.push(stats.model);
  if (stats && stats.backend) parts.push(stats.effort ? `思考 ${stats.effort}` : '默认强度');
  if (stats && stats.promptTokens != null && stats.completionTokens != null) {
    parts.push(`${(stats.promptTokens + stats.completionTokens).toLocaleString()} tokens`);
  }
  if (stats && stats.durationMs != null) {
    parts.push(`${(stats.durationMs / 1000).toFixed(1)}s`);
  }
  return parts.join(' · ');
}

const readAsText = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || ''));
  reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
  reader.readAsText(file);
});

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result || ''));
  reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
  reader.readAsDataURL(file);
});

export default {
  id: 'plan',
  title: '需求方案',

  mount(container, ctx) {
    const { el, bus, state, api, errText, notify, toast } = ctx;

    const supported = typeof api.listPlans === 'function' &&
      typeof api.createPlan === 'function' && typeof api.generatePlan === 'function';

    // ---------- 顶部工具栏：评审开关 + 运行详情 ----------
    const toolbar = el('div', { class: 'review-toolbar' });
    const switchInput = el('input', { type: 'checkbox' });
    switchInput.checked = localStorage.getItem('planReviewEnabled') !== '0';
    switchInput.addEventListener('change', () => {
      localStorage.setItem('planReviewEnabled', switchInput.checked ? '1' : '0');
      toast(switchInput.checked ? '评审时将参照当前方案' : '已关闭评审参照方案');
    });
    const switchLabel = el('label', { class: 'plan-switch' });
    switchLabel.appendChild(switchInput);
    switchLabel.appendChild(el('span', { class: 'plan-switch-track' }));
    switchLabel.appendChild(el('span', {}, '评审时参照方案'));
    const runLink = el('button', {
      class: 'run-link', type: 'button', title: '查看当前运行 / 暂停与继续',
      onClick: () => ctx.showRunDetails(),
    }, '运行详情');
    toolbar.appendChild(switchLabel);
    toolbar.appendChild(runLink);
    container.appendChild(toolbar);

    // ---------- 编辑区 ----------
    const editor = el('div', { class: 'plan-editor' });

    const formRow = el('div', { class: 'plan-form-row' });
    const titleInput = el('input', {
      class: 'settings-input', type: 'text',
      placeholder: '方案标题（留空用 PRD 文件名）', spellcheck: 'false',
    });
    const prdInput = el('input', { type: 'file', accept: '.md,.markdown,.txt' });
    prdInput.style.display = 'none';
    const prdBtn = el('button', {
      class: 'btn', type: 'button', onClick: () => prdInput.click(),
    }, '选择 PRD 文档…');
    const imgInput = el('input', { type: 'file', accept: 'image/*', multiple: 'multiple' });
    imgInput.style.display = 'none';
    const imgBtn = el('button', {
      class: 'btn', type: 'button', onClick: () => imgInput.click(),
    }, '上传设计稿…');
    const genBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '生成方案');
    formRow.appendChild(titleInput);
    formRow.appendChild(prdBtn);
    formRow.appendChild(imgBtn);
    formRow.appendChild(genBtn);
    formRow.appendChild(prdInput);
    formRow.appendChild(imgInput);
    editor.appendChild(formRow);

    const extraInput = el('input', {
      class: 'settings-input', type: 'text',
      placeholder: '额外要求（可选），例如：优先考虑现有架构、给出分阶段落地计划',
      spellcheck: 'false',
    });
    editor.appendChild(extraInput);

    const currentLine = el('div', { class: 'plan-current' }, '尚未创建方案，请先选择 PRD 文档');
    editor.appendChild(currentLine);

    const prdDetails = el('details', { class: 'plan-prd' });
    const prdSummary = el('summary', {}, 'PRD 内容预览');
    const prdPre = el('pre', {});
    prdDetails.appendChild(prdSummary);
    prdDetails.appendChild(prdPre);
    prdDetails.style.display = 'none';
    editor.appendChild(prdDetails);

    const thumbWall = el('div', { class: 'plan-thumbs' });
    editor.appendChild(thumbWall);

    container.appendChild(editor);

    const statusBox = el('div', { class: 'review-status' });
    const resultBox = el('div', { class: 'md plan-result' });
    container.appendChild(statusBox);
    container.appendChild(resultBox);

    // ---------- 方案列表 ----------
    const listTitle = el('div', { class: 'plan-list-title' }, '历史方案');
    const listBox = el('div', { class: 'plan-list' });
    container.appendChild(listTitle);
    container.appendChild(listBox);

    // 当前编辑中的方案（新建草稿或从历史载入）
    let editing = null; // { planId, title, prdFileName, prdText, images: [{name, dataUrl}] }
    let running = false;

    const setStatus = (node) => {
      statusBox.textContent = '';
      if (node) statusBox.appendChild(node);
    };

    const loadingNode = () => {
      const loading = el('div', { class: 'review-loading' });
      loading.appendChild(el('span', { class: 'spinner' }));
      loading.appendChild(el('span', {}, 'AI 正在生成技术方案，请稍候…'));
      loading.appendChild(el('button', {
        class: 'run-link', type: 'button',
        onClick: () => ctx.showRunDetails(),
      }, '运行详情'));
      return loading;
    };

    const refreshButtons = () => {
      const noFolder = !state.folder;
      const disabled = noFolder || !supported;
      titleInput.disabled = disabled;
      prdBtn.disabled = disabled || running;
      imgBtn.disabled = disabled || running || !editing;
      genBtn.disabled = disabled || running || !editing || !editing.prdText;
    };

    const renderEditing = () => {
      if (!editing) {
        currentLine.textContent = '尚未创建方案，请先选择 PRD 文档';
        prdDetails.style.display = 'none';
        thumbWall.textContent = '';
        refreshButtons();
        return;
      }
      currentLine.textContent = `当前方案：${editing.title}（PRD：${editing.prdFileName}，` +
        `设计稿 ${editing.images.length} 张）`;
      prdSummary.textContent = `PRD 内容预览 · ${editing.prdFileName}`;
      prdPre.textContent = editing.prdText;
      prdDetails.style.display = '';
      thumbWall.textContent = '';
      for (const img of editing.images) {
        const thumb = el('div', { class: 'plan-thumb', title: img.name });
        thumb.appendChild(el('img', { src: img.dataUrl, alt: img.name }));
        thumb.appendChild(el('button', {
          class: 'plan-thumb-del', type: 'button', title: '删除该设计稿',
          onClick: () => removeImage(img.name),
        }, '×'));
        thumb.appendChild(el('div', { class: 'plan-thumb-name' }, img.name));
        thumbWall.appendChild(thumb);
      }
      refreshButtons();
    };

    const clearEditing = () => {
      editing = null;
      titleInput.value = '';
      renderEditing();
    };

    // ---------- 方案列表 ----------
    const expandCard = async (card, body, plan) => {
      const opening = body.style.display === 'none';
      body.style.display = opening ? '' : 'none';
      if (!opening || body.dataset.loaded) return;
      body.dataset.loaded = '1';
      let detail = null;
      try {
        detail = await api.getPlanDetail(state.folder, plan.id);
      } catch (err) {
        body.appendChild(el('div', { class: 'error-text' }, `加载方案失败：${errText(err)}`));
        return;
      }
      const actions = el('div', { class: 'plan-card-actions' });
      const activeBtn = el('button', { class: 'btn', type: 'button' },
        detail.active ? '取消当前方案' : '设为当前方案');
      activeBtn.addEventListener('click', async () => {
        try {
          await api.setActivePlan(state.folder, detail.active ? null : detail.id);
          bus.dispatchEvent(new CustomEvent('plan:changed'));
          toast(detail.active ? '已取消当前方案' : `已将「${detail.title}」设为当前方案`);
          loadList();
        } catch (err) {
          alert('操作失败：' + errText(err));
        }
      });
      const editBtn = el('button', { class: 'btn', type: 'button' }, '载入编辑');
      editBtn.addEventListener('click', () => {
        editing = {
          planId: detail.id,
          title: detail.title,
          prdFileName: detail.prdFileName,
          prdText: detail.prdText,
          images: (detail.images || []).map((img) => ({ name: img.name, dataUrl: img.dataUrl })),
        };
        titleInput.value = detail.title;
        renderEditing();
        container.scrollTop = 0;
        toast(`已载入「${detail.title}」，可补充设计稿后重新生成`);
      });
      const delBtn = el('button', { class: 'btn plan-del-btn', type: 'button' }, '删除');
      delBtn.addEventListener('click', async () => {
        if (!confirm(`确定删除方案「${detail.title}」？该操作不可恢复`)) return;
        try {
          await api.deletePlan(state.folder, detail.id);
          bus.dispatchEvent(new CustomEvent('plan:changed'));
          if (editing && editing.planId === detail.id) clearEditing();
          toast('方案已删除');
          loadList();
        } catch (err) {
          alert('删除失败：' + errText(err));
        }
      });
      actions.appendChild(activeBtn);
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      body.appendChild(actions);
      if (detail.planMarkdown) {
        const mdNode = el('div', { class: 'md' });
        mdNode.innerHTML = renderMarkdown(detail.planMarkdown);
        body.appendChild(mdNode);
      } else {
        body.appendChild(el('div', { class: 'empty-hint' },
          '该方案尚未生成技术方案，可点击「载入编辑」后生成'));
      }
    };

    const loadList = async () => {
      listBox.textContent = '';
      if (!state.folder) {
        listBox.appendChild(el('div', { class: 'empty-hint' }, '请先选择项目文件夹'));
        return;
      }
      if (!supported) {
        listBox.appendChild(el('div', { class: 'error-text' },
          '当前版本不支持需求方案功能（缺少 plan 相关接口）'));
        return;
      }
      let plans = [];
      try {
        plans = await api.listPlans(state.folder);
      } catch (err) {
        listBox.appendChild(el('div', { class: 'error-text' },
          `加载方案列表失败：${errText(err)}`));
        return;
      }
      if (!plans || !plans.length) {
        listBox.appendChild(el('div', { class: 'empty-hint' },
          '暂无方案，上传 PRD 文档与设计稿后点击「生成方案」'));
        return;
      }
      for (const plan of plans) {
        const card = el('div', { class: `plan-card${plan.active ? ' active' : ''}` });
        const head = el('button', { class: 'plan-card-head', type: 'button' });
        if (plan.active) head.appendChild(el('span', { class: 'plan-badge plan-badge-active' }, '当前'));
        head.appendChild(el('span', { class: 'plan-badge ' +
          (plan.hasPlan ? 'plan-badge-done' : 'plan-badge-draft') },
          plan.hasPlan ? '已生成' : '未生成'));
        head.appendChild(el('span', { class: 'plan-card-title' }, plan.title));
        head.appendChild(el('span', { class: 'plan-card-meta' },
          `${new Date(plan.createdAt).toLocaleString()} · ${plan.prdFileName || '无 PRD'} · ` +
          `图 ${plan.imageCount || 0}`));
        const body = el('div', { class: 'plan-card-body', style: 'display:none' });
        head.addEventListener('click', () => expandCard(card, body, plan));
        card.appendChild(head);
        card.appendChild(body);
        listBox.appendChild(card);
      }
    };

    // ---------- PRD 选择：创建方案草稿 ----------
    prdInput.addEventListener('change', async () => {
      const file = prdInput.files && prdInput.files[0];
      prdInput.value = '';
      if (!file || !state.folder) return;
      prdBtn.disabled = true;
      try {
        const prdText = await readAsText(file);
        if (!prdText.trim()) {
          alert('PRD 文档内容为空');
          return;
        }
        const title = titleInput.value.trim() || file.name.replace(/\.[^.]+$/, '');
        const meta = await api.createPlan({
          folder: state.folder, title, prdFileName: file.name, prdText,
        });
        editing = { planId: meta.id, title, prdFileName: file.name, prdText, images: [] };
        titleInput.value = title;
        resultBox.textContent = '';
        setStatus(null);
        renderEditing();
        loadList();
        toast(`已创建方案草稿「${title}」，可继续上传设计稿`);
      } catch (err) {
        alert('创建方案失败：' + errText(err));
      } finally {
        prdBtn.disabled = false;
        refreshButtons();
      }
    });

    // ---------- 设计稿上传 ----------
    imgInput.addEventListener('change', async () => {
      const files = [...(imgInput.files || [])];
      imgInput.value = '';
      if (!files.length) return;
      if (!state.folder || !editing) {
        toast('请先选择 PRD 文档创建方案');
        return;
      }
      imgBtn.disabled = true;
      let added = 0;
      try {
        for (const file of files) {
          const dataUrl = await readAsDataUrl(file);
          const base64 = dataUrl.split(',')[1] || '';
          await api.addPlanImage({
            folder: state.folder, planId: editing.planId, name: file.name, base64,
          });
          editing.images.push({ name: file.name, dataUrl });
          added++;
        }
        renderEditing();
        loadList();
      } catch (err) {
        alert(`上传设计稿失败：${errText(err)}`);
      } finally {
        imgBtn.disabled = false;
        refreshButtons();
        if (added) toast(`已添加 ${added} 张设计稿`);
      }
    });

    const removeImage = async (name) => {
      if (!editing || !state.folder) return;
      try {
        await api.removePlanImage({ folder: state.folder, planId: editing.planId, name });
        editing.images = editing.images.filter((img) => img.name !== name);
        renderEditing();
        loadList();
      } catch (err) {
        alert('删除设计稿失败：' + errText(err));
      }
    };

    // ---------- 生成方案（流式） ----------
    const run = async () => {
      if (running || !state.folder || !editing || !editing.prdText) return;
      running = true;
      refreshButtons();
      resultBox.textContent = '';
      setStatus(loadingNode());
      const runId = `run-${Date.now()}`;
      const streamBox = el('div', { class: 'stream-preview plan-stream' });
      const unsubscribe = typeof api.onAiChunk === 'function'
        ? api.onAiChunk(({ runId: chunkRunId, text }) => {
            if (chunkRunId !== runId) return;
            if (!streamBox.parentNode) resultBox.appendChild(streamBox);
            streamBox.innerHTML = renderMarkdown(text);
          })
        : null;
      try {
        const { markdown, stats } = await api.generatePlan({
          folder: state.folder,
          planId: editing.planId,
          extraRequirement: extraInput.value.trim(),
          runId,
        });
        setStatus(null);
        resultBox.innerHTML = renderMarkdown(markdown);
        resultBox.appendChild(el('div', { class: 'ai-stats' }, formatStats(stats)));
        const copyBtnEl = el('button', { class: 'btn', type: 'button' }, '复制');
        copyBtnEl.addEventListener('click', () => {
          navigator.clipboard.writeText(markdown)
            .then(() => toast('已复制到剪贴板'))
            .catch(() => { /* 剪贴板不可用时静默 */ });
        });
        const btnGroup = el('div', { class: 'export-group' });
        btnGroup.appendChild(copyBtnEl);
        resultBox.appendChild(btnGroup);
        notify('技术方案生成完成', `「${editing.title}」已生成，可在下方列表设为当前方案`);
        bus.dispatchEvent(new CustomEvent('plan:changed'));
        loadList();
      } catch (err) {
        if (errText(err).includes('已被用户终止')) {
          setStatus(el('div', { class: 'empty-hint' }, '已终止，可点击「生成方案」重新开始'));
        } else {
          setStatus(el('div', { class: 'error-text' }, `生成失败：${errText(err)}`));
          notify('技术方案生成失败', errText(err));
        }
      } finally {
        if (unsubscribe) unsubscribe();
        streamBox.remove();
        running = false;
        refreshButtons();
      }
    };

    genBtn.addEventListener('click', run);

    // 文件夹切换后重新加载列表，并丢弃属于旧项目的编辑状态
    bus.addEventListener('changes:loaded', () => {
      clearEditing();
      resultBox.textContent = '';
      setStatus(null);
      loadList();
    });

    renderEditing();
    loadList();
  },
};

// 设置页「外部 Agent 接口」卡片：开关、MCP 配置、HTTP 令牌
import { confirmDialog } from '../../lib/dialog.js';

/**
 * @param {{
 *   el: (tag: string, attrs?: Record<string, any>, children?: any) => HTMLElement,
 *   api: AutoReviewApi,
 *   errText: (err: any) => string,
 *   makeCard: (title: string, subtitle?: string) => HTMLElement,
 *   makeInlineStatus: () => { box: HTMLElement, show: (text: string, ok?: boolean) => void },
 * }} deps
 */
export function createAgentApiCard({ el, api, errText, makeCard, makeInlineStatus }) {
  const card = makeCard('外部 Agent 接口',
    '让 Claude Code、Codex、OpenCode 等 Agent 通过 MCP 或本机 HTTP 操作 ReviewFlow：评审、问题清单、补丁、复核、方案、设置等界面能做的都能做');
  if (typeof api.agentApiInfo !== 'function') return card;

  const switchLabel = el('label', { class: 'plan-switch' });
  const enabledInput = /** @type {HTMLInputElement} */ (el('input', { type: 'checkbox' }));
  switchLabel.appendChild(enabledInput);
  switchLabel.appendChild(el('span', { class: 'plan-switch-track' }));
  const stateText = el('span', {}, '读取中…');
  switchLabel.appendChild(stateText);
  const status = makeInlineStatus();
  const stateRow = el('div', { class: 'icon-row' });
  stateRow.appendChild(switchLabel);
  stateRow.appendChild(status.box);
  const stateField = el('div', { class: 'settings-field' });
  stateField.appendChild(el('label', { class: 'settings-label' }, '状态'));
  stateField.appendChild(stateRow);
  stateField.appendChild(el('div', { class: 'settings-hint' },
    '接口与界面权限相同（含应用补丁、清空清单、读取 API Key），调用不再弹确认。只监听 127.0.0.1，需令牌访问；令牌泄露等同交出这些权限。'));
  card.appendChild(stateField);

  const mcpPre = el('pre', { class: 'findings-preview-box' }, '');
  const copyMcpBtn = el('button', { class: 'btn', type: 'button' }, '复制 MCP 配置');
  const mcpField = el('div', { class: 'settings-field' });
  mcpField.appendChild(el('label', { class: 'settings-label' }, 'MCP 配置'));
  mcpField.appendChild(mcpPre);
  mcpField.appendChild(el('div', { class: 'settings-hint' },
    '这是 Claude Code（.mcp.json）等通用的 mcpServers 格式；OpenCode、Codex 的写法见 README。ReviewFlow 未运行时会被自动启动。'));
  const mcpActions = el('div', { class: 'settings-section-actions' });
  mcpActions.appendChild(copyMcpBtn);
  mcpField.appendChild(mcpActions);
  card.appendChild(mcpField);

  const httpPre = el('pre', { class: 'findings-preview-box' }, '');
  const copyTokenBtn = el('button', { class: 'btn', type: 'button' }, '复制令牌');
  const copyCurlBtn = /** @type {HTMLButtonElement} */ (el('button', { class: 'btn', type: 'button' }, '复制 curl 示例'));
  const regenBtn = el('button', { class: 'btn', type: 'button' }, '重新生成令牌');
  const httpField = el('div', { class: 'settings-field' });
  httpField.appendChild(el('label', { class: 'settings-label' }, 'HTTP 接口'));
  httpField.appendChild(httpPre);
  const configHint = el('div', { class: 'settings-hint' }, '');
  httpField.appendChild(configHint);
  const httpActions = el('div', { class: 'settings-section-actions' });
  httpActions.appendChild(copyTokenBtn);
  httpActions.appendChild(copyCurlBtn);
  httpActions.appendChild(regenBtn);
  httpField.appendChild(httpActions);
  card.appendChild(httpField);

  /** @type {AgentApiInfo | null} */
  let info = null;

  const curlExample = () => {
    if (!info || !info.url) return '';
    return `curl -s -H "Authorization: Bearer ${info.token}" ${info.url}/v1/tools\n\n`
      + `curl -s -X POST -H "Authorization: Bearer ${info.token}" -H "Content-Type: application/json" \\\n`
      + `  -d '{"folder":"/path/to/project"}' ${info.url}/v1/tools/checklist_list`;
  };

  /** @param {AgentApiInfo} next */
  const render = (next) => {
    info = next;
    enabledInput.checked = next.enabled;
    stateText.textContent = next.running && next.url
      ? `运行中 · ${next.url} · ${next.toolCount} 个工具`
      : next.enabled ? '已启用，但未能启动（端口不可用或启动失败）' : '已关闭';
    mcpPre.textContent = JSON.stringify(next.mcpConfig, null, 2);
    httpPre.textContent = next.url
      ? `地址：${next.url}\n请求头：Authorization: Bearer <令牌>\n\nGET  /v1/health\nGET  /v1/tools            工具列表与参数说明\nPOST /v1/tools/<工具名>   请求体为 JSON 参数`
      : '接口未运行';
    configHint.textContent = `端口与令牌保存在 ${next.configFile}（权限 600），外部脚本可从中读取当前地址与令牌。`;
    copyCurlBtn.disabled = !next.url;
  };

  /** @param {string} text @param {string} done */
  const copy = (text, done) => {
    navigator.clipboard.writeText(text)
      .then(() => status.show(done, true))
      .catch(() => status.show('复制失败，请手动选中复制', false));
  };

  api.agentApiInfo().then(render).catch((err) => status.show(`读取接口状态失败：${errText(err)}`, false));

  enabledInput.addEventListener('change', async () => {
    enabledInput.disabled = true;
    try {
      render(await api.agentApiSetEnabled(enabledInput.checked));
      status.show(enabledInput.checked ? '已启用' : '已关闭', true);
    } catch (err) {
      enabledInput.checked = !enabledInput.checked;
      status.show(`切换失败：${errText(err)}`, false);
    } finally {
      enabledInput.disabled = false;
    }
  });
  copyMcpBtn.addEventListener('click', () => { if (info) copy(JSON.stringify(info.mcpConfig, null, 2), '已复制 MCP 配置'); });
  copyTokenBtn.addEventListener('click', () => { if (info) copy(info.token, '已复制令牌'); });
  copyCurlBtn.addEventListener('click', () => copy(curlExample(), '已复制 curl 示例'));
  regenBtn.addEventListener('click', async () => {
    if (!(await confirmDialog({
      title: '重新生成令牌',
      message: '旧令牌会立即失效，使用 HTTP 接口的脚本需要换成新令牌（MCP 桥会自动读取新令牌）。',
      confirmText: '重新生成',
      danger: true,
    }))) return;
    try {
      render(await api.agentApiRegenerateToken());
      status.show('令牌已重新生成', true);
    } catch (err) {
      status.show(`重新生成失败：${errText(err)}`, false);
    }
  });

  return card;
}

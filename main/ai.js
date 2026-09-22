const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getSettings } = require('./settings');
const { readKimiConfig, readCodexConfig } = require('./cliConfig');

const STATUS_LABELS = {
  modified: '修改',
  added: '新增',
  deleted: '删除',
  renamed: '重命名',
};

const CLI_CANDIDATES = {
  opencode: ['/opt/homebrew/bin/opencode', '/usr/local/bin/opencode'],
  kimi: [`${os.homedir()}/.kimi-code/bin/kimi`, '/opt/homebrew/bin/kimi', '/usr/local/bin/kimi'],
  codex: ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'],
};

const CLI_LABELS = { opencode: 'OpenCode', kimi: 'Kimi CLI', codex: 'Codex' };

function resolveCliBin(backend) {
  for (const p of CLI_CANDIDATES[backend] || []) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* 继续尝试下一个 */ }
  }
  return null;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function cliEnv() {
  return {
    ...process.env,
    PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
  };
}

// 各 CLI 后端的命令构建（prompt 经临时文件 + shell 命令替换传入，防引号注入）
function buildCliCmd(backend, cfg, folder, tmpFile) {
  const bin = shellQuote(resolveCliBin(backend));
  const prompt = `"$(cat ${shellQuote(tmpFile)})"`;
  if (backend === 'opencode') {
    let cmd = `${bin} run`;
    if (cfg.opencodeModel) cmd += ` -m ${shellQuote(cfg.opencodeModel)}`;
    if (cfg.reasoningEffort) cmd += ` --variant ${shellQuote(cfg.reasoningEffort)}`;
    if (folder) cmd += ` --dir ${shellQuote(folder)}`;
    return `${cmd} ${prompt} < /dev/null`;
  }
  if (backend === 'kimi') {
    let cmd = `${bin} -p ${prompt}`;
    if (cfg.kimiModel) cmd += ` -m ${shellQuote(cfg.kimiModel)}`;
    return `${cmd} < /dev/null`;
  }
  // codex：只读沙箱，评审不能改项目文件；跳过 git 仓库信任检查
  let cmd = `${bin} exec --sandbox read-only --skip-git-repo-check`;
  if (folder) cmd += ` --cd ${shellQuote(folder)}`;
  if (cfg.codexModel) cmd += ` --model ${shellQuote(cfg.codexModel)}`;
  if (cfg.reasoningEffort) cmd += ` -c model_reasoning_effort=${shellQuote(cfg.reasoningEffort)}`;
  return `${cmd} ${prompt} < /dev/null`;
}

// 供「运行详情」展示的命令形态（不含临时文件路径）
function cliCmdLabel(backend, cfg, folder) {
  const bin = resolveCliBin(backend) || backend;
  const parts = [bin];
  if (backend === 'opencode') {
    parts.push('run');
    if (cfg.opencodeModel) parts.push('-m', cfg.opencodeModel);
    if (cfg.reasoningEffort) parts.push('--variant', cfg.reasoningEffort);
    if (folder) parts.push('--dir', folder);
  } else if (backend === 'kimi') {
    parts.push('-p', '<prompt>');
    if (cfg.kimiModel) parts.push('-m', cfg.kimiModel);
  } else {
    parts.push('exec', '--sandbox', 'read-only', '--skip-git-repo-check');
    if (folder) parts.push('--cd', folder);
    if (cfg.codexModel) parts.push('--model', cfg.codexModel);
    if (cfg.reasoningEffort) parts.push('-c', `model_reasoning_effort=${cfg.reasoningEffort}`);
  }
  parts.push('< /dev/null');
  return parts.join(' ');
}

// 当前正在进行的 AI 调用（供渲染进程「运行详情」轮询预览）
let currentRun = null;

// 暂停/继续：分批循环每批开始前检查 pauseRequested，暂停时把续跑状态存进 pausedState
let pauseRequested = false;
let pausedState = null;
let batchRunActive = false;

function getCurrentRun() {
  if (currentRun) return currentRun;
  if (pausedState) {
    return {
      paused: true,
      kind: pausedState.kind,
      batch: `已暂停，第 ${pausedState.nextIndex}/${pausedState.batches.length} 批`,
      batchIndex: pausedState.nextIndex,
      batchTotal: pausedState.batches.length,
      startedAt: pausedState.pausedAt,
    };
  }
  return null;
}

function pauseRun() {
  pauseRequested = true;
  return batchRunActive;
}

// 从 pausedState 的 nextIndex 继续原分批循环；无暂停状态返回 null
async function resumeRun() {
  const state = pausedState;
  if (!state) return null;
  pausedState = null;
  const cfg = await getSettings();
  batchRunActive = true;
  try {
    if (state.kind === 'full') {
      return await runFullBatches(cfg, state);
    }
    return await runOverviewBatches(cfg, state);
  } finally {
    batchRunActive = false;
  }
}

// 流式输出的推送方：main.js 注册，fn(runId, 累计文本) 转发给渲染进程
let chunkSender = null;
function setChunkSender(fn) {
  chunkSender = typeof fn === 'function' ? fn : null;
}

// 请求超时（分钟），默认 10，可在设置里调大；慢模型/大批量评审需要更久
function timeoutMs(cfg) {
  const min = Number(cfg && cfg.timeoutMin);
  return (min > 0 ? min : 10) * 60_000;
}

// 终止当前运行：API 中断 fetch，CLI 杀进程组；同时清掉暂停状态
let currentCancel = null;
function cancelRun() {
  pausedState = null;
  pauseRequested = false;
  if (currentCancel) {
    currentCancel();
    currentCancel = null;
    return true;
  }
  return false;
}

function cancelledError() {
  const err = new Error('已被用户终止');
  err.cancelled = true;
  return err;
}

function killProcessGroup(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
  }
}

// 通过本机 CLI（opencode / kimi / codex）完成对话，使用各 CLI 已配置好的模型与登录态。
// 注意：直接 execFile 这些二进制会挂起（疑似其进程/会话检测），必须经 bash 启动。
function chatViaCli(backend, cfg, messages, folder) {
  if (!resolveCliBin(backend)) {
    const guide = backend === 'codex'
      ? '未找到 codex 命令行，请先安装（brew install codex）并运行 codex login'
      : backend === 'kimi'
        ? '未找到 kimi 命令行，请先安装 Kimi Code CLI'
        : '未找到 opencode 命令行，请先安装（brew install opencode）';
    return Promise.reject(new Error(guide));
  }
  const text = messages
    .map((m) => (m.role === 'system' ? `【系统指令】\n${m.content}` : m.content))
    .join('\n\n');
  const tmpFile = path.join(
    os.tmpdir(),
    `auto-review-prompt-${process.pid}-${Date.now()}.txt`,
  );
  const cmd = buildCliCmd(backend, cfg, folder, tmpFile);
  const cliTimeout = timeoutMs(cfg);
  return new Promise((resolve, reject) => {
    fs.writeFile(tmpFile, text, 'utf8', (werr) => {
      if (werr) {
        reject(new Error(`无法写入临时 prompt 文件: ${werr.message}`));
        return;
      }
      let timedOut = false;
      // detached 让子进程自成进程组，取消/超时时整组杀掉（含 bash 孙进程里的 CLI）
      const child = execFile(
        cmd,
        { shell: '/bin/bash', maxBuffer: 10 * 1024 * 1024, env: cliEnv(), detached: true },
        (err, stdout, stderr) => {
          clearTimeout(timer);
          fs.unlink(tmpFile, () => {});
          const label = CLI_LABELS[backend] || backend;
          if (err) {
            if (cancelledByUser) {
              reject(cancelledError());
              return;
            }
            const raw = String(stderr || err.message || '')
              .replace(/\x1b\[[0-9;]*m/g, '');
            if (backend === 'codex' && /login|auth|unauthorized|token/i.test(raw)) {
              reject(new Error('Codex CLI 未登录，请先在终端运行 codex login 完成授权'));
            } else if (timedOut || err.killed) {
              reject(new Error(
                `${label} 执行超时（当前上限 ${Math.round(cliTimeout / 60000)} 分钟），` +
                '可在「AI 设置」中调大超时时间',
              ));
            } else {
              reject(new Error(`${label} 执行失败: ${raw.slice(0, 300)}`));
            }
            return;
          }
          const content = String(stdout || '').trim();
          if (!content) {
            reject(new Error(`${label} 没有返回内容，请检查本地模型配置`));
            return;
          }
          resolve(content);
        },
      );
      let cancelledByUser = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessGroup(child);
      }, cliTimeout);
      currentCancel = () => {
        cancelledByUser = true;
        killProcessGroup(child);
      };
    });
  });
}

// 解析 OpenAI 兼容的 SSE 流式响应：逐行读取 data: 事件，累加 delta.content，
// 每收到一段就把累计全文推给渲染进程；usage 取流末尾带 usage 的 chunk（stream_options.include_usage）
async function readSseStream(resp, runId) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage = {};
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (chunk && chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage;
      const delta = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      const piece = delta && typeof delta.content === 'string' ? delta.content : '';
      if (piece) {
        content += piece;
        if (chunkSender && runId) chunkSender(runId, content);
      }
    }
  }
  if (!content) throw new Error('AI 返回格式异常，无法解析响应内容');
  return { content, usage };
}

async function chatWithStats(settings, messages, { maxTokens = 1024, temperature = 0.2, folder = null, kind = 'AI 调用', batch = '', batchIndex = null, batchTotal = null, runId = null, stream = false } = {}) {
  const cfg = settings || (await getSettings());
  const startedAt = Date.now();
  // 多模态消息（content 为数组）只提取文本部分用于运行详情展示
  const promptText = messages.map((m) => {
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map((p) => (p && p.type === 'text' ? p.text : '[图片]')).join('\n');
    }
    return String(m.content || '');
  }).join('\n\n');
  if (cfg.backend === 'opencode' || cfg.backend === 'kimi' || cfg.backend === 'codex') {
    // 模型与思考强度以 CLI 实际配置为准：未覆盖时读取各 CLI 的 config.toml
    let model = '默认模型';
    let effort = cfg.reasoningEffort || '';
    if (cfg.backend === 'opencode') {
      model = cfg.opencodeModel || '默认模型';
    } else if (cfg.backend === 'kimi') {
      const kimiCfg = readKimiConfig();
      model = cfg.kimiModel || kimiCfg.defaultModel || '默认模型';
      // kimi CLI 无 effort 参数，实际值来自其 config.toml 的 [thinking] effort
      effort = cfg.reasoningEffort || kimiCfg.effort || '';
    } else {
      const codexCfg = readCodexConfig();
      model = cfg.codexModel || codexCfg.defaultModel || '默认模型';
      effort = cfg.reasoningEffort || codexCfg.effort || '';
    }
    currentRun = {
      kind, batch, batchIndex, batchTotal, backend: cfg.backend, model, effort,
      command: cliCmdLabel(cfg.backend, cfg, folder),
      promptChars: promptText.length, promptText, startedAt,
    };
    try {
      const content = await chatViaCli(cfg.backend, cfg, messages, folder);
      return {
        content,
        stats: {
          backend: cfg.backend,
          model,
          effort,
          promptTokens: null,
          completionTokens: null,
          durationMs: Date.now() - startedAt,
        },
      };
    } finally {
      currentRun = null;
      currentCancel = null;
    }
  }
  if (!cfg.apiKey) throw new Error('请先在「AI 设置」中配置 API Key');
  const url = `${String(cfg.baseUrl || '').replace(/\/+$/, '')}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  };
  let appliedEffort = cfg.reasoningEffort || '';
  const body = {
    model: cfg.model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (appliedEffort) body.reasoning_effort = appliedEffort;
  // 仅 API 分支支持流式；CLI 分支忽略该选项
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  currentRun = {
    kind, batch, batchIndex, batchTotal, backend: 'api', model: cfg.model, effort: appliedEffort,
    command: `POST ${url}`,
    promptChars: promptText.length, promptText, startedAt,
  };
  const controller = new AbortController();
  currentCancel = () => controller.abort();
  const send = () => fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs(cfg)), controller.signal]),
  });
  try {
    let resp = await send();
    if (!resp.ok) {
      let detail = (await resp.text()).slice(0, 300);
      // 服务商不支持 reasoning_effort 时去掉重试
      if (resp.status === 400 && /reasoning/i.test(detail) && body.reasoning_effort) {
        delete body.reasoning_effort;
        appliedEffort = '';
        resp = await send();
        if (!resp.ok) detail = (await resp.text()).slice(0, 300);
      }
      // 部分模型（如 Kimi 思考模型）只允许 temperature=1，去掉该参数用服务商默认值重试
      if (resp.status === 400 && /temperature/i.test(detail) && 'temperature' in body) {
        delete body.temperature;
        resp = await send();
        if (!resp.ok) detail = (await resp.text()).slice(0, 300);
      }
      if (!resp.ok) {
        throw new Error(`AI 请求失败 (${resp.status}): ${detail || resp.statusText}`);
      }
    }
    if (stream) {
      const { content, usage } = await readSseStream(resp, runId);
      return {
        content,
        stats: {
          backend: 'api',
          model: cfg.model,
          effort: appliedEffort,
          promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null,
          completionTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null,
          durationMs: Date.now() - startedAt,
        },
      };
    }
    const data = await resp.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;
    if (typeof content !== 'string') throw new Error('AI 返回格式异常，无法解析响应内容');
    const usage = data && data.usage ? data.usage : {};
    return {
      content,
      stats: {
        backend: 'api',
        model: cfg.model,
        effort: appliedEffort,
        promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null,
        completionTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null,
        durationMs: Date.now() - startedAt,
      },
    };
  } catch (err) {
    if (controller.signal.aborted) throw cancelledError();
    throw err;
  } finally {
    currentRun = null;
    currentCancel = null;
  }
}

async function chat(settings, messages, options) {
  const { content } = await chatWithStats(settings, messages, options);
  return content;
}

// 多次调用的 stats 聚合：token 求和（全为 null 则 null），耗时求和
function aggregateStats(list) {
  const sumToken = (key) => {
    let total = 0;
    let seen = false;
    for (const s of list) {
      if (s && typeof s[key] === 'number') {
        total += s[key];
        seen = true;
      }
    }
    return seen ? total : null;
  };
  return {
    backend: list.length && list[0] ? list[0].backend : null,
    model: list.length && list[0] ? list[0].model : null,
    effort: list.length && list[0] ? list[0].effort : '',
    promptTokens: sumToken('promptTokens'),
    completionTokens: sumToken('completionTokens'),
    durationMs: list.reduce((t, s) => t + ((s && s.durationMs) || 0), 0),
  };
}

function withCustomPrompt(system, cfg) {
  const extra = cfg && typeof cfg.customPrompt === 'string' ? cfg.customPrompt.trim() : '';
  return extra ? `${system}\n额外评审要求（必须遵守）：${extra}` : system;
}

// 一次性自定义要求重跑：非空时替代设置里的 customPrompt（不写回设置）
function applyPromptOverride(cfg, customPromptOverride) {
  const override = typeof customPromptOverride === 'string' ? customPromptOverride.trim() : '';
  return override ? { ...cfg, customPrompt: override } : cfg;
}

// 需求方案上下文（评审依据）：非字符串或空白串时不注入
function normalizePlanContext(planContext) {
  return typeof planContext === 'string' && planContext.trim() ? planContext.trim() : '';
}

// 拉取 opencode 本机可用模型列表（provider/model 每行一个）
function listOpencodeModels() {
  const bin = resolveCliBin('opencode');
  if (!bin) {
    return Promise.reject(new Error('未找到 opencode 命令行，请先安装（brew install opencode）'));
  }
  const cmd = `${shellQuote(bin)} models < /dev/null`;
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      { shell: '/bin/bash', maxBuffer: 5 * 1024 * 1024, timeout: 60_000, env: cliEnv() },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message || '').slice(0, 300);
          reject(new Error(`opencode models 执行失败: ${detail}`));
          return;
        }
        const ids = String(stdout || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        resolve([...new Set(ids)].sort());
      },
    );
  });
}

// 拉取 codex 模型目录（codex debug models 输出 JSON）
function listCodexModels() {
  if (!resolveCliBin('codex')) {
    return Promise.reject(new Error('未找到 codex 命令行，请先安装（brew install codex）'));
  }
  const cmd = `${shellQuote(resolveCliBin('codex'))} debug models < /dev/null`;
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      { shell: '/bin/bash', maxBuffer: 10 * 1024 * 1024, timeout: 60_000, env: cliEnv() },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`codex 获取模型列表失败: ${String(stderr || err.message || '').slice(0, 300)}`));
          return;
        }
        try {
          const data = JSON.parse(String(stdout));
          const slugs = (Array.isArray(data.models) ? data.models : [])
            .filter((m) => m && m.visibility === 'list' && m.slug)
            .map((m) => m.slug);
          resolve([...new Set(slugs)]);
        } catch {
          reject(new Error('codex 模型列表解析失败'));
        }
      },
    );
  });
}

// 拉取可用模型列表：api 走 OpenAI 兼容的 GET /models，opencode 走本机 CLI
async function listModels(settings) {
  const cfg = settings || (await getSettings());
  if (cfg.backend === 'opencode') {
    return listOpencodeModels();
  }
  if (cfg.backend === 'kimi') {
    const { models } = readKimiConfig();
    if (!models.length) throw new Error('未从 Kimi CLI 配置中读取到模型列表');
    return models;
  }
  if (cfg.backend === 'codex') {
    return listCodexModels();
  }
  if (!cfg.apiKey) throw new Error('请先填写 API Key');
  const url = `${String(cfg.baseUrl || '').replace(/\/+$/, '')}/models`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 300);
    throw new Error(`拉取模型列表失败 (${resp.status}): ${detail || resp.statusText}`);
  }
  const data = await resp.json();
  const ids = (Array.isArray(data.data) ? data.data : [])
    .map((m) => m && m.id)
    .filter((id) => typeof id === 'string' && id);
  return [...new Set(ids)].sort();
}

function hunkToDiffText(hunk) {
  const prefix = { add: '+', del: '-', context: ' ' };
  const body = hunk.lines.map((l) => `${prefix[l.type] || ' '}${l.content}`).join('\n');
  return `${hunk.header}\n${body}`;
}

function fileToDiffText(file) {
  const status = STATUS_LABELS[file.status] || file.status;
  const hunks = (file.hunks || []).map(hunkToDiffText).join('\n');
  return `文件: ${file.path} (${status})\n${hunks}`;
}

const CONTEXT_BLOCK_MAX_LINES = 200;
const CONTEXT_MAX_CHARS = 4000;

// 读取被改动的类/函数在当前文件中的完整定义，作为评审上下文（diff 只含改动片段）。
// 文件被删除、不存在或读取失败时返回空串。
function buildContext(folder, file) {
  if (!folder || !file || !file.path || file.status === 'deleted') return '';
  const targets = (Array.isArray(file.classes) ? file.classes : [])
    .filter((c) => c && c.changed && c.startLine > 0 && c.endLine >= c.startLine);
  if (!targets.length) return '';
  let lines;
  try {
    lines = fs.readFileSync(path.join(folder, file.path), 'utf8').split('\n');
  } catch {
    return '';
  }
  const blocks = [];
  for (const c of targets) {
    const end = Math.min(c.endLine, lines.length);
    const start = Math.min(c.startLine, end);
    let slice = lines.slice(start - 1, end);
    let note = '';
    if (slice.length > CONTEXT_BLOCK_MAX_LINES) {
      slice = slice.slice(0, CONTEXT_BLOCK_MAX_LINES);
      note = '\n（定义过长已截断）';
    }
    blocks.push(
      `### ${c.name}（${file.path}:${c.startLine}-${c.endLine}）\n` +
      `\`\`\`\n${slice.join('\n')}${note}\n\`\`\`\n`,
    );
  }
  let out = blocks.join('\n');
  if (out.length > CONTEXT_MAX_CHARS) {
    out = `${out.slice(0, CONTEXT_MAX_CHARS)}\n（上下文过长已截断）`;
  }
  return out;
}

// diff 文本 + 被改动类/函数的完整定义上下文（整体分析分批与逐文件评审共用）
function fileToPromptText(folder, file) {
  let text = fileToDiffText(file);
  const context = buildContext(folder, file);
  if (context) {
    text += `\n\n以下是被改动的类/函数的完整定义（供分析上下文）：\n\n${context}`;
  }
  return text;
}

// 固定 9 个评审维度 + 可选自定义维度（customDimensions 每行一个，最多 8 个，插在「可复用性」与「总结与建议」之间）；
// hasPlan 为 true 时再追加「需求符合度」一节，对照需求方案/PRD 评审
function overviewSectionsText(cfg, hasPlan = false) {
  const dims = (cfg && typeof cfg.customDimensions === 'string' ? cfg.customDimensions : '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 8);
  const extra = dims.length ? ` / ${dims.map((d) => `## ${d}`).join(' / ')}` : '';
  const plan = hasPlan ? ' / ## 需求符合度' : '';
  return '严格使用以下二级标题分节：' +
    '## 改动概述 / ## 安全性 / ## 结构问题 / ## 影响面 / ## 逻辑严谨性 / ## 臃肿与冗余 / ## 可扩展性 / ## 可复用性' +
    `${extra}${plan} / ## 总结与建议。` +
    '每节给出具体、可执行的发现，无问题的小节明确说『未发现问题』，引用具体文件和行号。' +
    (hasPlan ? '「需求符合度」一节须对照需求方案/PRD：检查改动是否实现了方案要求的功能点、有无遗漏、有无超出方案范围的实现。' : '');
}

function buildOverviewSystem(cfg, hasPlan = false) {
  return `你是一位资深代码评审专家，请用中文、markdown 格式输出，${overviewSectionsText(cfg, hasPlan)}`;
}

// 按累计长度分批：每批 ≤10000 字符（含上下文），文件不拆半，单文件超限则单独成批并截断；最多 6 批
function splitIntoBatches(folder, files) {
  const BATCH_LIMIT = 10000;
  const MAX_BATCHES = 6;
  const batches = [];
  let current = [];
  let currentLen = 0;
  let reviewed = 0;
  for (const file of files) {
    const text = fileToPromptText(folder, file);
    if (text.length > BATCH_LIMIT) {
      if (current.length) {
        batches.push(current);
        current = [];
        currentLen = 0;
      }
      if (batches.length >= MAX_BATCHES) break;
      batches.push([`${text.slice(0, BATCH_LIMIT)}\n(diff 过长已截断)`]);
      reviewed += 1;
      continue;
    }
    if (current.length && currentLen + text.length > BATCH_LIMIT) {
      batches.push(current);
      current = [];
      currentLen = 0;
    }
    if (batches.length >= MAX_BATCHES) break;
    current.push(text);
    currentLen += text.length;
    reviewed += 1;
  }
  if (current.length && batches.length < MAX_BATCHES) batches.push(current);
  return { batches, reviewed };
}

// 整体分析分批循环：每批开始前检查暂停请求，暂停时保存续跑状态并返回已完成部分；
// 正常跑完后多批结果再综合（续跑走到这里同样执行综合）
async function runOverviewBatches(cfg, state) {
  const { folder, batches, system, runId } = state;
  const planPrefix = state.planContext ? `${state.planContext}\n\n` : '';
  for (let i = state.nextIndex; i < batches.length; i += 1) {
    if (pauseRequested) {
      pauseRequested = false;
      state.nextIndex = i;
      state.pausedAt = Date.now();
      pausedState = state;
      return {
        markdown: `${state.batchResults.join('\n\n')}\n\n（已暂停，可在「运行详情」中继续）`,
        stats: aggregateStats(state.statsList),
        paused: true,
      };
    }
    const label = batches.length > 1 ? `（第 ${i + 1}/${batches.length} 批）` : '';
    const user = `${planPrefix}以下是本次未提交的代码改动${label}（unified diff），请进行多角度评审：\n\n${batches[i].join('\n\n')}`;
    const { content, stats } = await chatWithStats(cfg, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { maxTokens: 4096, folder, kind: '整体分析', batch: label, batchIndex: i + 1, batchTotal: batches.length, runId, stream: true });
    state.batchResults.push(content);
    state.statsList.push(stats);
    state.nextIndex = i + 1;
  }
  let markdown;
  if (state.batchResults.length === 1) {
    markdown = state.batchResults[0];
  } else {
    let combined = state.batchResults
      .map((r, i) => `【第 ${i + 1} 批评审结果】\n${r}`)
      .join('\n\n');
    if (combined.length > 12000) combined = `${combined.slice(0, 12000)}\n(内容过长已截断)`;
    const synthSystem = withCustomPrompt(
      '你是一位资深代码评审专家。以下是针对同一批代码改动分批评审得到的多份评审结果，' +
      `请将它们去重、合并为一份完整评审，仍${overviewSectionsText(cfg, Boolean(state.planContext))}`,
      cfg,
    );
    const { content, stats } = await chatWithStats(cfg, [
      { role: 'system', content: synthSystem },
      { role: 'user', content: `${planPrefix}${combined}` },
    ], { maxTokens: 4096, folder, kind: '整体分析', batch: '（综合结果）', batchIndex: batches.length, batchTotal: batches.length, runId, stream: true });
    markdown = content;
    state.statsList.push(stats);
  }
  if (state.reviewed < state.files.length) {
    markdown += `\n\n改动过多，仅评审了前 ${state.reviewed} 个文件。`;
  }
  return { markdown, stats: aggregateStats(state.statsList), paused: false };
}

async function analyzeOverview({ folder, files, runId = null, customPromptOverride = '', planContext = '' }) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('没有可分析的改动');
  }
  const cfg = applyPromptOverride(await getSettings(), customPromptOverride);
  const plan = normalizePlanContext(planContext);
  const { batches, reviewed } = splitIntoBatches(folder, files);
  const state = {
    kind: 'overview',
    folder,
    files,
    system: withCustomPrompt(buildOverviewSystem(cfg, Boolean(plan)), cfg),
    planContext: plan,
    batchResults: [],
    statsList: [],
    nextIndex: 0,
    batches,
    reviewed,
    runId,
    pausedAt: null,
  };
  batchRunActive = true;
  try {
    return await runOverviewBatches(cfg, state);
  } finally {
    batchRunActive = false;
  }
}

async function analyzeFile({ folder, file, runId = null, planContext = '' }) {
  if (!file || !file.path) throw new Error('缺少要分析的文件');
  const cfg = await getSettings();
  const plan = normalizePlanContext(planContext);
  let text = fileToPromptText(folder, file);
  if (text.length > 12000) text = `${text.slice(0, 12000)}\n(diff 过长已截断)`;
  const system = withCustomPrompt(
    '你是一位资深代码评审专家，请用中文、markdown 格式输出，严格使用以下二级标题分节：' +
    '## 改动概述 / ## 问题与风险 / ## 改进建议。' +
    '每节给出具体、可执行的发现，无问题的小节明确说『未发现问题』，引用具体行号。',
    cfg,
  );
  const user = `${plan ? `${plan}\n\n` : ''}以下是该文件的代码改动（unified diff），请进行评审：\n\n${text}`;
  const { content, stats } = await chatWithStats(cfg, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { maxTokens: 2048, folder, kind: '逐文件分析', batch: file.path, runId, stream: true });
  return { markdown: content, stats };
}

const FULL_EXPLAIN_SYSTEM =
  '你是一位资深工程师，正在给同事完整讲解一批代码改动。请用中文、markdown 格式输出。' +
  '按文件逐个讲解：每个文件用三级标题（### 文件路径），其下逐改动块详细解释：' +
  '改了什么、从上下文推断的改动意图、改动前后的行为差异、与周边代码的关系、阅读时需要注意的细节。' +
  '尽可能详细、讲透，可以引用代码片段，不要遗漏任何一处改动，不要做笼统概括。';

// 完整讲解分批循环：各批结果直接拼接（每批内容互不重叠，无需综合）；支持暂停/续跑
async function runFullBatches(cfg, state) {
  const { folder, batches, system, runId } = state;
  const planPrefix = state.planContext ? `${state.planContext}\n\n` : '';
  for (let i = state.nextIndex; i < batches.length; i += 1) {
    if (pauseRequested) {
      pauseRequested = false;
      state.nextIndex = i;
      state.pausedAt = Date.now();
      pausedState = state;
      return {
        markdown: `${state.parts.join('\n\n---\n\n')}\n\n（已暂停，可在「运行详情」中继续）`,
        stats: aggregateStats(state.statsList),
        paused: true,
      };
    }
    const label = batches.length > 1 ? `（第 ${i + 1}/${batches.length} 批）` : '';
    const user = `${planPrefix}以下是部分代码改动${label}（unified diff），请完整详细讲解：\n\n${batches[i].join('\n\n')}`;
    const { content, stats } = await chatWithStats(cfg, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { maxTokens: 8192, folder, kind: '完整讲解', batch: label, batchIndex: i + 1, batchTotal: batches.length, runId, stream: true });
    state.parts.push(content);
    state.statsList.push(stats);
    state.nextIndex = i + 1;
  }
  let markdown = state.parts.join('\n\n---\n\n');
  if (state.reviewed < state.files.length) {
    markdown += `\n\n改动过多，仅讲解了前 ${state.reviewed} 个文件。`;
  }
  return { markdown, stats: aggregateStats(state.statsList), paused: false };
}

// 完整讲解：分批逐文件讲透
async function explainFull({ folder, files, runId = null, customPromptOverride = '', planContext = '' }) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('没有可讲解的改动');
  }
  const cfg = applyPromptOverride(await getSettings(), customPromptOverride);
  const { batches, reviewed } = splitIntoBatches(folder, files);
  const state = {
    kind: 'full',
    folder,
    files,
    system: withCustomPrompt(FULL_EXPLAIN_SYSTEM, cfg),
    planContext: normalizePlanContext(planContext),
    parts: [],
    statsList: [],
    nextIndex: 0,
    batches,
    reviewed,
    runId,
    pausedAt: null,
  };
  batchRunActive = true;
  try {
    return await runFullBatches(cfg, state);
  } finally {
    batchRunActive = false;
  }
}

// 构造逐句解析的改动上下文：多段框选（含各段文件路径）或单行 hunk 块，
// explainChange 与 explainFollowUp 共用
function buildExplainContext({ filePath, hunk, line, segments }) {
  if (Array.isArray(segments) && segments.length) {
    const blocks = segments.map((seg) => {
      const selected = new Set(seg.lines);
      const body = (seg.hunk.lines || [])
        .map((l) => {
          const prefix = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
          const no = l.newLine != null ? l.newLine : (l.oldLine != null ? l.oldLine : '?');
          const marker = selected.has(l) ? '>' : ' ';
          return `${marker}${prefix}${no} ${l.content}`;
        })
        .join('\n');
      const fileLabel = seg.filePath || filePath;
      return `文件: ${fileLabel}\n代码块: ${seg.hunk.header}\n${body}`;
    }).join('\n\n');
    return {
      multi: true,
      context: `以下是从 diff 中框选的多条改动（+ 新增 / - 删除，数字为行号，> 标出被询问的行，可能来自多个文件）：\n${blocks}`,
    };
  }
  if (!hunk || !line) throw new Error('缺少要解释的改动行');
  const hunkLines = (hunk.lines || [])
    .map((l) => {
      const prefix = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
      const no = l.newLine != null ? l.newLine : (l.oldLine != null ? l.oldLine : '?');
      const marker = l === line ? '>' : ' ';
      return `${marker}${prefix}${no} ${l.content}`;
    })
    .join('\n');
  return {
    multi: false,
    context:
      `文件: ${filePath}\n` +
      `代码块: ${hunk.header}\n\n` +
      `该代码块的全部改动（+ 新增 / - 删除，数字为行号，> 标出的是被询问的那一行）：\n${hunkLines}`,
  };
}

async function explainChange({ folder, filePath, hunk, line, segments, runId = null, planContext = '' }) {
  const ctx = buildExplainContext({ filePath, hunk, line, segments });
  const plan = normalizePlanContext(planContext);
  const prefix = plan ? `${plan}\n\n` : '';
  // 框选多行：整体解释这组改动
  if (ctx.multi) {
    const system = '你是代码讲解专家，用简洁中文解释一组代码改动的整体含义、意图和潜在影响，3~5 句话，不要复述代码。';
    const user = `${prefix}${ctx.context}\n\n请把这些以 > 标出的改动作为一个整体来解释。`;
    const { content, stats } = await chatWithStats(null, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { maxTokens: 768, folder, kind: '逐句解析', batch: filePath, runId, stream: true });
    return { markdown: content, stats };
  }
  const system = '你是代码讲解专家，用简洁中文解释单行代码改动的含义、意图和潜在影响，2~4 句话，不要复述代码。';
  const user = `${prefix}${ctx.context}\n\n请解释以 > 标出的那一行改动。`;
  const { content, stats } = await chatWithStats(null, [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ], { maxTokens: 512, folder, kind: '逐句解析', batch: filePath, runId, stream: true });
  return { markdown: content, stats };
}

// 逐句追问：带上改动上下文与历史问答，继续回答用户的新问题
async function explainFollowUp({ folder, filePath, hunk, line, segments, previousQA, question, runId = null, planContext = '' }) {
  if (!question || !String(question).trim()) throw new Error('缺少追问问题');
  const ctx = buildExplainContext({ filePath, hunk, line, segments });
  const plan = normalizePlanContext(planContext);
  const system = '你是代码讲解专家，已为用户讲解过一组代码改动，请用简洁中文回答用户的追问，不要复述代码。';
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: `${plan ? `${plan}\n\n` : ''}${ctx.context}\n\n请先理解这组改动。` },
  ];
  for (const qa of Array.isArray(previousQA) ? previousQA : []) {
    if (!qa || typeof qa.question !== 'string') continue;
    messages.push({ role: 'user', content: qa.question });
    messages.push({ role: 'assistant', content: typeof qa.answer === 'string' ? qa.answer : '' });
  }
  messages.push({ role: 'user', content: String(question) });
  const { content, stats } = await chatWithStats(null, messages, {
    maxTokens: 1024, folder, kind: '追问', batch: filePath, runId, stream: true,
  });
  return { markdown: content, stats };
}

// 评审/讲解结果追问：带上本次全部改动上下文与历史问答（首条通常是初始评审/讲解），回答用户的新问题
const FOLLOWUP_CONTEXT_MAX_CHARS = 10000;

async function reviewFollowUp({ folder, files, previousQA, question, runId = null, planContext = '' }) {
  if (!question || !String(question).trim()) throw new Error('缺少追问问题');
  if (!Array.isArray(files) || files.length === 0) throw new Error('没有可参考的改动');
  const plan = normalizePlanContext(planContext);
  let context = files.map((file) => fileToPromptText(folder, file)).join('\n\n');
  if (context.length > FOLLOWUP_CONTEXT_MAX_CHARS) {
    context = `${context.slice(0, FOLLOWUP_CONTEXT_MAX_CHARS)}\n（改动过多已截断）`;
  }
  const system = '你是资深代码评审与讲解专家，已为用户评审/讲解过一批代码改动，请用简洁中文回答用户就这批改动的追问。';
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: `${plan ? `${plan}\n\n` : ''}${context}\n\n这是本次改动的 diff 与相关定义，请先理解。` },
  ];
  for (const qa of Array.isArray(previousQA) ? previousQA : []) {
    if (!qa || typeof qa.question !== 'string') continue;
    messages.push({ role: 'user', content: qa.question });
    messages.push({ role: 'assistant', content: typeof qa.answer === 'string' ? qa.answer : '' });
  }
  messages.push({ role: 'user', content: String(question) });
  const { content, stats } = await chatWithStats(null, messages, {
    maxTokens: 2048, folder, kind: '追问', batch: '评审追问', runId, stream: true,
  });
  return { markdown: content, stats };
}

function imageMime(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  }[ext] || 'image/png';
}

const PLAN_SYSTEM =
  '你是一位资深技术专家，正在根据需求文档（PRD）与设计稿为项目制定技术实现方案。请用中文、markdown 格式输出，严格使用以下二级标题分节：' +
  '## 需求理解 / ## 功能点拆解 / ## 模块与类设计 / ## 关键文件与改动点预估 / ## 数据流 / ## 风险点 / ## 验收标准。' +
  '方案要具体、可落地：结合项目实际技术栈与目录结构推断涉及的关键文件，引用具体模块/类/文件名，不要泛泛而谈。';

// 需求方案生成：API 后端走 OpenAI 兼容多模态消息（base64 data URL），
// CLI 后端（opencode/kimi/codex）在 prompt 中给出图片绝对路径，由 CLI 自行读取
async function generatePlan({ prdText, prdFileName, imagePaths = [], extraRequirement = '' } = {}, settings, { runId = null, folder = null } = {}) {
  if (!prdText || !String(prdText).trim()) throw new Error('缺少 PRD 内容');
  const cfg = settings || (await getSettings());
  const images = (Array.isArray(imagePaths) ? imagePaths : []).filter((p) => typeof p === 'string' && p);
  const extra = typeof extraRequirement === 'string' && extraRequirement.trim()
    ? `\n\n额外要求（必须遵守）：${extraRequirement.trim()}`
    : '';
  const prdSection = `需求文档（${prdFileName || 'PRD'}）全文：\n\n${prdText}`;
  const options = { maxTokens: 8192, folder, kind: '方案生成', batch: prdFileName || '', runId, stream: true };
  if (cfg.backend === 'opencode' || cfg.backend === 'kimi' || cfg.backend === 'codex') {
    const imgNote = images.length
      ? `\n\n设计稿图片（共 ${images.length} 张，请用文件读取能力逐张查看后结合设计稿输出方案）：\n${images.map((p) => `- ${p}`).join('\n')}`
      : '';
    const user = `${prdSection}${imgNote}${extra}\n\n请基于以上需求文档${images.length ? '与设计稿' : ''}输出技术方案。`;
    const { content, stats } = await chatWithStats(cfg, [
      { role: 'system', content: PLAN_SYSTEM },
      { role: 'user', content: user },
    ], options);
    return { markdown: content, stats };
  }
  const text = `${prdSection}${extra}\n\n请基于以上需求文档${images.length ? '与设计稿图片' : ''}输出技术方案。`;
  const parts = [{ type: 'text', text }];
  for (const p of images) {
    try {
      const base64 = fs.readFileSync(p).toString('base64');
      parts.push({ type: 'image_url', image_url: { url: `data:${imageMime(p)};base64,${base64}` } });
    } catch { /* 读取失败的图片跳过 */ }
  }
  const { content, stats } = await chatWithStats(cfg, [
    { role: 'system', content: PLAN_SYSTEM },
    { role: 'user', content: parts.length > 1 ? parts : text },
  ], options);
  return { markdown: content, stats };
}

async function testConnection(settings) {
  try {
    await chat(settings, [{ role: 'user', content: 'ping' }], { maxTokens: 5, kind: '测试连接' });
    return { ok: true, message: '连接成功' };
  } catch (err) {
    return { ok: false, message: err.message };
  }
}

module.exports = { analyzeOverview, analyzeFile, explainFull, explainChange, explainFollowUp, reviewFollowUp, generatePlan, testConnection, listModels, getCurrentRun, setChunkSender, cancelRun, pauseRun, resumeRun, buildOverviewSystem };

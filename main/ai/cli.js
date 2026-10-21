const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stripVTControlCharacters } = require('util');
const state = require('./state');
const { timeoutMs, cancelledError, killProcessGroup, ensureLane } = require('./runControl');

const CLI_CANDIDATES = {
  opencode: ['/opt/homebrew/bin/opencode', '/usr/local/bin/opencode'],
  kimi: [`${os.homedir()}/.kimi-code/bin/kimi`, '/opt/homebrew/bin/kimi', '/usr/local/bin/kimi'],
  codex: ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'],
};

const CLI_LABELS = { opencode: 'OpenCode', kimi: 'Kimi CLI', codex: 'Codex' };
const activeChildren = new Set();
let quitting = false;

/** @template {import('child_process').ChildProcess} T @param {T} child @returns {T} */
function registerChild(child) {
  activeChildren.add(child);
  child.once('exit', () => activeChildren.delete(child));
  return child;
}

function terminateActiveChildren() {
  quitting = true;
  for (const lane of state.lanes.values()) lane.currentCancel?.();
  const children = [...activeChildren];
  for (const child of children) killProcessGroup(child);
  return new Promise((resolve) => {
    setTimeout(() => {
      for (const child of children) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 进程组已退出 */ }
        activeChildren.delete(child);
      }
      resolve(undefined);
    }, 3000);
  });
}

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
  // 保留环境凭据和代理配置，不能用精简环境破坏用户的 CLI 登录态。
  return {
    ...process.env,
    PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
  };
}

const KILL_GRACE_MS = 3000;
const PIPE_DRAIN_MS = 500;

/**
 * @typedef {Error & { kind: 'cancelled' | 'timeout' | 'maxBuffer' | 'exit' | 'spawn', code?: number | null, stderr?: string, stdout?: string }} BashError
 */

/**
 * 经 bash 启动 CLI，并让 bash 自成进程组。
 * 注意：child_process.execFile 会丢弃 detached 选项，bash 会留在 ReviewFlow 的进程组里，
 * 按组终止失败后只杀得掉 bash，真正的 CLI 变成孤儿继续运行，且它持有输出管道导致永远等不到结束。
 * 因此改用 spawn；取消/超时整组 TERM→KILL 并立即结束等待，不依赖孙进程释放管道。
 * @param {string} cmd
 * @param {{ maxBuffer: number, timeoutMs: number, onStdout?: (chunk: string) => void }} opts
 */
function runBash(cmd, { maxBuffer, timeoutMs: limit, onStdout }) {
  const child = registerChild(spawn('/bin/bash', ['-c', cmd], {
    detached: true, env: cliEnv(), stdio: ['ignore', 'pipe', 'pipe'],
  }));
  let stdout = '';
  let stderr = '';
  let settled = false;
  let exited = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let drainTimer = null;
  /** @type {(value: { stdout: string, stderr: string }) => void} */
  let resolve = () => {};
  /** @type {(error: BashError) => void} */
  let reject = () => {};
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  /** @param {NodeJS.Signals} signal */
  const killGroup = (signal) => {
    try { process.kill(-(child.pid || 0), signal); } catch { /* 进程组已全部退出 */ }
  };
  /** @param {BashError | null} error */
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (drainTimer) clearTimeout(drainTimer);
    child.stdout?.destroy();
    child.stderr?.destroy();
    if (error) reject(Object.assign(error, { stdout, stderr }));
    else resolve({ stdout, stderr });
  };
  /** @param {BashError['kind']} kind @param {string} message */
  const terminate = (kind, message) => {
    if (settled) return;
    killGroup('SIGTERM');
    const escalate = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    escalate.unref?.();
    finish(Object.assign(new Error(message), { kind }));
  };
  /** @param {number | null} code */
  const finishByCode = (code) => {
    if (code === 0) finish(null);
    else finish(Object.assign(new Error(`退出码 ${code}`), { kind: /** @type {const} */ ('exit'), code }));
  };
  const timer = setTimeout(() => terminate('timeout', '执行超时'), limit);
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    stdout += chunk;
    if (Buffer.byteLength(stdout) > maxBuffer) terminate('maxBuffer', '输出超过上限');
    else onStdout?.(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    if (stderr.length < 64 * 1024) stderr += chunk;
  });
  child.once('error', (error) => finish(Object.assign(error, { kind: /** @type {const} */ ('spawn') })));
  child.once('exit', (code) => {
    exited = true;
    // bash 已退出但后台孙进程仍占着管道时，不能无限等 close：短暂等待输出排空后清掉残留进程组
    drainTimer = setTimeout(() => {
      if (settled) return;
      killGroup('SIGKILL');
      finishByCode(code);
    }, PIPE_DRAIN_MS);
  });
  child.once('close', (code) => {
    if (exited || code !== null) finishByCode(code);
  });
  return { child, promise, cancel: () => terminate('cancelled', '已取消') };
}

// macOS 的 ARG_MAX（1 MiB）限制的是全部参数 + 环境变量的总字节数，没有 Linux 那种单参数 128 KiB 上限；
// 按实际环境扣除并留 64 KiB 余量，避免误拒中文较多的正常大批次评审。
const MACOS_ARG_MAX = 1024 * 1024;
const ARG_SAFETY_MARGIN = 64 * 1024;

/**
 * @param {string} text
 * @param {string} cmd
 * @param {Record<string, string | undefined>} env
 */
function exceedsArgLimit(text, cmd, env) {
  let envBytes = 0;
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) envBytes += Buffer.byteLength(`${key}=${value}`) + 1 + 8; // NUL 结尾 + 指针
  }
  return Buffer.byteLength(text) + Buffer.byteLength(cmd) + envBytes + ARG_SAFETY_MARGIN > MACOS_ARG_MAX;
}

// Codex 明确支持 stdin；其他 CLI 未声明该契约，保留安全引用的参数传递。
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
  return `${cmd} - < ${shellQuote(tmpFile)}`;
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
  parts.push(backend === 'codex' ? '- < <prompt>' : '< /dev/null');
  return parts.join(' ');
}

// 通过本机 CLI（opencode / kimi / codex）完成对话，使用各 CLI 已配置好的模型与登录态。
// 注意：直接 execFile 这些二进制会挂起（疑似其进程/会话检测），必须经 bash 启动。
function chatViaCli(backend, cfg, messages, folder, runId) {
  const lane = ensureLane(runId);
  if (lane.cancelled || quitting) return Promise.reject(cancelledError());
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
  // 随机后缀防并发碰撞；文件含完整 diff（用户私有代码），写为仅本人可读写
  const tmpFile = path.join(
    os.tmpdir(),
    `auto-review-prompt-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.txt`,
  );
  const cmd = buildCliCmd(backend, cfg, folder, tmpFile);
  if (backend !== 'codex' && exceedsArgLimit(text, cmd, cliEnv())) {
    return Promise.reject(new Error('CLI 参数内容过大，请减少上下文或改用 API 后端'));
  }
  const cliTimeout = timeoutMs(cfg);
  const label = CLI_LABELS[backend] || backend;
  return new Promise((resolve, reject) => {
    let cancelledByUser = false;
    /** @type {ReturnType<typeof runBash> | null} */
    let run = null;
    const cancel = () => {
      cancelledByUser = true;
      run?.cancel();
    };
    lane.currentCancel = cancel;
    const clearCancel = () => { if (lane.currentCancel === cancel) lane.currentCancel = null; };
    const removeTmp = () => fs.unlink(tmpFile, (error) => { if (error && error.code !== 'ENOENT') console.warn('无法清理临时 prompt 文件'); });
    fs.writeFile(tmpFile, text, { encoding: 'utf8', mode: 0o600 }, (werr) => {
      if (werr) {
        clearCancel();
        reject(new Error(`无法写入临时 prompt 文件: ${werr.message}`));
        return;
      }
      if (cancelledByUser || lane.cancelled || quitting) {
        removeTmp();
        clearCancel();
        reject(cancelledError());
        return;
      }
      let preview = '';
      let lastSentAt = 0;
      let lastSentLen = 0;
      /** @param {boolean} force */
      const sendPreview = (force) => {
        if (!state.chunkSender || !runId || !preview) return;
        const now = Date.now();
        const clean = stripVTControlCharacters(preview);
        if (!force && now - lastSentAt < 100 && clean.length - lastSentLen < 2048) return;
        lastSentAt = now;
        lastSentLen = clean.length;
        state.chunkSender(runId, clean);
      };
      run = runBash(cmd, {
        maxBuffer: 10 * 1024 * 1024,
        timeoutMs: cliTimeout,
        onStdout: (chunk) => { preview += chunk; sendPreview(false); },
      });
      run.promise.then(({ stdout }) => {
        clearCancel();
        removeTmp();
        sendPreview(true);
        if (cancelledByUser || lane.cancelled) { reject(cancelledError()); return; }
        const content = String(stdout || '').trim();
        if (!content) {
          reject(new Error(`${label} 没有返回内容，请检查本地模型配置`));
          return;
        }
        resolve(content);
      }, (/** @type {BashError} */ err) => {
        clearCancel();
        removeTmp();
        if (cancelledByUser || lane.cancelled || err.kind === 'cancelled') { reject(cancelledError()); return; }
        const raw = String(err.stderr || err.message || '').replace(/\x1b\[[0-9;]*m/g, '');
        if (err.kind === 'timeout') {
          reject(new Error(
            `${label} 执行超时（当前上限 ${Math.round(cliTimeout / 60000)} 分钟），` +
            '已终止该 CLI 进程，可在「AI 设置」中调大超时时间',
          ));
        } else if (err.kind === 'maxBuffer') {
          reject(new Error(`${label} 输出超过 10 MiB 上限，已终止`));
        } else if (backend === 'codex' && /login|auth|unauthorized|token/i.test(raw)) {
          reject(new Error('Codex CLI 未登录，请先在终端运行 codex login 完成授权'));
        } else {
          reject(new Error(`${label} 执行失败: ${raw.slice(0, 300)}`));
        }
      });
    });
  });
}

/**
 * 模型列表等短命令：同样走独立进程组，超时整组终止。
 * @param {string} cmd @param {number} maxBuffer @param {string} failPrefix
 */
function runListCommand(cmd, maxBuffer, failPrefix) {
  if (quitting) return Promise.reject(cancelledError());
  return runBash(cmd, { maxBuffer, timeoutMs: 60_000 }).promise.then(
    ({ stdout }) => stdout,
    (/** @type {BashError} */ err) => {
      const detail = err.kind === 'timeout' ? '执行超时（60 秒）' : String(err.stderr || err.message || '');
      throw new Error(`${failPrefix}${detail.slice(0, 300)}`);
    },
  );
}

// 拉取 opencode 本机可用模型列表（provider/model 每行一个）
function listOpencodeModels() {
  const bin = resolveCliBin('opencode');
  if (!bin) {
    return Promise.reject(new Error('未找到 opencode 命令行，请先安装（brew install opencode）'));
  }
  return runListCommand(`${shellQuote(bin)} models < /dev/null`, 5 * 1024 * 1024, 'opencode models 执行失败: ')
    .then((stdout) => {
      const ids = String(stdout || '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      return [...new Set(ids)].sort();
    });
}

// 拉取 codex 模型目录（codex debug models 输出 JSON）
function listCodexModels() {
  if (!resolveCliBin('codex')) {
    return Promise.reject(new Error('未找到 codex 命令行，请先安装（brew install codex）'));
  }
  return runListCommand(`${shellQuote(resolveCliBin('codex'))} debug models < /dev/null`, 10 * 1024 * 1024, 'codex 获取模型列表失败: ')
    .then((stdout) => {
      let data;
      try {
        data = JSON.parse(String(stdout));
      } catch {
        throw new Error('codex 模型列表解析失败');
      }
      const slugs = (Array.isArray(data.models) ? data.models : [])
        .filter((m) => m && m.visibility === 'list' && m.slug)
        .map((m) => m.slug);
      return [...new Set(slugs)];
    });
}

module.exports = { resolveCliBin, cliCmdLabel, chatViaCli, listOpencodeModels, listCodexModels, registerChild, activeChildren, terminateActiveChildren, exceedsArgLimit, runBash };

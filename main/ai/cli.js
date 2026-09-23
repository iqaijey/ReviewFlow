const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const state = require('./state');
const { timeoutMs, cancelledError, killProcessGroup } = require('./runControl');

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
      state.currentCancel = () => {
        cancelledByUser = true;
        killProcessGroup(child);
      };
    });
  });
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

module.exports = { resolveCliBin, cliCmdLabel, chatViaCli, listOpencodeModels, listCodexModels };

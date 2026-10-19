// 读取本机 kimi / codex CLI 的配置，获取实际生效的模型与思考强度
const fs = require('fs');
const os = require('os');
const path = require('path');

// 每次 AI 调用都会读配置，按 mtime 缓存避免重复读盘与解析
/** @type {Map<string, { mtimeMs: number, value: any }>} */
const configCache = new Map();

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

// mtime 变化才重新读取并重新解析；stat 失败（文件不存在）不缓存，保证下次重试
function cached(p, parse) {
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(p).mtimeMs;
  } catch {
    return parse('');
  }
  const hit = configCache.get(p);
  if (hit && hit.mtimeMs === mtimeMs) return hit.value;
  const value = parse(readFileSafe(p));
  configCache.set(p, { mtimeMs, value });
  return value;
}

// 简易 TOML 提取：只覆盖本应用需要的键，不引入解析库
function topLevelValue(text, key) {
  const head = text.split(/^\[/m)[0];
  const m = head.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'));
  return m ? m[1] : '';
}

function readKimiConfig() {
  return cached(path.join(os.homedir(), '.kimi-code', 'config.toml'), (text) => {
    if (!text) return { defaultModel: '', effort: '', models: [] };
    const models = [];
    for (const m of text.matchAll(/^\[models\."([^"]+)"\]/gm)) {
      models.push(m[1]);
    }
    const thinkingMatch = text.match(/\[thinking\]([^\[]*)/);
    const effort = thinkingMatch
      ? ((thinkingMatch[1].match(/effort\s*=\s*"([^"]*)"/) || [])[1] || '')
      : '';
    return {
      defaultModel: topLevelValue(text, 'default_model'),
      effort,
      models: [...new Set(models)],
    };
  });
}

function readCodexConfig() {
  return cached(path.join(os.homedir(), '.codex', 'config.toml'), (text) => {
    if (!text) return { defaultModel: '', effort: '' };
    return {
      defaultModel: topLevelValue(text, 'model'),
      effort: topLevelValue(text, 'model_reasoning_effort'),
    };
  });
}

function endpointIdentity(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return null;
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
  } catch { return null; }
}

/** @param {{backend?:string,baseUrl?:string,model?:string,codexModel?:string,reasoningEffort?:string,_reviewBackend?:{requestedModel:string|null,resolvedModel:string|null,effort:string}}} cfg @param {string} [folder] @returns {import('./fileAnalysisCache').Execution|null} */
function fileAnalysisExecution(cfg, folder) {
  const backend = cfg.backend || 'api';
  const identity = cfg._reviewBackend;
  const common = { backend, endpoint: null, requestedModel: identity?.requestedModel || cfg.model || null,
    resolvedModel: identity?.resolvedModel || cfg.model || null, effort: identity?.effort || cfg.reasoningEffort || '',
    cliConfigFingerprint: null, maxTokens: 2048, temperature: 0.2, promptVersion: 'file-v2' };
  if (backend === 'api') {
    const endpoint = endpointIdentity(cfg.baseUrl || '');
    return endpoint ? { ...common, endpoint } : null;
  }
  // CLI 的 provider/profile/项目级配置可能改变默认行为；无法完整识别时不复用。
  if (backend !== 'codex' || !folder || process.env.CODEX_HOME || process.env.CODEX_PROFILE || process.env.OPENAI_BASE_URL) return null;
  for (let dir = path.resolve(folder); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.codex', 'config.toml'))) return null;
    if (path.dirname(dir) === dir) break;
  }
  const text = readFileSafe(path.join(os.homedir(), '.codex', 'config.toml'));
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  if (!lines.length || lines.some((line) => !/^(model|model_reasoning_effort)\s*=\s*"[^"\r\n]+"\s*$/.test(line))) return null;
  const cli = readCodexConfig();
  if (!identity?.resolvedModel || !common.effort || !cli.defaultModel || !cli.effort) return null;
  return { ...common, endpoint: 'https://api.openai.com',
    cliConfigFingerprint: require('./reviewSnapshot').hash(JSON.stringify([cli.defaultModel, cli.effort])) };
}

module.exports = { readKimiConfig, readCodexConfig, fileAnalysisExecution, endpointIdentity };

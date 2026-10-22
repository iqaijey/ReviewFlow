// ReviewFlow 的 MCP stdio 桥：供 Claude Code / Codex / OpenCode 等 Agent 接入。
// 以 ELECTRON_RUN_AS_NODE=1 运行在应用自带的 Electron 上，把 MCP tools/call 转发到应用的本机 HTTP 接口；
// 应用未运行时自动启动并等待接口就绪。stdout 只能输出协议消息，日志一律写 stderr。
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const readline = require('readline');
const { listTools } = require('./catalog');
const { defaultUserDataDir, readConfig } = require('./config');
const { challengeProof } = require('./server');

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LAUNCH_TIMEOUT_MS = 60_000;
const dataDir = defaultUserDataDir();

/** @param {string} message */
function log(message) {
  process.stderr.write(`[reviewflow-mcp] ${message}\n`);
}

/**
 * @param {'GET' | 'POST'} method
 * @param {string} baseUrl
 * @param {string | null} token 为 null 时不带 Authorization
 * @param {string} route
 * @param {unknown} [body]
 * @param {number} [timeoutMs]
 * @returns {Promise<{ status: number, json: any }>}
 */
function request(method, baseUrl, token, route, body, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(new URL(route, baseUrl), {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) },
      timeout: timeoutMs || undefined,
    }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode || 0, json: JSON.parse(text) });
        } catch {
          reject(new Error(`ReviewFlow 返回了无效响应（HTTP ${res.statusCode}）`));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** @param {number | null} pid */
function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function liveConfig() {
  const config = readConfig(dataDir);
  if (!config.enabled) throw new Error('ReviewFlow 的外部 Agent 接口已在「AI 设置」中关闭');
  if (!config.url || !config.token || !processAlive(config.pid)) return null;
  const challenge = crypto.randomBytes(16).toString('hex');
  try {
    const { status, json } = await request('GET', config.url, null, `/v1/health?challenge=${challenge}`, undefined, 2000);
    const expected = Buffer.from(challengeProof(config.token, challenge));
    const proof = Buffer.from(String(json && json.proof));
    return status === 200 && proof.length === expected.length && crypto.timingSafeEqual(proof, expected) ? config : null;
  } catch {
    return null;
  }
}

function launchTarget() {
  const fromConfig = readConfig(dataDir).appPath;
  if (fromConfig) return fromConfig;
  const match = /^(.*?\.app)\/Contents\/MacOS\//.exec(process.execPath);
  return match && !/\/Electron\.app$/.test(match[1]) ? match[1] : null;
}

/** @type {Promise<import('./config').AgentApiConfig> | null} */
let launching = null;

async function ensureApp() {
  const live = await liveConfig();
  if (live) return live;
  if (launching) return launching;
  const target = launchTarget();
  if (!target) throw new Error('ReviewFlow 未运行，且无法确定应用位置，请先手动打开 ReviewFlow');
  launching = (async () => {
    log(`启动 ${target}`);
    spawn('open', [target], { detached: true, stdio: 'ignore' }).unref();
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const config = await liveConfig();
      if (config) return config;
    }
    throw new Error('等待 ReviewFlow 启动超时（60 秒）');
  })().finally(() => { launching = null; });
  return launching;
}

/** @param {string} name @param {unknown} args */
async function callTool(name, args) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const config = await ensureApp();
    const { status, json } = await request('POST', /** @type {string} */ (config.url), config.token, `/v1/tools/${encodeURIComponent(name)}`, args || {});
    // 令牌被重新生成时重读一次配置
    if (status === 401 && attempt === 0) continue;
    if (json && json.ok) return json.result;
    throw new Error((json && json.error) || `HTTP ${status}`);
  }
  throw new Error('令牌校验失败');
}

/** @param {unknown} message */
function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** @param {any} msg */
async function handle(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0') {
    write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: '无效的 JSON-RPC 请求' } });
    return;
  }
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    let result;
    if (method === 'initialize') {
      const requested = params && params.protocolVersion;
      result = {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'reviewflow', version: '1.0.0' },
        instructions: 'ReviewFlow 代码评审应用。常用流程：changes_summary 看改动 → review_start 评审 → checklist_list 查看问题清单 → '
          + 'fix_generatePatch / fix_applyPatch 修复 → fix_verifyFinding 复核 → checklist_setStatus 更新状态。所有 folder 参数都是项目根目录绝对路径。',
      };
    } else if (method === 'ping') {
      result = {};
    } else if (method === 'tools/list') {
      result = { tools: listTools() };
    } else if (method === 'tools/call') {
      try {
        const value = await callTool(String(params && params.name), params && params.arguments);
        result = { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
      } catch (error) {
        result = { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    } else if (typeof method === 'string' && method.startsWith('notifications/')) {
      return;
    } else {
      if (isRequest) write({ jsonrpc: '2.0', id, error: { code: -32601, message: `不支持的方法：${method}` } });
      return;
    }
    if (isRequest) write({ jsonrpc: '2.0', id, result });
  } catch (error) {
    if (isRequest) write({ jsonrpc: '2.0', id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
  }
}

function main() {
  /** @type {Set<Promise<void>>} */
  const pending = new Set();
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '无效的 JSON' } });
      return;
    }
    const task = handle(msg)
      .catch((error) => log(`处理消息失败：${error instanceof Error ? error.message : String(error)}`))
      .finally(() => pending.delete(task));
    pending.add(task);
  });
  rl.on('close', () => {
    Promise.allSettled([...pending]).then(() => process.exit(0));
  });
}

if (require.main === module) main();

module.exports = { handle, callTool };

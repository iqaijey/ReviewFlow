// agent-api.json：开关、端口、令牌和运行中实例信息。服务端与 MCP 桥共用，不依赖 electron。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const FILE_NAME = 'agent-api.json';
const DEFAULT_PORT = 47821;

/** @typedef {{ enabled: boolean, port: number, token: string, pid: number | null, url: string | null, appPath: string | null }} AgentApiConfig */

function defaultUserDataDir() {
  const override = process.env.REVIEWFLOW_USER_DATA_DIR;
  if (typeof override === 'string' && override) return path.resolve(override);
  return path.join(os.homedir(), 'Library', 'Application Support', 'auto-review');
}

/** @param {string} dir */
function configPath(dir) {
  return path.join(dir, FILE_NAME);
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * 文件缺失或损坏都按默认值处理：令牌会重新生成，不影响应用其它数据
 * @param {string} dir
 * @returns {AgentApiConfig}
 */
function readConfig(dir) {
  /** @type {Record<string, any>} */
  let raw = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(dir), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('agent-api.json 无法读取，按默认配置处理');
  }
  return {
    enabled: raw.enabled !== false,
    port: Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : DEFAULT_PORT,
    token: typeof raw.token === 'string' && /^[0-9a-f]{64}$/.test(raw.token) ? raw.token : '',
    pid: Number.isInteger(raw.pid) ? raw.pid : null,
    url: typeof raw.url === 'string' ? raw.url : null,
    appPath: typeof raw.appPath === 'string' ? raw.appPath : null,
  };
}

/**
 * @param {string} dir
 * @param {AgentApiConfig} config
 */
function writeConfig(dir, config) {
  const { writeFileAtomic } = require('../atomicFile');
  const file = configPath(dir);
  writeFileAtomic(file, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

module.exports = { DEFAULT_PORT, defaultUserDataDir, configPath, newToken, readConfig, writeConfig };

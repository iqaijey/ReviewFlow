// 外部 Agent 接口的装配与生命周期：复用已注册的 IPC 处理函数，界面能做的 Agent 都能做
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { readConfig, writeConfig, newToken } = require('./config');
const { createAgentServer } = require('./server');
const { createDispatcher } = require('./dispatcher');
const { createComposites } = require('./composite');
const { listTools } = require('./catalog');

/** @typedef {(event: any, ...args: any[]) => any} IpcHandler */

const detachedSender = { isDestroyed: () => true, send: () => undefined };

function mainWindow() {
  return BrowserWindow.getAllWindows().find((win) => !win.isDestroyed() && !win.webContents.isDestroyed()) || null;
}

function appBundlePath() {
  if (!app.isPackaged) return null;
  const match = /^(.*?\.app)\/Contents\/MacOS\//.exec(process.execPath);
  return match ? match[1] : null;
}

/** @param {string} channel @param {unknown} payload */
function broadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  }
}

/** @param {Map<string, IpcHandler>} handlers */
function createAgentApi(handlers) {
  const dir = app.getPath('userData');
  let config = readConfig(dir);
  if (!config.token) config = { ...config, token: newToken() };
  let listening = false;

  /** @param {string} channel @param {unknown[]} args */
  async function invoke(channel, args) {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`内部接口不存在：${channel}`);
    const win = mainWindow();
    // 借用主窗口作为 sender：流式输出、文件监听等与界面发起时行为一致
    return handler({ sender: win ? win.webContents : detachedSender }, ...args);
  }

  /** @param {string} folder */
  async function openProject(folder) {
    const win = mainWindow();
    if (!win) throw new Error('应用窗口不存在');
    if (win.webContents.isLoading()) await new Promise((resolve) => win.webContents.once('did-finish-load', () => resolve(undefined)));
    win.webContents.send('agent:openProject', { folder });
    if (win.isMinimized()) win.restore();
    win.show();
  }

  const dispatcher = createDispatcher({
    invoke,
    composites: createComposites({ invoke, openProject }),
    notify: (change) => broadcast('agent:changed', change),
  });
  const server = createAgentServer({
    getToken: () => config.token,
    listTools,
    callTool: dispatcher.callTool,
    health: () => ({ app: 'ReviewFlow', version: app.getVersion(), pid: process.pid }),
  });

  function save() {
    writeConfig(dir, config);
  }

  async function doStart() {
    if (listening) return;
    if (!config.enabled) {
      config = { ...config, pid: null, url: null };
      save();
      return;
    }
    const port = await server.listen(config.port);
    listening = true;
    config = { ...config, port, pid: process.pid, url: `http://127.0.0.1:${port}`, appPath: appBundlePath() };
    save();
  }

  async function doStop() {
    if (listening) await server.close();
    listening = false;
    config = { ...config, pid: null, url: null };
    if (readConfig(dir).pid === process.pid || !config.enabled) save();
  }

  // 启停串行执行，避免「关闭」穿插在 listen 期间导致关闭后仍在监听
  let lifecycle = Promise.resolve();
  /** @template T @param {() => Promise<T>} step @returns {Promise<T>} */
  function serial(step) {
    const run = lifecycle.then(step);
    // 错误已通过 run 返回给调用方，队列本身只需继续往下排
    lifecycle = run.then(() => undefined, () => undefined);
    return run;
  }
  const start = () => serial(doStart);
  const stop = () => serial(doStop);

  function info() {
    const bridgePath = path.join(__dirname, 'mcpBridge.js');
    const mcpServer = { command: process.execPath, args: [bridgePath], env: { ELECTRON_RUN_AS_NODE: '1', REVIEWFLOW_USER_DATA_DIR: dir } };
    return {
      enabled: config.enabled,
      running: listening,
      url: listening ? config.url : null,
      token: config.token,
      configFile: path.join(dir, 'agent-api.json'),
      toolCount: listTools().length,
      mcpConfig: { mcpServers: { reviewflow: mcpServer } },
    };
  }

  /** @param {boolean} enabled */
  function setEnabled(enabled) {
    return serial(async () => {
      config = { ...config, enabled: enabled === true };
      if (config.enabled) await doStart();
      else await doStop();
      save();
      return info();
    });
  }

  function regenerateToken() {
    config = { ...config, token: newToken() };
    save();
    return info();
  }

  return { start, stop, info, setEnabled, regenerateToken, callTool: dispatcher.callTool };
}

module.exports = { createAgentApi };

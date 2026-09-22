const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const git = require('./git');
const ai = require('./ai');
const settingsStore = require('./settings');
const iconManager = require('./iconManager');
const store = require('./store');
const updateChecker = require('./updateChecker');

// 支持 `electron . /path/to/project` 直接打开项目
function getInitialFolder() {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  const candidate = args.find((a) => !a.startsWith('-'));
  if (!candidate) return null;
  const resolved = path.resolve(candidate);
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => stopWatcher());
}

let watcher = null;
let watcherTimer = null;

function stopWatcher() {
  if (watcherTimer) {
    clearTimeout(watcherTimer);
    watcherTimer = null;
  }
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

function startWatcher(folder, sender) {
  stopWatcher();
  watcher = fs.watch(folder, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;
    const normalized = `/${filename.split(path.sep).join('/')}`;
    if (normalized.includes('/node_modules/') || normalized.includes('/.git/')) return;
    if (watcherTimer) clearTimeout(watcherTimer);
    watcherTimer = setTimeout(() => {
      watcherTimer = null;
      if (!sender.isDestroyed()) sender.send('fs:changed');
    }, 1500);
  });
}

function registerIpcHandlers() {
  ipcMain.handle('app:getInitialFolder', async () => getInitialFolder());
  ipcMain.handle('app:getVersion', async () => app.getVersion());

  ipcMain.handle('icon:pick', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const imagePath = result.filePaths[0];
    const preview = await iconManager.previewDataUrl(imagePath).catch(() => null);
    return { path: imagePath, preview };
  });

  ipcMain.handle('icon:apply', async (_event, imagePath) => {
    return iconManager.applyCustomIcon(imagePath);
  });

  ipcMain.handle('icon:reset', async () => {
    return iconManager.resetIcon();
  });

  ipcMain.handle('icon:current', async () => {
    return iconManager.currentCustomIcon();
  });

  ipcMain.handle('dialog:selectFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('git:getChanges', async (_event, folder, options) => {
    try {
      return await git.getChanges(folder, options);
    } catch (err) {
      throw new Error(`获取改动失败：${err.message}`);
    }
  });

  ipcMain.handle('git:getBranches', async (_event, folder) => {
    try {
      return await git.getBranches(folder);
    } catch (err) {
      throw new Error(`获取分支列表失败：${err.message}`);
    }
  });

  ipcMain.handle('git:getCommits', async (_event, folder) => {
    try {
      return await git.getCommits(folder);
    } catch (err) {
      throw new Error(`获取提交列表失败：${err.message}`);
    }
  });

  ipcMain.handle('settings:get', async () => {
    return settingsStore.getSettings();
  });

  ipcMain.handle('settings:save', async (_event, settings) => {
    return settingsStore.saveSettings(settings);
  });

  ipcMain.handle('ai:analyzeOverview', async (event, payload) => {
    try {
      ai.setChunkSender((runId, text) => {
        if (!event.sender.isDestroyed()) event.sender.send('ai:chunk', { runId, text });
      });
      return await ai.analyzeOverview(payload);
    } catch (err) {
      throw new Error(`AI 概述分析失败：${err.message}`);
    }
  });

  ipcMain.handle('ai:explainChange', async (_event, payload) => {
    try {
      return await ai.explainChange(payload);
    } catch (err) {
      throw new Error(`AI 改动解释失败：${err.message}`);
    }
  });

  ipcMain.handle('ai:analyzeFile', async (event, payload) => {
    try {
      ai.setChunkSender((runId, text) => {
        if (!event.sender.isDestroyed()) event.sender.send('ai:chunk', { runId, text });
      });
      return await ai.analyzeFile(payload);
    } catch (err) {
      throw new Error(`AI 单文件分析失败：${err.message}`);
    }
  });

  ipcMain.handle('ai:explainFull', async (event, payload) => {
    try {
      ai.setChunkSender((runId, text) => {
        if (!event.sender.isDestroyed()) event.sender.send('ai:chunk', { runId, text });
      });
      return await ai.explainFull(payload);
    } catch (err) {
      throw new Error(`AI 完整讲解失败：${err.message}`);
    }
  });

  ipcMain.handle('review:save', async (_event, payload) => {
    try {
      return store.saveReview(payload);
    } catch (err) {
      throw new Error(`保存评审失败：${err.message}`);
    }
  });

  ipcMain.handle('review:list', async (_event, folder) => {
    return store.listReviews(folder);
  });

  ipcMain.handle('review:export', async (_event, payload) => {
    const result = await dialog.showSaveDialog({
      defaultPath: payload.defaultName,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fs.promises.writeFile(result.filePath, payload.markdown, 'utf8');
    return result.filePath;
  });

  ipcMain.handle('recent:list', async () => {
    return store.getRecentProjects();
  });

  ipcMain.handle('recent:add', async (_event, folder) => {
    return store.addRecentProject(folder);
  });

  ipcMain.handle('watch:start', async (event, folder) => {
    try {
      startWatcher(folder, event.sender);
    } catch (err) {
      stopWatcher();
      throw new Error(`监听目录失败：${err.message}`);
    }
  });

  ipcMain.handle('watch:stop', async () => {
    stopWatcher();
  });

  ipcMain.handle('ai:testConnection', async (_event, settings) => {
    try {
      return await ai.testConnection(settings);
    } catch (err) {
      return { ok: false, message: `连接失败：${err.message}` };
    }
  });

  ipcMain.handle('ai:listModels', async (_event, settings) => {
    return ai.listModels(settings);
  });

  ipcMain.handle('ai:getCurrentRun', async () => ai.getCurrentRun());

  ipcMain.handle('ai:cancel', async () => ai.cancelRun());

  ipcMain.handle('ai:pause', async () => ai.pauseRun());

  ipcMain.handle('ai:resume', async () => {
    try {
      return await ai.resumeRun();
    } catch (err) {
      throw new Error(`继续运行失败：${err.message}`);
    }
  });

  ipcMain.handle('ai:explainFollowUp', async (event, payload) => {
    try {
      ai.setChunkSender((runId, text) => {
        if (!event.sender.isDestroyed()) event.sender.send('ai:chunk', { runId, text });
      });
      return await ai.explainFollowUp(payload);
    } catch (err) {
      throw new Error(`AI 追问失败：${err.message}`);
    }
  });

  ipcMain.handle('update:check', async () => {
    try {
      return await updateChecker.checkForUpdates();
    } catch (err) {
      throw new Error(err.message && err.message.includes('检查更新失败')
        ? err.message
        : `检查更新失败：${err.message}`);
    }
  });

  ipcMain.handle('update:download', async (event, dmgUrl) => {
    const { shell } = require('electron');
    try {
      const filePath = await updateChecker.downloadUpdate(dmgUrl, (percent) => {
        if (!event.sender.isDestroyed()) event.sender.send('update:progress', percent);
      });
      shell.openPath(filePath);
      return filePath;
    } catch (err) {
      throw new Error(err.message && err.message.includes('下载失败')
        ? err.message
        : `下载失败：${err.message}`);
    }
  });
}

app.whenReady().then(() => {
  // 开发模式下 Dock 也使用自定义图标（打包后由 bundle 自带）
  if (!app.isPackaged && app.dock) {
    try {
      app.dock.setIcon(path.join(__dirname, '..', 'build', 'icon.png'));
    } catch { /* 图标加载失败不影响启动 */ }
  }
  iconManager.applyOnStartup();
  registerIpcHandlers();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

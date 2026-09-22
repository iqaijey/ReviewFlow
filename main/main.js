const { app, BrowserWindow, dialog, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const git = require('./git');
const ai = require('./ai');
const settingsStore = require('./settings');
const iconManager = require('./iconManager');
const store = require('./store');
const planStore = require('./planStore');
const updateChecker = require('./updateChecker');

// 窗口位置/尺寸记忆：启动时恢复上次 bounds（位置校验仍在屏幕范围内，不在则只恢复尺寸），
// resize/move 防抖 1s 写回，close 时立即写一次
function readWindowState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function normalizeWindowState(data, displays) {
  if (!data || typeof data.width !== 'number' || typeof data.height !== 'number') return null;
  const state = { width: Math.round(data.width), height: Math.round(data.height) };
  if (typeof data.x === 'number' && typeof data.y === 'number') {
    const x = Math.round(data.x);
    const y = Math.round(data.y);
    const visible = (Array.isArray(displays) ? displays : []).some((d) => {
      const a = d && d.workArea;
      return a && x >= a.x - 8 && y >= a.y - 8 && x < a.x + a.width && y < a.y + a.height;
    });
    if (visible) {
      state.x = x;
      state.y = y;
    }
  }
  return state;
}

function windowStatePath() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  return normalizeWindowState(readWindowState(windowStatePath()), screen.getAllDisplays());
}

function saveWindowState(win) {
  try {
    if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
    fs.writeFileSync(windowStatePath(), JSON.stringify(win.getBounds()), 'utf8');
  } catch { /* 写失败不影响使用 */ }
}

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
  const savedState = loadWindowState();
  const win = new BrowserWindow({
    width: (savedState && savedState.width) || 1440,
    height: (savedState && savedState.height) || 900,
    ...(savedState && savedState.x != null ? { x: savedState.x, y: savedState.y } : {}),
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

  let stateTimer = null;
  const scheduleStateSave = () => {
    if (stateTimer) clearTimeout(stateTimer);
    stateTimer = setTimeout(() => {
      stateTimer = null;
      saveWindowState(win);
    }, 1000);
  };
  win.on('resize', scheduleStateSave);
  win.on('move', scheduleStateSave);
  win.on('close', () => {
    if (stateTimer) {
      clearTimeout(stateTimer);
      stateTimer = null;
    }
    saveWindowState(win);
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

// 方案图片的磁盘绝对路径（与 planStore 存储结构一致：plans/<sha1(folder)前16位>/<planId>/images/），
// 供 CLI 后端在 prompt 中引用；按 getPlanDetail 返回的图片顺序输出，仅保留存在的文件
function planImagePaths(folder, planId, imageNames) {
  const hash = crypto.createHash('sha1').update(String(folder)).digest('hex').slice(0, 16);
  const dir = path.join(app.getPath('userData'), 'plans', hash, String(planId), 'images');
  return (Array.isArray(imageNames) ? imageNames : [])
    .map((img) => path.basename(String((img && img.name) || img || '')))
    .filter(Boolean)
    .map((name) => path.join(dir, name))
    .filter((p) => fs.existsSync(p));
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
    const ext = payload && payload.ext === 'html' ? 'html' : 'md';
    // 兼容旧字段 markdown 兜底
    const content = payload && typeof payload.content === 'string'
      ? payload.content
      : String((payload && payload.markdown) || '');
    const result = await dialog.showSaveDialog({
      defaultPath: payload && payload.defaultName,
      filters: ext === 'html'
        ? [{ name: 'HTML', extensions: ['html'] }]
        : [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return null;
    await fs.promises.writeFile(result.filePath, content, 'utf8');
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

  ipcMain.handle('ai:reviewFollowUp', async (event, payload) => {
    try {
      ai.setChunkSender((runId, text) => {
        if (!event.sender.isDestroyed()) event.sender.send('ai:chunk', { runId, text });
      });
      return await ai.reviewFollowUp(payload);
    } catch (err) {
      throw new Error(`AI 追问失败：${err.message}`);
    }
  });

  ipcMain.handle('plan:list', async (_event, folder) => {
    try {
      return planStore.listPlans(folder);
    } catch (err) {
      throw new Error(`获取方案列表失败：${err.message}`);
    }
  });

  ipcMain.handle('plan:create', async (_event, payload) => {
    try {
      return planStore.createPlan(payload);
    } catch (err) {
      throw new Error(`创建方案失败：${err.message}`);
    }
  });

  ipcMain.handle('plan:addImage', async (_event, payload) => {
    try {
      return planStore.addPlanImage(payload);
    } catch (err) {
      throw new Error(`添加设计稿失败：${err.message}`);
    }
  });

  ipcMain.handle('plan:removeImage', async (_event, payload) => {
    try {
      return planStore.removePlanImage(payload);
    } catch (err) {
      throw new Error(`移除设计稿失败：${err.message}`);
    }
  });

  ipcMain.handle('plan:detail', async (_event, folder, planId) => {
    try {
      return planStore.getPlanDetail(folder, planId);
    } catch (err) {
      throw new Error(`获取方案详情失败：${err.message}`);
    }
  });

  ipcMain.handle('plan:generate', async (event, payload) => {
    try {
      const { folder, planId, extraRequirement, runId } = payload || {};
      const detail = planStore.getPlanDetail(folder, planId);
      if (!detail) throw new Error('方案不存在或已被删除');
      ai.setChunkSender((id, text) => {
        if (!event.sender.isDestroyed()) event.sender.send('ai:chunk', { runId: id, text });
      });
      const { markdown, stats } = await ai.generatePlan({
        prdText: detail.prdText,
        prdFileName: detail.prdFileName,
        imagePaths: planImagePaths(folder, planId, detail.images),
        extraRequirement,
      }, null, { runId, folder });
      planStore.savePlanResult({ folder, planId, markdown });
      return { markdown, stats };
    } catch (err) {
      throw new Error(`生成方案失败：${err.message}`);
    }
  });

  ipcMain.handle('plan:delete', async (_event, folder, planId) => {
    try {
      return planStore.deletePlan(folder, planId);
    } catch (err) {
      throw new Error(`删除方案失败：${err.message}`);
    }
  });

  ipcMain.handle('plan:setActive', async (_event, folder, planId) => {
    try {
      return planStore.setActivePlan(folder, planId);
    } catch (err) {
      throw new Error(`设置启用方案失败：${err.message}`);
    }
  });

  ipcMain.handle('plan:getActive', async (_event, folder) => {
    try {
      return planStore.getActivePlan(folder);
    } catch (err) {
      throw new Error(`获取启用方案失败：${err.message}`);
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

// 导出窗口状态读写逻辑供 node 层测试（Electron 运行时不使用）
module.exports = { readWindowState, normalizeWindowState, saveWindowState };

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('autoReview', {
  getInitialFolder: () => ipcRenderer.invoke('app:getInitialFolder'),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  pickIconImage: () => ipcRenderer.invoke('icon:pick'),
  applyIcon: (imagePath) => ipcRenderer.invoke('icon:apply', imagePath),
  resetIcon: () => ipcRenderer.invoke('icon:reset'),
  currentIcon: () => ipcRenderer.invoke('icon:current'),
  selectProjectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  getChanges: (folder, options) => ipcRenderer.invoke('git:getChanges', folder, options),
  getBranches: (folder) => ipcRenderer.invoke('git:getBranches', folder),
  getCommits: (folder) => ipcRenderer.invoke('git:getCommits', folder),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  analyzeOverview: (payload) => ipcRenderer.invoke('ai:analyzeOverview', payload),
  analyzeFile: (payload) => ipcRenderer.invoke('ai:analyzeFile', payload),
  explainChange: (payload) => ipcRenderer.invoke('ai:explainChange', payload),
  testConnection: (settings) => ipcRenderer.invoke('ai:testConnection', settings),
  listModels: (settings) => ipcRenderer.invoke('ai:listModels', settings),
  getCurrentRun: () => ipcRenderer.invoke('ai:getCurrentRun'),
  saveReview: (payload) => ipcRenderer.invoke('review:save', payload),
  listReviews: (folder) => ipcRenderer.invoke('review:list', folder),
  exportReview: (payload) => ipcRenderer.invoke('review:export', payload),
  getRecentProjects: () => ipcRenderer.invoke('recent:list'),
  addRecentProject: (folder) => ipcRenderer.invoke('recent:add', folder),
  startWatch: (folder) => ipcRenderer.invoke('watch:start', folder),
  stopWatch: () => ipcRenderer.invoke('watch:stop'),
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: (dmgUrl) => ipcRenderer.invoke('update:download', dmgUrl),
  onUpdateProgress: (callback) => {
    const listener = (_event, percent) => callback(percent);
    ipcRenderer.on('update:progress', listener);
    return () => ipcRenderer.removeListener('update:progress', listener);
  },
  onAiChunk: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('ai:chunk', listener);
    return () => ipcRenderer.removeListener('ai:chunk', listener);
  },
  onFsChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('fs:changed', listener);
    return () => ipcRenderer.removeListener('fs:changed', listener);
  },
});

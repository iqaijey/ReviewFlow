const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('autoReview', {
  getInitialFolder: () => ipcRenderer.invoke('app:getInitialFolder'),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  setWindowTheme: (theme) => ipcRenderer.send('app:setTheme', theme),
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
  exportPresets: () => ipcRenderer.invoke('preset:export'),
  importPresets: () => ipcRenderer.invoke('preset:import'),
  analyzeOverview: (payload) => ipcRenderer.invoke('ai:analyzeOverview', payload),
  analyzeOverviewMulti: (payload) => ipcRenderer.invoke('ai:analyzeOverviewMulti', payload),
  analyzeFile: (payload) => ipcRenderer.invoke('ai:analyzeFile', payload),
  explainFull: (payload) => ipcRenderer.invoke('ai:explainFull', payload),
  explainChange: (payload) => ipcRenderer.invoke('ai:explainChange', payload),
  testConnection: (settings) => ipcRenderer.invoke('ai:testConnection', settings),
  listModels: (settings) => ipcRenderer.invoke('ai:listModels', settings),
  getCurrentRun: () => ipcRenderer.invoke('ai:getCurrentRun'),
  listRuns: () => ipcRenderer.invoke('ai:listRuns'),
  getRunPrompt: (runId) => ipcRenderer.invoke('ai:getRunPrompt', runId),
  cancelRun: (runId) => ipcRenderer.invoke('ai:cancel', runId),
  pauseRun: (runId) => ipcRenderer.invoke('ai:pause', runId),
  resumeRun: (runId) => ipcRenderer.invoke('ai:resume', runId),
  explainFollowUp: (payload) => ipcRenderer.invoke('ai:explainFollowUp', payload),
  reviewFollowUp: (payload) => ipcRenderer.invoke('ai:reviewFollowUp', payload),
  listChatThreads: (payload) => ipcRenderer.invoke('chat:list', payload),
  getChatThread: (payload) => ipcRenderer.invoke('chat:get', payload),
  createChatThread: (payload) => ipcRenderer.invoke('chat:create', payload),
  sendChatMessage: (payload) => ipcRenderer.invoke('chat:send', payload),
  listFileAnalyses: (payload) => ipcRenderer.invoke('fileAnalysis:list', payload),
  generateFixPatch: (payload) => ipcRenderer.invoke('fix:generatePatch', payload),
  applyFixPatch: (payload) => ipcRenderer.invoke('fix:applyPatch', payload),
  revertFixPatch: (payload) => ipcRenderer.invoke('fix:revertPatch', payload),
  verifyFinding: (payload) => ipcRenderer.invoke('fix:verifyFinding', payload),
  getHandoffPrompt: (payload) => ipcRenderer.invoke('fix:handoffPrompt', payload),
  estimateRun: (payload) => ipcRenderer.invoke('ai:estimate', payload),
  saveReview: (payload) => ipcRenderer.invoke('review:save', payload),
  updateReviewStats: (payload) => ipcRenderer.invoke('review:updateStats', payload),
  listReviews: (folder, options) => ipcRenderer.invoke('review:list', folder, options),
  getReview: (payload) => ipcRenderer.invoke('review:get', payload),
  deleteReview: (payload) => ipcRenderer.invoke('review:delete', payload),
  renameReview: (payload) => ipcRenderer.invoke('review:rename', payload),
  setReviewPinned: (payload) => ipcRenderer.invoke('review:setPinned', payload),
  checklistList: (folder) => ipcRenderer.invoke('checklist:list', folder),
  checklistSave: (payload) => ipcRenderer.invoke('checklist:save', payload),
  checklistSetStatus: (payload) => ipcRenderer.invoke('checklist:setStatus', payload),
  checklistClear: (payload) => ipcRenderer.invoke('checklist:clear', payload),
  checklistRuleSuggestions: (payload) => ipcRenderer.invoke('checklist:ruleSuggestions', payload),
  checklistDismissRuleSuggestion: (payload) => ipcRenderer.invoke('checklist:dismissRuleSuggestion', payload),
  previewRuleAppend: (payload) => ipcRenderer.invoke('rules:previewAppend', payload),
  appendProjectRule: (payload) => ipcRenderer.invoke('rules:append', payload),
  getEffectiveRules: (payload) => ipcRenderer.invoke('rules:effective', payload),
  exportReview: (payload) => ipcRenderer.invoke('review:export', payload),
  listPlans: (folder) => ipcRenderer.invoke('plan:list', folder),
  createPlan: (payload) => ipcRenderer.invoke('plan:create', payload),
  addPlanImage: (payload) => ipcRenderer.invoke('plan:addImage', payload),
  removePlanImage: (payload) => ipcRenderer.invoke('plan:removeImage', payload),
  getPlanDetail: (folder, planId) => ipcRenderer.invoke('plan:detail', folder, planId),
  generatePlan: (payload) => ipcRenderer.invoke('plan:generate', payload),
  deletePlan: (folder, planId) => ipcRenderer.invoke('plan:delete', folder, planId),
  setActivePlan: (folder, planId) => ipcRenderer.invoke('plan:setActive', folder, planId),
  getActivePlan: (folder) => ipcRenderer.invoke('plan:getActive', folder),
  fetchPrdFromUrl: (url) => ipcRenderer.invoke('plan:fetchPrdUrl', url),
  fetchDesignFromUrl: (url) => ipcRenderer.invoke('plan:fetchDesignUrl', url),
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
  onRunsChanged: (callback) => {
    const listener = (_event, runs) => callback(runs);
    ipcRenderer.on('ai:runs', listener);
    return () => ipcRenderer.removeListener('ai:runs', listener);
  },
  onFsChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('fs:changed', listener);
    return () => ipcRenderer.removeListener('fs:changed', listener);
  },
});

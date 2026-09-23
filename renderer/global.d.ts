// preload.js 通过 contextBridge 暴露的 API 类型声明。
// 方法名与 preload.js 一一对应；payload/返回值暂用 any，后续可逐步细化。
type Unsubscribe = () => void;

interface AutoReviewApi {
  getInitialFolder(): Promise<string | null>;
  getVersion(): Promise<string>;
  pickIconImage(): Promise<any>;
  applyIcon(imagePath: string): Promise<any>;
  resetIcon(): Promise<any>;
  currentIcon(): Promise<any>;
  selectProjectFolder(): Promise<string | null>;
  getChanges(folder: string, options?: any): Promise<any>;
  getBranches(folder: string): Promise<any>;
  getCommits(folder: string): Promise<any>;
  getSettings(): Promise<any>;
  saveSettings(settings: any): Promise<any>;
  analyzeOverview(payload: any): Promise<any>;
  analyzeFile(payload: any): Promise<any>;
  explainFull(payload: any): Promise<any>;
  explainChange(payload: any): Promise<any>;
  testConnection(settings: any): Promise<any>;
  listModels(settings: any): Promise<any>;
  getCurrentRun(): Promise<any>;
  cancelRun(): Promise<any>;
  pauseRun(): Promise<any>;
  resumeRun(): Promise<any>;
  explainFollowUp(payload: any): Promise<any>;
  reviewFollowUp(payload: any): Promise<any>;
  saveReview(payload: any): Promise<any>;
  listReviews(folder: string): Promise<any>;
  checklistList(folder: string): Promise<any>;
  checklistSave(payload: any): Promise<any>;
  checklistSetStatus(payload: any): Promise<any>;
  exportReview(payload: any): Promise<any>;
  listPlans(folder: string): Promise<any>;
  createPlan(payload: any): Promise<any>;
  addPlanImage(payload: any): Promise<any>;
  removePlanImage(payload: any): Promise<any>;
  getPlanDetail(folder: string, planId: string): Promise<any>;
  generatePlan(payload: any): Promise<any>;
  deletePlan(folder: string, planId: string): Promise<any>;
  setActivePlan(folder: string, planId: string): Promise<any>;
  getActivePlan(folder: string): Promise<any>;
  fetchPrdFromUrl(url: string): Promise<any>;
  fetchDesignFromUrl(url: string): Promise<any>;
  getRecentProjects(): Promise<string[]>;
  addRecentProject(folder: string): Promise<any>;
  startWatch(folder: string): Promise<any>;
  stopWatch(): Promise<any>;
  checkUpdates(): Promise<any>;
  downloadUpdate(dmgUrl: string): Promise<any>;
  onUpdateProgress(callback: (percent: number) => void): Unsubscribe;
  onAiChunk(callback: (data: any) => void): Unsubscribe;
  onFsChanged(callback: () => void): Unsubscribe;
}

interface Window {
  autoReview: AutoReviewApi;
}

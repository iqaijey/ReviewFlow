// preload.js 通过 contextBridge 暴露的 API 类型声明。
// 方法名与 preload.js 一一对应；payload/返回值暂用 any，后续可逐步细化。
type Unsubscribe = () => void;
type NoiseLevel = 'quiet' | 'balanced' | 'detailed';
type FindingStatus = 'pending' | 'fixed' | 'partial' | 'outdated' | 'wontfix';
type FindingCategory = '安全' | '正确性' | '性能' | '可维护性' | '需求符合度' | '其他';
type DismissalReason = 'false_positive' | 'intentional' | 'handled_elsewhere' | 'other';
type VerificationVerdict = '已修复' | '仍存在' | '部分修复' | '已过时';
interface FindingLocation {
  path: string; side: 'new' | 'old'; startLine: number | null; endLine: number | null;
  anchor: { target: string[]; before: string[]; after: string[] } | null;
}
interface FindingVerification { reviewId: string; verdict: VerificationVerdict; note: string; applied: boolean; conflict: string | null }
interface Finding {
  schemaVersion: 2; id: string; text: string; severity: '高' | '中' | '低' | null; category: FindingCategory;
  location: FindingLocation | null; fingerprint: string; status: FindingStatus;
  dismissal: { reason: DismissalReason; note: string; createdAt: number } | null;
  createdAt: number; updatedAt: number; firstSeenReviewId: string | null; lastSeenReviewId: string | null;
  lastVerifiedAt: number | null; verification: FindingVerification | null;
}
interface RuleSuggestion {
  schemaVersion: 2; id: string; memberFindingIds: string[]; representativeText: string; category: FindingCategory;
  scope: string; reason: DismissalReason; note: string; snippet: string; state: 'suggested' | 'dismissed' | 'applied';
}
interface ReviewStats {
  backend?: string | null; model?: string | null; effort?: string; promptTokens?: number | null;
  completionTokens?: number | null; durationMs?: number;
  [key: string]: unknown;
}
interface ReviewModelResult {
  label?: string; backend: 'api' | 'opencode' | 'kimi' | 'codex'; model: string | null;
  markdown?: string | null; error?: string | null; stats?: ReviewStats | null;
}
interface HistoryModelResult extends ReviewModelResult {
  slotId: string; role: 'reviewer' | 'synthesizer'; effort: string; outcome: 'complete' | 'failed' | 'partial';
  markdown: string | null; error: string | null; stats: ReviewStats | null;
}
type ReviewMode = 'uncommitted' | 'branch' | 'ref' | 'commits' | 'staged' | 'unstaged' | 'untracked';
interface ReviewSource {
  mode: ReviewMode | null; requestedBase: string | null; branch: string | null; headSha: string | null; baseSha: string | null;
  commits: Array<{ sha: string; parentShas: string[] }>;
  semantics: 'head-to-worktree' | 'base-to-worktree' | 'concatenated-show' | 'commit-range' | 'head-to-index' | 'index-to-worktree' | 'untracked-only' | null;
  nonContiguous?: boolean;
}
interface ReviewSnapshotFile {
  path: string; oldPath: string | null; status: string; resource: boolean; excluded?: boolean; diffFingerprint: string; reviewed: boolean; truncated: boolean;
  readonly aiTruncated?: boolean;
}
interface ReviewBackend {
  slotId: string; role: 'reviewer' | 'synthesizer'; backend: string; requestedModel: string | null;
  resolvedModel: string | null; modelSource: 'settings' | 'cli-config' | 'backend-default'; effort: string;
}
interface Provenance {
  capturedAt: number; source: ReviewSource; diffFingerprint: string; files: ReviewSnapshotFile[];
  plan: { id: string; title: string; contextHash: string } | null; preset: { id: string; name: string } | null;
  projectRules: { fileHash: string | null; injectedHash: string; files?: string[] }; appVersion: string; promptVersion: string;
  promptInputsHash: string; noiseLevel: NoiseLevel; backends: ReviewBackend[];
}
interface ReviewSnapshot { snapshotId: string; capturedAt: number; source: ReviewSource; diffFingerprint: string; files: ReviewSnapshotFile[] }
interface ReviewChangesOptions { mode?: ReviewMode; base?: string | null; commits?: string[] | null }
interface ReviewChangesResult {
  branch: string; base: string | null; commits: string[] | null; files: ReviewDiffFile[];
  snapshotId: string; source: ReviewSource; diffFingerprint: string;
  limits: { maxFiles: number; totalFiles: number; omittedFiles: string[]; truncatedFiles: Array<{ path: string; shownLines: number }>;
    skippedUntracked: Array<{ path: string; reason: 'too-large' | 'binary' | 'unreadable' }> };
}
interface EffectiveRulesResult {
  files: Array<{ path: string; chars: number; included: boolean; truncated: boolean }>;
  text: string; truncated: boolean; totalChars: number;
}
interface ReviewProvenancePayload {
  snapshotId?: string; presetId?: string; presetName?: string; planId?: string; planTitle?: string; planEnabled?: boolean;
}
interface ReviewHistoryEntry {
  schemaVersion: 2; id: string; title: string; createdAt: number; updatedAt: number; kind: string; pinned: boolean;
  markdown: string; stats: ReviewStats | null; provenance: Provenance | null; noiseLevel: NoiseLevel | null;
  findings: Finding[]; verificationResults: Array<FindingVerification & { id: string }>; perModel: HistoryModelResult[];
  chatContext?: ChatContext | null; persistenceWarnings?: string[]; coverageNotices?: string[];
}
interface ReviewDiffFile {
  path: string; oldPath?: string; status: string; resource?: boolean; diffFingerprint?: string; truncated?: boolean;
  excluded?: boolean; excludedBy?: string;
  classes?: Array<{ name: string; kind: string; startLine: number; endLine: number; changed: boolean }>;
  hunks: Array<{ header: string; oldStart?: number; newStart?: number; oldLines?: number; newLines?: number;
    lines: Array<{ type: string; content: string; oldLine?: number | null; newLine?: number | null }> }>;
}
interface ReviewRunPayload extends ReviewProvenancePayload {
  folder: string; files: ReviewDiffFile[]; runId?: string | null; title?: string; kind?: string;
  customPromptOverride?: string; planContext?: string; customDimensionsOverride?: string; previousReview?: string;
  pendingIssues?: string[]; noiseLevelOverride?: NoiseLevel;
}
interface MultiReviewRunPayload extends ReviewRunPayload {
  models?: Array<{ slotId?: string; backend: ReviewModelResult['backend']; model?: string; effort?: string }>;
  synthesizer?: { slotId?: string; backend: ReviewModelResult['backend']; model?: string; effort?: string } | null;
}
interface ReviewRunResult {
  markdown: string; stats: ReviewStats | null; perModel?: ReviewModelResult[];
  paused?: boolean; failed?: { stage: 'batch' | 'synthesis'; batchIndex: number; batchTotal: number; message: string };
  reviewId?: string; historyEntry?: ReviewHistoryEntry | null; checklist?: Finding[]; persistenceWarnings?: string[]; coverageNotices?: string[];
}
interface AiRunInfo {
  readonly runId: string; readonly parentRunId?: string; readonly kind: string; readonly batch: string;
  readonly paused?: boolean; readonly batchIndex?: number | null; readonly batchTotal?: number | null;
  readonly startedAt: number; readonly backend?: string; readonly model?: string; readonly effort?: string;
  readonly command?: string; readonly promptChars?: number;
}
interface ChecklistStatusPayload {
  folder: string; id: string; status: FindingStatus; expectedUpdatedAt?: number;
  dismissal?: { reason: DismissalReason; note?: string };
}

type ChatKind = 'review' | 'review-section' | 'full' | 'line';
type ChatMessageStatus = 'pending' | 'complete' | 'failed' | 'cancelled' | 'interrupted';
type DiffHunk = ReviewDiffFile['hunks'][number];
interface ChatSelection { path: string; hunk: DiffHunk; selectedLineIndexes: number[] }
interface ChatContext {
  diffFingerprint: string | null; source: ReviewSource | null; codeContext: string; planContext: string;
  projectRulesText: string; initialMarkdown: string; selection: ChatSelection[]; truncated: boolean;
}
interface ChatMessage {
  id: string; requestId: string; role: 'user' | 'assistant'; content: string; createdAt: number;
  status: ChatMessageStatus; stats: ReviewStats | null; error: string | null;
}
interface ChatThreadSummary {
  schemaVersion: 2; id: string; kind: ChatKind; reviewId: string | null; sectionTitle: string | null;
  title: string; createdAt: number; updatedAt: number;
}
interface ChatThread extends ChatThreadSummary { context: ChatContext; messages: ChatMessage[]; persistenceWarnings?: string[] }
interface FileAnalysisPayload extends ReviewProvenancePayload {
  folder: string; file: ReviewDiffFile; runId?: string | null; planContext?: string;
  noiseLevelOverride?: NoiseLevel; customPromptOverride?: string; force?: boolean;
}
interface FileAnalysisResult {
  markdown: string; stats: ReviewStats | null; cacheHit: boolean; cacheKey: string | null; cachedAt: number | null;
  readonly reusable?: boolean;
  readonly coverageNotices: string[];
  persistenceWarnings?: string[];
}
interface ExplainChangePayload {
  folder: string; filePath: string; hunk?: DiffHunk; line?: DiffHunk['lines'][number];
  segments?: Array<{ filePath?: string; hunk: DiffHunk; lines: DiffHunk['lines'] }>;
  runId?: string | null; planContext?: string;
}

interface FixFindingPayload { readonly folder: string; readonly findingId: string; readonly runId: string }
interface FixPatchFile { readonly path: string; readonly additions: number; readonly deletions: number }
interface FixPatchPreview {
  readonly patchId: string; readonly diff: string; readonly files: FixPatchFile[];
  readonly check: { readonly ok: boolean; readonly error: string | null }; readonly stats: ReviewStats;
}
interface EstimatePayload {
  readonly folder: string; readonly kind: 'overview' | 'full' | 'file'; readonly snapshotId?: string;
  readonly files?: ReviewDiffFile[]; readonly filePath?: string; readonly noiseLevelOverride?: NoiseLevel; readonly planEnabled?: boolean;
  readonly multiModels?: NonNullable<MultiReviewRunPayload['models']> | Pick<MultiReviewRunPayload, 'models' | 'synthesizer'>;
}
interface RunEstimate {
  readonly calls: number; readonly inputChars: number; readonly inputTokens: number; readonly maxOutputTokens: number;
  readonly perBackend: Array<{ readonly backend: string; readonly model: string; readonly calls: number; readonly inputTokens: number }>;
  readonly cost: { readonly currency: 'USD' | 'CNY'; readonly min: number; readonly max: number } | null; readonly notes: string[];
}
interface Settings {
  provider?: string; backend: string; baseUrl: string; apiKey: string; apiKeySet?: boolean; apiKeyHint?: string;
  clearApiKey?: boolean; model: string; opencodeModel?: string; kimiModel?: string; codexModel?: string;
  customPrompt?: string; customDimensions?: string; reasoningEffort?: string; noiseLevel?: NoiseLevel;
  timeoutMin?: number; overviewWidth?: number;
  excludePatterns?: string[];
  pricing?: Record<string, { inputPerMTokens: number; outputPerMTokens: number; currency: 'USD' | 'CNY' }>;
  presets?: Array<{ id: string; name: string; dimensions: string[]; customPrompt: string; backend: string; model: string; effort: string }>;
}

interface AutoReviewApi {
  getInitialFolder(): Promise<string | null>;
  getVersion(): Promise<string>;
  setWindowTheme(theme: string): void;
  pickIconImage(): Promise<any>;
  applyIcon(imagePath: string): Promise<any>;
  resetIcon(): Promise<any>;
  currentIcon(): Promise<any>;
  selectProjectFolder(): Promise<string | null>;
  getChanges(folder: string, options?: ReviewChangesOptions): Promise<ReviewChangesResult>;
  getEffectiveRules(payload: { folder: string; paths: string[] }): Promise<EffectiveRulesResult>;
  getBranches(folder: string): Promise<any>;
  getCommits(folder: string): Promise<any>;
  getSettings(): Promise<Settings>;
  saveSettings(settings: Partial<Settings>): Promise<void>;
  exportPresets(): Promise<any>;
  importPresets(): Promise<any>;
  analyzeOverview(payload: ReviewRunPayload): Promise<ReviewRunResult>;
  analyzeOverviewMulti(payload: MultiReviewRunPayload): Promise<ReviewRunResult>;
  analyzeFile(payload: FileAnalysisPayload): Promise<FileAnalysisResult>;
  explainFull(payload: ReviewRunPayload): Promise<ReviewRunResult>;
  explainChange(payload: ExplainChangePayload): Promise<{ markdown: string; stats: ReviewStats | null; threadId: string; persistenceWarnings: string[] }>;
  testConnection(settings: any): Promise<any>;
  listModels(settings: any): Promise<any>;
  getCurrentRun(): Promise<AiRunInfo | null>;
  listRuns(): Promise<AiRunInfo[]>;
  getRunPrompt(runId: string): Promise<string>;
  cancelRun(runId?: string): Promise<any>;
  pauseRun(runId?: string): Promise<any>;
  resumeRun(runId?: string): Promise<ReviewRunResult | null>;
  explainFollowUp(payload: any): Promise<any>;
  reviewFollowUp(payload: any): Promise<any>;
  listChatThreads(payload: { folder: string; reviewId?: string; kind?: ChatKind }): Promise<ChatThreadSummary[]>;
  getChatThread(payload: { folder: string; id: string }): Promise<ChatThread | null>;
  createChatThread(payload: { folder: string; reviewId: string; sectionTitle?: string }): Promise<ChatThread>;
  sendChatMessage(payload: { folder: string; threadId: string; question: string; requestId: string; runId: string }): Promise<{ thread: ChatThread; markdown: string; stats: ReviewStats | null }>;
  listFileAnalyses(payload: { folder: string; snapshotId: string; planId?: string; noiseLevelOverride?: NoiseLevel }): Promise<Array<FileAnalysisResult & { path: string; reusable: boolean }>>;
  generateFixPatch(payload: FixFindingPayload & { readonly extraInstruction?: string }): Promise<FixPatchPreview>;
  applyFixPatch(payload: { readonly folder: string; readonly patchId: string; readonly confirmed: true }): Promise<{ applied: true; files: FixPatchFile[] }>;
  revertFixPatch(payload: { readonly folder: string; readonly patchId: string; readonly confirmed: true }): Promise<{ reverted: true; finding?: Finding }>;
  verifyFinding(payload: FixFindingPayload): Promise<{ verdict: VerificationVerdict | null; note: string; finding: Finding | null }>;
  getHandoffPrompt(payload: { readonly folder: string; readonly findingIds: string[] }): Promise<{ markdown: string; commands: Array<{ label: string; command: string }> }>;
  estimateRun(payload: EstimatePayload): Promise<RunEstimate>;
  saveReview(payload: any): Promise<any>;
  updateReviewStats(payload: any): Promise<any>;
  listReviews(folder: string, options?: { query?: string; kind?: string }): Promise<ReviewHistoryEntry[]>;
  getReview(payload: { folder: string; id: string }): Promise<ReviewHistoryEntry | null>;
  deleteReview(payload: { folder: string; id: string }): Promise<{ deleted: boolean; persistenceWarnings?: string[] }>;
  renameReview(payload: { folder: string; id: string; title: string }): Promise<ReviewHistoryEntry>;
  setReviewPinned(payload: { folder: string; id: string; pinned: boolean }): Promise<ReviewHistoryEntry>;
  checklistList(folder: string): Promise<Finding[]>;
  checklistSave(payload: { folder: string; items: Array<Partial<Finding> & { text: string }> }): Promise<Finding[]>;
  checklistSetStatus(payload: ChecklistStatusPayload): Promise<Finding[]>;
  checklistClear(payload: { folder: string; confirmed: true }): Promise<Finding[]>;
  checklistRuleSuggestions(payload: { folder: string }): Promise<RuleSuggestion[]>;
  checklistDismissRuleSuggestion(payload: { folder: string; id: string }): Promise<RuleSuggestion>;
  previewRuleAppend(payload: { folder: string; suggestionId: string; snippet: string }): Promise<{ previewId: string; expectedHash: string | null; resultingText: string; truncatedByPromptLimit: boolean }>;
  appendProjectRule(payload: { folder: string; previewId: string; confirmed: true }): Promise<{ fileHash: string; suggestion: RuleSuggestion; persistenceWarnings: string[] }>;
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
  onRunsChanged(callback: (runs: Awaited<ReturnType<AutoReviewApi['listRuns']>>) => void): Unsubscribe;
  onFsChanged(callback: () => void): Unsubscribe;
}

interface Window {
  autoReview: AutoReviewApi;
}

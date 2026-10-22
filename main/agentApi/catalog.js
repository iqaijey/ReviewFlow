// 外部 Agent 工具目录：IPC 通道一一对应，入参统一为对象，按 args 映射成 IPC 位置参数。
// 本文件不依赖 electron，MCP 桥在应用未运行时也能直接列出工具。
const fs = require('fs');
const path = require('path');

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const N = (description) => ({ type: 'number', description });
const B = (description) => ({ type: 'boolean', description });
const O = (description) => ({ type: 'object', description, additionalProperties: true });
const A = (description, items = {}) => ({ type: 'array', description, items });

const folder = S('项目根目录绝对路径');
const id = S('记录 id');
const planId = S('方案 id');
const runId = S('运行 id，可用于 ai_cancel/ai_pause；不传则自动生成');
const confirmed = { type: 'boolean', const: true, description: '必须为 true，表示已确认此破坏性操作' };
const noise = S('噪声档位', { enum: ['quiet', 'balanced', 'detailed'] });
const mode = S('改动来源', { enum: ['uncommitted', 'branch', 'ref', 'commits', 'staged', 'unstaged', 'untracked'] });
const source = { mode, base: S('对比基准（分支/ref，可写 A..B 或 A...B），mode 为 branch/ref 时必填'), commits: A('提交 SHA 列表，mode 为 commits 时必填', { type: 'string' }) };
const waitSec = N('最多等待秒数（默认 50，最大 600）；超时返回 state=running 和 jobId，再用 agent_waitJob 继续等');
const hunk = O('git_getChanges 返回的 files[].hunks[] 中的一项');

/**
 * @typedef {{
 *   name: string, channel?: string, description: string, params?: Record<string, object>, required?: string[],
 *   args?: 'payload' | Array<string | string[]>, open?: boolean, long?: boolean, autoIds?: string[],
 *   scopes?: string[], prepare?: (input: Record<string, any>) => Record<string, any>,
 * }} ToolDef
 */

/**
 * @param {string} channel
 * @param {string} description
 * @param {Omit<ToolDef, 'name' | 'channel' | 'description'>} [opts]
 * @returns {ToolDef}
 */
function ipc(channel, description, opts = {}) {
  return { name: channel.replace(':', '_'), channel, description, ...opts };
}
/**
 * @param {string} name
 * @param {string} description
 * @param {Omit<ToolDef, 'name' | 'channel' | 'description'>} [opts]
 * @returns {ToolDef}
 */
function composite(name, description, opts = {}) {
  return { name, description, ...opts };
}

/** @param {Record<string, any>} input */
function readImageFile(input) {
  if (typeof input.filePath !== 'string' || !input.filePath) return input;
  const { filePath, ...rest } = input;
  return { ...rest, name: rest.name || path.basename(filePath), base64: fs.readFileSync(filePath).toString('base64') };
}

/** @type {ToolDef[]} */
const TOOLS = [
  composite('review_start', '推荐入口：按改动来源拉取 diff 并发起一次评审（kind=review 多角度评审 / full 完整讲解），完成后自动保存历史并合并问题清单。耗时较长，见 waitSec。', {
    params: { folder, kind: S('review 或 full，默认 review', { enum: ['review', 'full'] }), ...source, title: S('历史记录标题'),
      noiseLevel: noise, compareWithLast: B('对比上次评审'), usePlan: B('参照当前启用的需求方案，默认 true'),
      presetId: S('评审预设 id（settings_get 的 presets）；与界面选预设一样，会把预设的后端/模型/思考强度写入设置'), customPrompt: S('本次自定义提示词'),
      models: A('多模型评审：至少 2 项，如 [{"backend":"api"},{"backend":"codex"}]', O('模型')), synthesizer: O('多模型汇总模型，如 {"backend":"api"}'),
      runId, waitSec },
    required: ['folder'], long: true, autoIds: ['runId'], scopes: ['findings', 'history', 'settings'] }),
  composite('file_analyze', '对单个改动文件做 AI 分析（结果会缓存）。', {
    params: { folder, path: S('文件相对路径（changes_summary 中的 path）'), ...source, force: B('忽略缓存重新分析'),
      noiseLevel: noise, usePlan: B('参照当前需求方案，默认 true'), presetId: S('评审预设 id'), runId, waitSec },
    required: ['folder', 'path'], long: true, autoIds: ['runId'], scopes: ['settings'] }),
  composite('changes_summary', '列出改动文件摘要（路径、状态、增删行数），不含 diff 正文；需要正文用 git_getChanges。', {
    params: { folder, ...source }, required: ['folder'] }),
  composite('app_openProject', '让 ReviewFlow 窗口切换到指定项目（与在界面里打开项目相同）。', { params: { folder }, required: ['folder'] }),
  composite('settings_getSecret', '读取完整设置，包含明文 API Key。', {}),
  composite('agent_waitJob', '继续等待一个长任务（review_start、fix_generatePatch 等返回的 jobId）。', {
    params: { jobId: S('任务 id'), waitSec }, required: ['jobId'] }),
  composite('agent_listJobs', '列出本次应用运行期间由外部 Agent 发起的长任务及状态。', {}),

  ipc('app:getInitialFolder', '启动参数里传入的项目路径', { args: [] }),
  ipc('app:getVersion', '应用版本号', { args: [] }),
  ipc('icon:pick', '弹出系统对话框让用户选择图标图片（需用户在界面操作）', { args: [] }),
  ipc('icon:apply', '把指定图片设为应用图标', { params: { imagePath: S('图片绝对路径（png/jpg/webp）') }, required: ['imagePath'], args: ['imagePath'] }),
  ipc('icon:reset', '恢复默认应用图标', { args: [] }),
  ipc('icon:current', '当前自定义图标信息', { args: [] }),
  ipc('dialog:selectFolder', '弹出选择文件夹对话框（需用户在界面操作）', { args: [] }),
  ipc('git:getChanges', '拉取改动及完整 diff（可能很大）；返回的 snapshotId 可用于 ai_estimate、fileAnalysis_list', {
    params: { folder, ...source }, required: ['folder'], args: ['folder', ['mode', 'base', 'commits']] }),
  ipc('git:getBranches', '分支列表', { params: { folder }, required: ['folder'], args: ['folder'] }),
  ipc('git:getCommits', '最近提交列表', { params: { folder }, required: ['folder'], args: ['folder'] }),
  ipc('settings:get', '读取设置（API Key 脱敏；明文用 settings_getSecret）', { args: [] }),
  ipc('settings:save', '保存设置（只传要改的字段）。常用字段：backend(api/opencode/kimi/codex)、baseUrl、apiKey、clearApiKey、model、opencodeModel、kimiModel、codexModel、customPrompt、customDimensions、reasoningEffort、noiseLevel、timeoutMin、excludePatterns、pricing、presets', {
    params: {}, open: true, scopes: ['settings'] }),
  ipc('preset:export', '导出评审预设为 JSON；传 filePath 直接写文件，否则弹出保存对话框', { params: { filePath: S('导出文件绝对路径') }, args: [['filePath']] }),
  ipc('preset:import', '导入评审预设；传 filePath 直接读文件，否则弹出打开对话框', { params: { filePath: S('导入文件绝对路径') }, args: [['filePath']], scopes: ['settings'] }),
  ipc('ai:analyzeOverview', '底层评审接口，需要 git_getChanges 的 files；一般用 review_start', {
    params: { folder, files: A('git_getChanges 返回的 files', O('文件')), snapshotId: S('git_getChanges 返回的 snapshotId'), title: S('标题'), runId, waitSec },
    required: ['folder', 'files'], open: true, long: true, autoIds: ['runId'], scopes: ['findings', 'history'] }),
  ipc('ai:analyzeOverviewMulti', '底层多模型评审接口；一般用 review_start 并传 models', {
    params: { folder, files: A('git_getChanges 返回的 files', O('文件')), models: A('模型列表', O('模型')), synthesizer: O('汇总模型'), runId, waitSec },
    required: ['folder', 'files', 'models'], open: true, long: true, autoIds: ['runId'], scopes: ['findings', 'history'] }),
  ipc('ai:explainChange', '逐句解析：解释选中的改动代码', {
    params: { folder, filePath: S('文件相对路径'), hunk, line: O('hunk.lines 中的一行'), segments: A('多段选区 [{filePath,hunk,lines}]', O('选区')), planContext: S('需求方案上下文'), runId, waitSec },
    required: ['folder', 'filePath'], open: true, long: true, autoIds: ['runId'], scopes: ['history'] }),
  ipc('ai:analyzeFile', '底层单文件分析接口；一般用 file_analyze', {
    params: { folder, file: O('git_getChanges 返回的单个 file'), snapshotId: S('快照 id'), force: B('忽略缓存'), runId, waitSec },
    required: ['folder', 'file'], open: true, long: true, autoIds: ['runId'] }),
  ipc('ai:explainFull', '底层完整讲解接口；一般用 review_start 并传 kind=full', {
    params: { folder, files: A('git_getChanges 返回的 files', O('文件')), snapshotId: S('快照 id'), runId, waitSec },
    required: ['folder', 'files'], open: true, long: true, autoIds: ['runId'], scopes: ['history'] }),
  ipc('review:save', '直接写入一条评审历史', { params: { folder, title: S('标题'), markdown: S('正文'), kind: S('review/full 等') }, required: ['folder'], open: true, scopes: ['history'] }),
  ipc('review:updateStats', '更新历史记录的统计信息', { params: { folder, id, stats: O('统计') }, required: ['folder', 'id', 'stats'], scopes: ['history'] }),
  ipc('review:list', '评审历史列表', { params: { folder, query: S('搜索词'), kind: S('review/full 等') }, required: ['folder'], args: ['folder', ['query', 'kind']] }),
  ipc('review:get', '读取一条评审历史全文', { params: { folder, id }, required: ['folder', 'id'] }),
  ipc('review:delete', '删除一条评审历史', { params: { folder, id }, required: ['folder', 'id'], scopes: ['history'] }),
  ipc('review:rename', '重命名评审历史', { params: { folder, id, title: S('新标题') }, required: ['folder', 'id', 'title'], scopes: ['history'] }),
  ipc('review:setPinned', '置顶或取消置顶评审历史', { params: { folder, id, pinned: B('是否置顶') }, required: ['folder', 'id', 'pinned'], scopes: ['history'] }),
  ipc('review:export', '导出文本为 md/html；传 filePath 直接写文件，否则弹出保存对话框', {
    params: { content: S('要导出的内容'), ext: S('md 或 html', { enum: ['md', 'html'] }), defaultName: S('对话框默认文件名'), filePath: S('导出文件绝对路径') }, required: ['content'] }),
  ipc('chat:list', '追问对话列表', { params: { folder, reviewId: S('评审历史 id'), kind: S('review/review-section/full/line') }, required: ['folder'] }),
  ipc('chat:get', '读取一个追问对话', { params: { folder, id }, required: ['folder', 'id'] }),
  ipc('chat:create', '基于评审历史新建追问对话', { params: { folder, reviewId: S('评审历史 id'), sectionTitle: S('针对的小节标题') }, required: ['folder', 'reviewId'], scopes: ['history'] }),
  ipc('chat:send', '在追问对话里发送问题并得到回答', {
    params: { folder, threadId: S('对话 id'), question: S('问题'), requestId: S('请求 id，不传自动生成'), runId, waitSec },
    required: ['folder', 'threadId', 'question'], long: true, autoIds: ['runId', 'requestId'], scopes: ['history'] }),
  ipc('fileAnalysis:list', '某个快照下各文件已缓存的分析结果', { params: { folder, snapshotId: S('快照 id'), planId, noiseLevelOverride: noise }, required: ['folder', 'snapshotId'] }),
  ipc('ai:estimate', '预估调用次数、token 与费用', {
    params: { folder, kind: S('overview/full/file', { enum: ['overview', 'full', 'file'] }), snapshotId: S('快照 id'), filePath: S('kind=file 时的文件') }, required: ['folder', 'kind'], open: true }),
  ipc('fix:generatePatch', '为一条问题生成修复补丁（只预览，不改文件）；仅 api/codex 后端支持', {
    params: { folder, findingId: S('问题 id'), extraInstruction: S('额外要求'), runId, waitSec }, required: ['folder', 'findingId'], long: true, autoIds: ['runId'], scopes: ['findings'] }),
  ipc('fix:applyPatch', '把补丁应用到工作区（不暂存不提交）', { params: { folder, patchId: S('补丁 id'), confirmed }, required: ['folder', 'patchId', 'confirmed'], scopes: ['findings', 'workspace'] }),
  ipc('fix:revertPatch', '撤销已应用的补丁', { params: { folder, patchId: S('补丁 id'), confirmed }, required: ['folder', 'patchId', 'confirmed'], scopes: ['findings', 'workspace'] }),
  ipc('fix:listPatches', '本项目已保存的补丁', { params: { folder }, required: ['folder'] }),
  ipc('fix:openPatch', '读取未应用补丁的 diff 并按当前工作区重新预检', { params: { folder, patchId: S('补丁 id') }, required: ['folder', 'patchId'] }),
  ipc('fix:verifyFinding', '让 AI 复核一条问题是否已修复，并更新清单', {
    params: { folder, findingId: S('问题 id'), runId, waitSec }, required: ['folder', 'findingId'], long: true, autoIds: ['runId'], scopes: ['findings'] }),
  ipc('fix:handoffPrompt', '生成交给其他编码 Agent 的修复任务提示词', { params: { folder, findingIds: A('问题 id 列表', { type: 'string' }) }, required: ['folder', 'findingIds'] }),
  ipc('checklist:list', '问题清单', { params: { folder }, required: ['folder'], args: ['folder'] }),
  ipc('checklist:save', '整体覆盖保存问题清单', { params: { folder, items: A('问题列表，每项至少含 text', O('问题')) }, required: ['folder', 'items'], scopes: ['findings'] }),
  ipc('checklist:setStatus', '修改一条问题的状态；wontfix 需带 dismissal', {
    params: { folder, id: S('问题 id'), status: S('状态', { enum: ['pending', 'fixed', 'partial', 'outdated', 'wontfix'] }), expectedUpdatedAt: N('乐观锁：问题的 updatedAt'),
      dismissal: { type: 'object', properties: { reason: S('原因', { enum: ['false_positive', 'intentional', 'handled_elsewhere', 'other'] }), note: S('备注') } } },
    required: ['folder', 'id', 'status'], scopes: ['findings'] }),
  ipc('checklist:clear', '清空本项目问题清单（并删除其补丁）', { params: { folder, confirmed }, required: ['folder', 'confirmed'], scopes: ['findings'] }),
  ipc('checklist:ruleSuggestions', '由「不处理」归纳出的规则建议', { params: { folder }, required: ['folder'] }),
  ipc('checklist:dismissRuleSuggestion', '忽略一条规则建议', { params: { folder, id }, required: ['folder', 'id'], scopes: ['findings'] }),
  ipc('rules:previewAppend', '预览把规则追加到 .reviewflow.md 的结果，返回 previewId', { params: { folder, suggestionId: S('规则建议 id'), snippet: S('要追加的规则文本') }, required: ['folder', 'suggestionId', 'snippet'] }),
  ipc('rules:append', '按 previewId 追加规则到 .reviewflow.md', { params: { folder, previewId: S('rules_previewAppend 返回的 id'), confirmed }, required: ['folder', 'previewId', 'confirmed'], scopes: ['findings'] }),
  ipc('rules:effective', '指定文件实际生效的 .reviewflow.md 规则', { params: { folder, paths: A('文件相对路径', { type: 'string' }) }, required: ['folder', 'paths'] }),
  ipc('recent:list', '最近打开的项目', { args: [] }),
  ipc('recent:add', '加入最近项目', { params: { folder }, required: ['folder'], args: ['folder'] }),
  ipc('watch:start', '让界面监听该目录的文件变化', { params: { folder }, required: ['folder'], args: ['folder'] }),
  ipc('watch:stop', '停止文件监听', { args: [] }),
  ipc('ai:testConnection', '用给定设置测试 AI 后端连通性（字段同 settings_save）', { params: {}, open: true }),
  ipc('ai:listModels', '用给定设置拉取可用模型列表（字段同 settings_save）', { params: {}, open: true }),
  ipc('ai:getCurrentRun', '当前运行中的 AI 任务', { args: [] }),
  ipc('ai:listRuns', '全部 AI 运行记录（本次启动内）', { args: [] }),
  ipc('ai:getRunPrompt', '查看某次运行发送的提示词', { params: { runId: S('运行 id') }, required: ['runId'], args: ['runId'] }),
  ipc('ai:cancel', '终止 AI 运行', { params: { runId: S('运行 id') }, required: ['runId'], args: ['runId'] }),
  ipc('ai:pause', '暂停 AI 运行（分批评审可暂停）', { params: { runId: S('运行 id') }, required: ['runId'], args: ['runId'] }),
  ipc('ai:resume', '继续已暂停的运行', { params: { runId: S('运行 id'), waitSec }, required: ['runId'], args: ['runId'], long: true, scopes: ['findings', 'history'] }),
  ipc('ai:explainFollowUp', '对逐句解析结果追问', {
    params: { folder, filePath: S('文件相对路径'), hunk, line: O('行'), segments: A('选区', O('选区')), previousQA: A('之前的问答', O('问答')), question: S('问题'), runId, waitSec },
    required: ['folder', 'question'], open: true, long: true, autoIds: ['runId'] }),
  ipc('ai:reviewFollowUp', '对评审结果追问（需传 files）', {
    params: { folder, files: A('git_getChanges 返回的 files', O('文件')), previousQA: A('之前的问答', O('问答')), question: S('问题'), runId, waitSec },
    required: ['folder', 'files', 'question'], open: true, long: true, autoIds: ['runId'] }),
  ipc('plan:list', '需求方案列表', { params: { folder }, required: ['folder'], args: ['folder'] }),
  ipc('plan:create', '新建需求方案（导入 PRD 文本）', { params: { folder, title: S('标题'), prdFileName: S('PRD 文件名'), prdText: S('PRD 正文') }, required: ['folder'], scopes: ['plan'] }),
  ipc('plan:addImage', '为方案添加设计稿；传 filePath 或 base64', {
    params: { folder, planId, filePath: S('图片绝对路径'), name: S('文件名'), base64: S('图片 base64') }, required: ['folder', 'planId'], scopes: ['plan'], prepare: readImageFile }),
  ipc('plan:removeImage', '移除方案设计稿', { params: { folder, planId, name: S('图片文件名') }, required: ['folder', 'planId', 'name'], scopes: ['plan'] }),
  ipc('plan:detail', '方案详情', { params: { folder, planId }, required: ['folder', 'planId'], args: ['folder', 'planId'] }),
  ipc('plan:generate', '根据 PRD 与设计稿生成技术方案', {
    params: { folder, planId, extraRequirement: S('额外要求'), runId, waitSec }, required: ['folder', 'planId'], long: true, autoIds: ['runId'], scopes: ['plan'] }),
  ipc('plan:delete', '删除方案', { params: { folder, planId }, required: ['folder', 'planId'], args: ['folder', 'planId'], scopes: ['plan'] }),
  ipc('plan:setActive', '设置评审时参照的方案；planId 传 null 取消启用', {
    params: { folder, planId: { type: ['string', 'null'], description: '方案 id；null 表示取消启用' } }, required: ['folder', 'planId'], args: ['folder', 'planId'], scopes: ['plan'] }),
  ipc('plan:getActive', '当前启用的方案', { params: { folder }, required: ['folder'], args: ['folder'] }),
  ipc('plan:fetchPrdUrl', '抓取网页 PRD 文本', { params: { url: S('网址') }, required: ['url'], args: ['url'] }),
  ipc('plan:fetchDesignUrl', '抓取设计稿图片或网页截图', { params: { url: S('网址') }, required: ['url'], args: ['url'] }),
  ipc('update:check', '检查新版本', { args: [] }),
  ipc('update:download', '下载新版本 DMG 并打开', { params: { dmgUrl: S('update_check 返回的下载地址'), waitSec }, required: ['dmgUrl'], args: ['dmgUrl'], long: true }),
];

/** @param {ToolDef} tool */
function inputSchema(tool) {
  return { type: 'object', properties: tool.params || {}, ...(tool.required ? { required: tool.required } : {}),
    additionalProperties: Boolean(tool.open) };
}

function listTools() {
  return TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: inputSchema(tool) }));
}

const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]));

module.exports = { TOOLS, TOOL_MAP, listTools };

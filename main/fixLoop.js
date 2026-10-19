const { randomUUID } = require('crypto');
const safety = require('./patchSafety');
const store = require('./store');
const findings = require('./findings');
const { captureProjectRules, withCapturedRules } = require('./ai/planContext');
/** @typedef {import('./findings').Finding} Finding */
/** @typedef {{previous:Pick<Finding,'status'|'verification'|'lastVerifiedAt'>,verified:Finding}} VerificationUndo */
/** @typedef {{folder:string,findingId:string,diff:string,files:import('./patchSafety').PatchFile[],contentHashes:Record<string,string|null>,postHashes:Record<string,string|null>|null,strip:number,createdAt:number,applied:boolean,busy:boolean,verificationUndo?:VerificationUndo}} Patch */
/** @type {Map<string,Patch>} */
const patches = new Map();
const writingFolders = new Set();
const TTL = 30 * 60 * 1000;
function prune() {
  for (const [id, patch] of patches) if (!patch.busy && Date.now() - patch.createdAt >= TTL) patches.delete(id);
}
function getPatch(folder, patchId) {
  safety.validateFolder(folder); prune();
  const patch = patches.get(patchId);
  if (!patch || patch.folder !== folder) throw new Error('补丁不存在或已过期，请重新生成');
  if (patch.busy) throw new Error('补丁正在处理中，请稍后重试');
  return patch;
}
function getFinding(folder, findingId) {
  safety.validateFolder(folder);
  const finding = store.listChecklist(folder).find((f) => f.id === findingId);
  if (!finding) throw new Error('问题不存在，请刷新清单');
  return finding;
}
async function safeChat(messages, options) {
  const cfg = await require('./settings').getSettings();
  // 现有 OpenCode/Kimi 无强制只读沙箱，不能用提示词冒充权限隔离。
  if (!['api', 'codex'].includes(cfg.backend)) throw new Error('修复生成和复核仅支持 API 或只读 Codex；请切换后端或使用交接提示词');
  return require('./ai').chatWithStats(cfg, messages, options);
}
function currentContext(content, finding) {
  const text = content.toString('utf8'), lines = text.split('\n');
  if (content.length <= 60 * 1024) return text;
  const target = finding.location?.anchor?.target.join('\n');
  const offset = target ? text.indexOf(target) : -1;
  const line = offset >= 0 && text.indexOf(target, offset + 1) < 0 ? text.slice(0, offset).split('\n').length : finding.location?.startLine || 1;
  const start = Math.max(0, line - 1 - 200);
  const span = Math.max(0, (finding.location?.endLine || line) - (finding.location?.startLine || line));
  return lines.slice(start, Math.min(lines.length, line + span + 200)).map((value, i) => `${start + i + 1}: ${value}`).join('\n');
}
async function generatePatch({ folder, findingId, runId, extraInstruction = '' }) {
  const finding = getFinding(folder, findingId), findingPath = finding.location?.path;
  if (!findingPath) throw new Error('问题缺少文件位置，无法生成补丁');
  await safety.validateTargets(folder, [{ path: findingPath }], findingPath);
  const content = safety.readTarget(folder, findingPath);
  if (!content) throw new Error('目标文件不存在');
  if (typeof extraInstruction !== 'string' || extraInstruction.length > 8000) throw new Error('额外要求必须为最多 8000 字的文本');
  const contentHashes = { [findingPath]: findings.hash(content) };
  const rules = captureProjectRules(folder, [findingPath]);
  const result = await safeChat([
    { role: 'system', content: withCapturedRules('只生成一个最小修复的 unified diff，放在一个 ```diff 围栏中，使用 a/ b/ 前缀，除此之外不要输出任何内容。仅修改指定问题文件；不要执行工具、修改文件、暂存或提交。保留公共 API，禁止无关重构。', rules) },
    { role: 'user', content: `问题：${JSON.stringify(finding)}\n当前文件 ${findingPath}：\n${currentContext(content, finding)}\n额外要求：${extraInstruction}` },
  ], { folder, runId, kind: '生成修复补丁', batch: findingPath, maxTokens: 8192, stream: true });
  const diff = safety.extractDiff(result.content);
  /** @type {import('./patchSafety').PatchFile[]} */
  let files = [];
  let strip = 1;
  let check = { ok: true, error: /** @type {string|null} */ (null) };
  try {
    ({ files, strip } = safety.inspectDiff(diff));
    await safety.validateTargets(folder, files, findingPath);
    // 无前缀补丁只有路径解析明确为 p0 时才允许回退，不掩盖内容冲突。
    try { await safety.applyGit(folder, diff, 1, false, true); }
    catch (error) { if (strip !== 0) throw error; await safety.applyGit(folder, diff, 0, false, true); }
  } catch (error) { check = { ok: false, error: String(error.stderr || error.message).trim() }; }
  prune();
  while (patches.size >= 20) {
    const oldest = [...patches].find(([, p]) => !p.busy);
    if (!oldest) throw new Error('补丁正在处理中，请稍后重试');
    patches.delete(oldest[0]);
  }
  const patchId = randomUUID();
  patches.set(patchId, { folder, findingId, diff, files, contentHashes, postHashes: null, strip, createdAt: Date.now(), applied: false, busy: false });
  return { patchId, diff, files, check, stats: result.stats };
}
async function mutatePatch({ folder, patchId, confirmed }, reverse) {
  if (confirmed !== true) throw new Error(`${reverse ? '撤销' : '应用'}补丁需要明确确认 confirmed: true`);
  const patch = getPatch(folder, patchId);
  if (writingFolders.has(folder)) throw new Error('项目补丁正在处理中，请稍后重试');
  if (patch.applied !== reverse) throw new Error(reverse ? '补丁尚未应用或已撤销' : '补丁已经应用');
  patch.busy = true;
  writingFolders.add(folder);
  try {
    const finding = getFinding(folder, patch.findingId);
    await safety.validateTargets(folder, patch.files, finding.location?.path);
    // 检查原始文本，失败的预览不能靠再次点击绕过验证。
    const inspected = safety.inspectDiff(patch.diff);
    if (JSON.stringify(inspected.files) !== JSON.stringify(patch.files)) throw new Error('补丁文件列表无效');
    const expected = reverse ? patch.postHashes : patch.contentHashes;
    const assertUnchanged = () => {
      if (JSON.stringify(safety.targetHashes(folder, patch.files)) !== JSON.stringify(expected)) throw new Error(reverse ? '文件已变化，无法安全撤销补丁' : '文件已变化，请重新生成补丁');
    };
    assertUnchanged();
    await safety.applyGit(folder, patch.diff, patch.strip, reverse, true);
    assertUnchanged();
    await safety.applyGit(folder, patch.diff, patch.strip, reverse);
    patch.applied = !reverse;
    patch.postHashes = reverse ? null : safety.targetHashes(folder, patch.files);
    if (!reverse) {
      delete patch.verificationUndo;
      return { applied: true, files: patch.files };
    }
    const restored = restoreVerification(folder, patch);
    delete patch.verificationUndo;
    return { reverted: true, ...(restored ? { finding: restored } : {}) };
  } finally { patch.busy = false; writingFolders.delete(folder); }
}

/** @param {string} folder @param {Patch} patch @returns {Finding|undefined} */
function restoreVerification(folder, patch) {
  const undo = patch.verificationUndo;
  if (!undo) return undefined;
  const checklist = store.listChecklist(folder);
  const current = checklist.find((f) => f.id === patch.findingId);
  if (!current || JSON.stringify(current) !== JSON.stringify(undo.verified)) return undefined;
  const verification = undo.previous.verification || undo.verified.verification;
  Object.assign(current, undo.previous, {
    verification: verification ? { ...verification, note: '补丁已撤销，需重新复核', applied: undo.previous.verification?.applied === true } : null,
    updatedAt: Math.max(Date.now(), current.updatedAt + 1),
  });
  return store.saveChecklist(folder, checklist).find((f) => f.id === patch.findingId);
}
async function currentFindingDiff(folder, filePath) {
  const literal = `:(literal)${safety.safePath(filePath)}`;
  const diff = await safety.runGit(folder, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--', literal]);
  const untracked = await safety.runGit(folder, ['ls-files', '--others', '--exclude-standard', '-z', '--', literal]);
  const content = untracked ? safety.readTarget(folder, filePath) : null;
  return diff + (content ? `\n未跟踪文件 ${filePath}：\n${content.toString('utf8')}` : '');
}
async function verifyFinding({ folder, findingId, runId }) {
  const finding = getFinding(folder, findingId);
  if (!finding.location) throw new Error('问题缺少文件位置，无法复核');
  const captured = [{ id: finding.id, updatedAt: finding.updatedAt }];
  const appliedPatches = [...patches.values()].filter((p) => p.folder === folder && p.findingId === findingId && p.applied)
    .map((patch) => ({ patch, postHashes: patch.postHashes }));
  const diff = await currentFindingDiff(folder, finding.location.path);
  const content = safety.readTarget(folder, finding.location.path);
  const rules = captureProjectRules(folder, [finding.location.path]);
  const result = await safeChat([
    { role: 'system', content: withCapturedRules('只复核这一个问题，严格输出一行 [id=原始ID] => 已修复/仍存在/部分修复/已过时 | 说明（四选一）。没有 diff 不代表已修复；证据不足应判仍存在。不要调用工具或修改文件。', rules) },
    { role: 'user', content: `问题（含位置与锚点）：${JSON.stringify(finding)}\n当前工作区 diff（相对 HEAD）：\n${diff || '没有 diff；这不构成已修复证据。'}\n当前工作区文件内容（锚点/行号窗口）：\n${content ? currentContext(content, finding) : '文件当前不存在'}` },
  ], { folder, runId, kind: '复核问题', batch: finding.location.path, maxTokens: 1024, stream: true });
  const entries = findings.parseVerificationLines(result.content, [finding]);
  if (entries.length !== 1) return { verdict: null, note: '', finding: getFinding(folder, findingId) };
  const stored = store.listChecklist(folder);
  const current = stored.find((f) => f.id === findingId);
  const reconciled = findings.reconcile({ stored, markdown: `[id=${findingId}] => ${entries[0].verdict} | ${entries[0].note}`, captured, reviewId: runId || randomUUID() });
  const checklist = store.saveChecklist(folder, reconciled.checklist);
  const verified = checklist.find((f) => f.id === findingId) || null;
  if (verified?.verification) {
    for (const { patch, postHashes } of appliedPatches) {
      if (!patch.applied || patch.postHashes !== postHashes) continue;
      const undo = patch.verificationUndo;
      const unchanged = undo && current && JSON.stringify(undo.verified) === JSON.stringify(current);
      if (!verified.verification.applied) {
        if (unchanged && JSON.stringify({ ...verified, verification: current.verification }) === JSON.stringify(current)) {
          undo.verified = structuredClone(verified);
        }
        continue;
      }
      const previous = unchanged ? undo.previous : { status: finding.status, verification: finding.verification, lastVerifiedAt: finding.lastVerifiedAt };
      patch.verificationUndo = structuredClone({ previous, verified });
    }
  }
  return { verdict: entries[0].verdict, note: entries[0].note, finding: verified };
}
function handoffPrompt({ folder, findingIds }) {
  safety.validateFolder(folder);
  if (!Array.isArray(findingIds) || !findingIds.length || findingIds.length > 200 || findingIds.some((id) => typeof id !== 'string')) throw new Error('请选择有效的问题 ID');
  const selected = [...new Set(findingIds)].map((id) => getFinding(folder, id));
  const rules = captureProjectRules(folder, selected.flatMap((f) => f.location ? [f.location.path] : []));
  const markdown = `# ReviewFlow 修复任务\n\n项目：${folder}\n\n## 问题\n${selected.map((f) => `\n### [id=${f.id}] [${f.severity || '未标注'}][${f.category}]\n${f.text}\n位置：${f.location ? `${f.location.path}:${f.location.startLine ?? '?'}-${f.location.endLine ?? '?'}` : '未知'}\n锚点摘录：${JSON.stringify(f.location?.anchor || null)}\n复核记录：${f.verification ? `${f.verification.verdict} | ${f.verification.note}` : '尚未复核'}\n`).join('')}\n## 有效项目规范\n${rules.text || '无额外项目规范'}\n\n## 约束\n最小改动；禁止无关重构；保留公共 API；运行项目的相关测试；不要暂存或提交（do not commit）。\n\n## 预期验证\n说明根因、修复和实际测试结果。每个问题输出一行 [id=原始ID] => 已修复/仍存在/部分修复/已过时 | 证据及说明。不得把未运行的测试写为通过。\n\n命令仅供用户自行运行。请先将此提示词保存为 reviewflow-fix-prompt.md。`;
  const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  return { markdown, commands: [
    { label: 'OpenCode（自行运行）', command: `opencode run --dir ${quote(folder)} "$(cat reviewflow-fix-prompt.md)"` },
    { label: 'Codex（自行运行）', command: `codex exec --cd ${quote(folder)} - < reviewflow-fix-prompt.md` },
  ] };
}
module.exports = { generatePatch, applyPatch: (payload) => mutatePatch(payload, false), revertPatch: (payload) => mutatePatch(payload, true), verifyFinding, handoffPrompt };

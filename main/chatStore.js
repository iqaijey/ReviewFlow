const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { hash } = require('./reviewSnapshot');
const { readJsonFile, writeFileAtomic } = require('./atomicFile');

/** @typedef {Record<string, unknown>} Stats */
/** @typedef {'review'|'review-section'|'full'|'line'} ChatKind */
/** @typedef {'pending'|'complete'|'failed'|'cancelled'|'interrupted'} MessageStatus */
/** @typedef {{header:string,oldStart?:number,newStart?:number,oldLines?:number,newLines?:number,lines:Array<{type:string,content:string,oldLine?:number|null,newLine?:number|null}>}} DiffHunk */
/** @typedef {{path:string,hunk:DiffHunk,selectedLineIndexes:number[]}} Selection */
/** @typedef {{diffFingerprint:string|null,source:import('./reviewSnapshot').ReviewSource|null,codeContext:string,planContext:string,projectRulesText:string,initialMarkdown:string,selection:Selection[],truncated:boolean}} ChatContext */
/** @typedef {{id:string,requestId:string,role:'user'|'assistant',content:string,createdAt:number,status:MessageStatus,stats:Stats|null,error:string|null}} ChatMessage */
/** @typedef {{schemaVersion:2,id:string,kind:ChatKind,reviewId:string|null,sectionTitle:string|null,title:string,createdAt:number,updatedAt:number,context:ChatContext,messages:ChatMessage[]}} ChatThread */
const KINDS = ['review', 'review-section', 'full', 'line'];
const CONTEXT_BYTES = 128 * 1024;

function assertFolder(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || folder.includes('\0')) throw new Error('缺少有效的项目绝对路径');
}
function assertId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error('会话 id 无效');
}
function userDataRoot() { return require('electron').app.getPath('userData'); }
/** @param {Partial<ChatContext>} [input] @returns {ChatContext} */
function capContext(input = {}) {
  const context = { diffFingerprint: input.diffFingerprint || null, source: input.source || null,
    codeContext: input.codeContext || '', planContext: input.planContext || '', projectRulesText: input.projectRulesText || '',
    initialMarkdown: input.initialMarkdown || '', selection: structuredClone(input.selection || []), truncated: input.truncated === true };
  const size = () => Buffer.byteLength(JSON.stringify(context), 'utf8');
  if (size() <= CONTEXT_BYTES) return context;
  context.truncated = true;
  for (const field of /** @type {const} */ (['codeContext', 'initialMarkdown', 'planContext', 'projectRulesText'])) {
    if (size() <= CONTEXT_BYTES) break;
    const chars = Array.from(context[field]);
    let low = 0, high = chars.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      context[field] = chars.slice(0, mid).join('');
      if (size() <= CONTEXT_BYTES) low = mid; else high = mid - 1;
    }
    context[field] = chars.slice(0, low).join('');
  }
  // 选择只保留完整段；绝不截断行内容或改变索引，避免恢复后指向别的行。
  while (size() > CONTEXT_BYTES && context.selection.length) context.selection.pop();
  if (size() > CONTEXT_BYTES) context.source = null;
  return context;
}

/** @param {{root?:()=>string}} [options] */
function createChatStore({ root = userDataRoot } = {}) {
  const active = new Set();
  function directory(folder) { assertFolder(folder); return path.join(root(), 'review-chats', hash(folder)); }
  function filename(folder, id) { assertId(id); return path.join(directory(folder), `${id}.json`); }
  /** @param {string} folder @param {ChatThread} thread */
  function write(folder, thread) { writeFileAtomic(filename(folder, thread.id), JSON.stringify({ ...thread, folder }), 'utf8'); }
  /** @param {{folder:string,id:string}} payload @returns {ChatThread|null} */
  function get({ folder, id }) {
    const raw = readJsonFile(filename(folder, id), null);
    if (!raw) return null;
    if (raw.folder !== folder || raw.id !== id || raw.schemaVersion !== 2 || !KINDS.includes(raw.kind)
      || !raw.context || !Array.isArray(raw.context.selection) || !Array.isArray(raw.messages)
      || raw.context.selection.some((seg) => !seg || typeof seg.path !== 'string' || !seg.hunk || !Array.isArray(seg.hunk.lines)
        || !Array.isArray(seg.selectedLineIndexes) || seg.selectedLineIndexes.some((i) => !Number.isSafeInteger(i) || i < 0 || i >= seg.hunk.lines.length))
      || ['codeContext', 'planContext', 'projectRulesText', 'initialMarkdown'].some((key) => typeof raw.context[key] !== 'string')
      || raw.messages.some((m) => !m || typeof m.requestId !== 'string' || typeof m.content !== 'string'
        || !['user', 'assistant'].includes(m.role) || !['pending', 'complete', 'failed', 'cancelled', 'interrupted'].includes(m.status))) {
      throw new Error('会话存储结构或项目路径无效，请保留文件并修复');
    }
    const { folder: _folder, ...thread } = raw;
    let changed = false;
    if (!active.has(filename(folder, id))) for (const message of thread.messages) {
      if (message.role === 'assistant' && message.status === 'pending') {
        message.status = 'interrupted'; message.error = '应用已重启，追问被中断，未自动重试'; changed = true;
      }
    }
    if (changed) write(folder, thread);
    return thread;
  }
  function threads(folder) {
    let names;
    try { names = fs.readdirSync(directory(folder)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return names.filter((name) => /^[a-zA-Z0-9-]+\.json$/.test(name))
      .map((name) => get({ folder, id: name.slice(0, -5) })).filter((t) => t !== null)
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  }
  /** @param {{folder:string,reviewId?:string,kind?:ChatKind}} payload */
  function list({ folder, reviewId, kind }) {
    if (kind !== undefined && !KINDS.includes(kind)) throw new Error('会话类型无效');
    if (reviewId !== undefined && (typeof reviewId !== 'string' || !reviewId)) throw new Error('评审 id 无效');
    return threads(folder).filter((t) => (!reviewId || t.reviewId === reviewId) && (!kind || t.kind === kind))
      .map(({ context, messages, ...summary }) => summary);
  }
  function prune(folder) {
    const warnings = [];
    for (const thread of threads(folder).filter((t) => t.kind === 'line' && !t.reviewId).slice(100)) {
      if (active.has(filename(folder, thread.id))) continue;
      try { fs.unlinkSync(filename(folder, thread.id)); }
      catch (error) { warnings.push(`会话清理失败：${error instanceof Error ? error.message : String(error)}`); }
    }
    return warnings;
  }
  /** @param {{folder:string,kind:ChatKind,reviewId?:string|null,sectionTitle?:string|null,title?:string,context:Partial<ChatContext>}} payload */
  function create({ folder, kind, reviewId = null, sectionTitle = null, title = '代码追问', context }) {
    assertFolder(folder);
    if (!KINDS.includes(kind)) throw new Error('会话类型无效');
    if (reviewId) {
      const existing = threads(folder).find((t) => t.reviewId === reviewId && t.sectionTitle === sectionTitle);
      if (existing) return existing;
    }
    const now = Math.max(Date.now(), (threads(folder)[0]?.createdAt || 0) + 1);
    /** @type {ChatThread} */
    const thread = { schemaVersion: 2, id: randomUUID(), kind, reviewId, sectionTitle, title,
      createdAt: now, updatedAt: now, context: capContext(context), messages: [] };
    write(folder, thread);
    const persistenceWarnings = prune(folder);
    return { ...thread, ...(persistenceWarnings.length ? { persistenceWarnings } : {}) };
  }
  function beginExchange(folder, id, { question, requestId }) {
    const thread = get({ folder, id });
    if (!thread) throw new Error('会话不存在或已删除');
    if (thread.messages.some((m) => m.requestId === requestId)) return thread;
    if (thread.messages.some((m) => m.status === 'pending')) throw new Error('该会话正在追问，请等待完成');
    if (thread.messages.filter((m) => m.role === 'user').length >= 100) throw new Error('会话已达到 100 轮追问上限，仅可阅读');
    if (typeof question !== 'string' || !question.trim() || Buffer.byteLength(question) > 32768) throw new Error('追问文本无效或超过 32 KiB');
    const now = Date.now();
    thread.messages.push({ id: randomUUID(), requestId, role: 'user', content: question, createdAt: now, status: 'complete', stats: null, error: null },
      { id: randomUUID(), requestId, role: 'assistant', content: '', createdAt: now, status: 'pending', stats: null, error: null });
    thread.updatedAt = now;
    write(folder, thread);
    active.add(filename(folder, id));
    return thread;
  }
  /** @param {string} folder @param {string} id @param {{requestId:string,status:MessageStatus,content:string,stats:Stats|null,error?:string|null}} result */
  function finishExchange(folder, id, result) {
    try {
      const thread = get({ folder, id });
      if (!thread) throw new Error('会话已删除，回答未重新创建孤立会话');
      const index = thread.messages.findIndex((m) => m.role === 'assistant' && m.requestId === result.requestId);
      if (index < 0) throw new Error('追问占位消息不存在');
      thread.messages[index] = { ...thread.messages[index], content: result.content, status: result.status, stats: result.stats, error: result.error || null };
      thread.updatedAt = Date.now();
      write(folder, thread);
      active.delete(filename(folder, id));
      const persistenceWarnings = prune(folder);
      return { ...thread, ...(persistenceWarnings.length ? { persistenceWarnings } : {}) };
    } finally { active.delete(filename(folder, id)); }
  }
  function deleteLinked(folder, reviewId) {
    const warnings = [];
    try {
      for (const thread of threads(folder).filter((t) => t.reviewId === reviewId)) {
        try { fs.unlinkSync(filename(folder, thread.id)); }
        catch (error) { warnings.push(`关联会话清理失败：${error instanceof Error ? error.message : String(error)}`); }
      }
    } catch (error) { warnings.push(`关联会话清理失败：${error instanceof Error ? error.message : String(error)}`); }
    return warnings;
  }
  return { get, list, create, beginExchange, finishExchange, deleteLinked };
}

module.exports = { ...createChatStore(), createChatStore, capContext, assertFolder };

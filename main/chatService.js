const defaultStore = require('./chatStore');

/** @typedef {{role:string,content:string}} PromptMessage */
/** @typedef {{folder:string,threadId:string,question:string,requestId:string,runId:string}} SendPayload */
/** @typedef {(messages:PromptMessage[],options:{folder:string,runId:string})=>Promise<{content:string,stats:import('./chatStore').Stats|null}>} ChatCall */

/** @param {import('./chatStore').ChatThread} thread @param {string} question */
function buildMessages(thread, question) {
  const { context } = thread;
  const messages = [
    { role: 'system', content: '你是资深代码评审与讲解专家，请用简洁中文回答追问，仅依据捕获的历史上下文。' +
      (thread.sectionTitle ? `\n聚焦小节：${thread.sectionTitle}` : '') +
      (context.projectRulesText ? `\n\n## 项目评审规范\n${context.projectRulesText}` : '') },
    { role: 'user', content: `${context.planContext}\n\n${context.codeContext}${context.truncated ? '\n（捕获上下文已截断）' : ''}` },
    { role: 'assistant', content: context.initialMarkdown },
  ];
  const exchanges = thread.messages.filter((m) => m.role === 'assistant' && m.status === 'complete')
    .map((answer) => ({ answer, user: thread.messages.find((m) => m.role === 'user' && m.requestId === answer.requestId) }))
    .filter((pair) => pair.user).slice(-10);
  for (const { answer, user } of exchanges) {
    if (user) messages.push({ role: 'user', content: user.content }, { role: 'assistant', content: answer.content });
  }
  messages.push({ role: 'user', content: question });
  return messages;
}

/** @param {{store?:ReturnType<typeof defaultStore.createChatStore>,callAI?:ChatCall}} [options] */
function createChatService({ store = defaultStore, callAI = (messages, options) => require('./ai').chatWithStats(null, messages,
  { ...options, kind: '追问', batch: '会话追问', maxTokens: 2048, stream: true }) } = {}) {
  /** @param {import('./chatStore').ChatThread} thread @param {string} requestId */
  function result(thread, requestId) {
    const answer = thread.messages.find((m) => m.role === 'assistant' && m.requestId === requestId);
    return { thread, markdown: answer?.content || '', stats: answer?.stats || null };
  }
  /** @param {SendPayload} payload */
  async function send({ folder, threadId, question, requestId, runId }) {
    if (typeof question !== 'string' || !question.trim() || Buffer.byteLength(question) > 32768) throw new Error('追问须为非空文本，且不超过 32 KiB');
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) throw new Error('缺少有效的 requestId（最多 200 字符）');
    if (typeof runId !== 'string' || !runId.trim() || runId.length > 200) throw new Error('缺少有效的 runId（最多 200 字符）');
    const thread = store.get({ folder, id: threadId });
    if (!thread) throw new Error('会话不存在或已删除');
    if (thread.messages.some((m) => m.requestId === requestId)) return result(thread, requestId);
    const pending = store.beginExchange(folder, threadId, { question: question.trim(), requestId });
    let response;
    try {
      const answer = await callAI(buildMessages(thread, question.trim()), { folder, runId });
      response = { requestId, content: answer.content, stats: answer.stats, status: /** @type {const} */ ('complete'), error: null };
    } catch (error) {
      const cancelled = error && typeof error === 'object' && 'cancelled' in error && error.cancelled === true;
      response = { requestId, content: '', stats: null, status: /** @type {'cancelled'|'failed'} */ (cancelled ? 'cancelled' : 'failed'),
        error: error instanceof Error ? error.message : String(error) };
    }
    // 完成后始终写回原项目；切换项目只影响 renderer 是否展示。
    const completed = store.finishExchange(folder, pending.id, response);
    return result(completed, requestId);
  }
  /** @param {{folder:string,reviewId:string,sectionTitle?:string}} payload */
  function create({ folder, reviewId, sectionTitle = undefined }) {
    if (typeof reviewId !== 'string' || !reviewId) throw new Error('缺少评审 id');
    if (sectionTitle !== undefined && (typeof sectionTitle !== 'string' || !sectionTitle.trim() || sectionTitle.length > 200)) throw new Error('小节标题须为 1–200 个字符');
    const entry = require('./store').getReview({ folder, id: reviewId });
    if (!entry) throw new Error('评审记录不存在或已删除');
    return store.create({ folder, reviewId, sectionTitle: sectionTitle?.trim() || null,
      kind: sectionTitle ? 'review-section' : entry.kind === 'full' ? 'full' : 'review', title: sectionTitle || entry.title,
      context: { ...(entry.chatContext || {}), initialMarkdown: entry.markdown } });
  }
  return { send, create };
}
module.exports = { ...createChatService(), createChatService, buildMessages };

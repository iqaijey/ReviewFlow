import { formatStoredStats, copyMarkdown } from './aiShared.js';
// 持久化追问会话组件：复用于整体评审、维度小节、历史记录、完整讲解与逐句解析
import { renderMarkdown } from '../markdown.js';
import { createStreamPreview } from './streamPreview.js';
import { createRunStatus } from './runStatus.js';



/** @type {Record<Exclude<ChatMessageStatus, 'complete'>, string>} */
const STATUS_LABELS = {
  pending: '生成中',
  failed: '失败',
  cancelled: '已终止',
  interrupted: '已中断',
};

/** @type {Record<Exclude<ChatMessageStatus, 'complete'>, string>} */
const STATUS_DEFAULT_ERRORS = {
  pending: 'AI 思考中，请稍候…',
  failed: '追问失败',
  cancelled: '已被用户终止',
  interrupted: '应用已重启，追问被中断，未自动重试',
};

const MAX_EXCHANGES = 100;

/** @typedef {{ runId: string, requestId: string, question: string }} PendingChatOperation */

let instanceSeq = 0;

function makeRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @param {{
 *   container?: HTMLElement | null,
 *   el: (tag: string, attrs?: Record<string, any>, children?: any) => HTMLElement,
 *   api: AutoReviewApi,
 *   bus?: EventTarget | null,
 *   getFolder: () => string | null,
 *   originFolder?: string | null,
 *   thread?: ChatThread | null,
 *   threadId?: string | null,
 *   ensureThread?: (() => Promise<ChatThread>) | null,
 *   placeholder?: string,
 *   label?: string,
 *   className?: string,
 *   toast?: (msg: string, type?: string) => void,
 *   errText?: (err: any) => string,
 *   onThreadUpdated?: (thread: ChatThread) => void,
 *   onSendingChanged?: (sending: boolean, operation: PendingChatOperation | null) => void,
 * }} opts
 */
export function createChatView({
  container = null,
  el,
  api,
  bus = null,
  getFolder,
  originFolder = getFolder(),
  thread = null,
  threadId = null,
  ensureThread = null,
  placeholder = '继续追问（⌘Enter 发送）…',
  label = '追问内容',
  className = '',
  toast = () => {},
  errText = (e) => String((e && e.message) || e),
  onThreadUpdated = undefined,
  onSendingChanged = undefined,
}) {
  const uid = ++instanceSeq;
  const textareaId = `chat-composer-input-${uid}`;

  /** @type {ChatThread | null} */
  let currentThread = thread || null;
  /** @type {string | null} */
  let currentThreadId = (thread && thread.id) || threadId || null;
  let sending = false;
  let disposed = false;
  /** @type {string | null} */
  let activeRunId = null;
  /** @type {string} */
  let pendingQuestion = '';
  /** @type {string} */
  let transientError = '';
  /** @type {{ parent: HTMLElement, streamBox: HTMLElement, unsubscribe: (() => void) | null } | null} */
  let activeStream = null;
  /** @type {{ root: HTMLElement, dispose: () => void } | null} */
  let activeRunStatus = null;

  const root = el('div', {
    class: `chat-view explain-follow${className ? ` ${className}` : ''}`,
  });

  const noticesBox = el('div', { class: 'chat-notices' });
  const messagesBox = el('div', { class: 'chat-messages explain-follow-list' });
  const liveRegion = el('div', {
    class: 'chat-live-region',
    'aria-live': 'polite',
    'aria-atomic': 'true',
  });

  const composer = el('div', { class: 'chat-composer explain-follow-form' });
  const composerField = el('div', { class: 'chat-composer-field' });
  const composerLabel = el('label', {
    class: 'chat-composer-label',
    for: textareaId,
  }, label);
  const textarea = /** @type {HTMLTextAreaElement} */ (el('textarea', {
    id: textareaId,
    class: 'settings-input chat-composer-textarea',
     rows: '2',
    placeholder,
    'aria-label': label,
    spellcheck: 'false',
  }));
  composerField.appendChild(composerLabel);
  composerField.appendChild(textarea);

  const composerActions = el('div', { class: 'chat-composer-actions' });
  const sendBtn = /** @type {HTMLButtonElement} */ (el('button', {
    class: 'btn chat-send-btn',
    type: 'button',
  }, '发送'));
  const stopBtn = /** @type {HTMLButtonElement} */ (el('button', {
    class: 'btn btn-danger chat-stop-btn',
    type: 'button',
    style: 'display:none',
  }, '停止'));
  composerActions.appendChild(sendBtn);
  composerActions.appendChild(stopBtn);

  composer.appendChild(composerField);
  composer.appendChild(composerActions);

  root.appendChild(noticesBox);
  root.appendChild(messagesBox);
  root.appendChild(liveRegion);
  root.appendChild(composer);

  if (container) {
    container.appendChild(root);
  }

  function announce(text) {
    liveRegion.textContent = text || '';
  }

  function countUserTurns() {
    if (!currentThread || !Array.isArray(currentThread.messages)) return 0;
    return currentThread.messages.filter((m) => m && m.role === 'user').length;
  }

  function isReadOnly() {
    return disposed || getFolder() !== originFolder || countUserTurns() >= MAX_EXCHANGES;
  }

  function emitPersistenceWarnings(warnings) {
    if (!Array.isArray(warnings)) return;
    for (const w of warnings) {
      if (w) toast(String(w), 'error');
    }
  }

  function cleanupStream() {
    if (activeRunStatus) {
      activeRunStatus.dispose();
      activeRunStatus.root.remove();
      activeRunStatus = null;
    }
    if (activeStream) {
      if (activeStream.unsubscribe) activeStream.unsubscribe();
      activeStream.streamBox.remove();
      activeStream.parent.remove();
      activeStream = null;
    }
  }

  function handleStop() {
    if (!activeRunId || typeof api.cancelRun !== 'function') return;
    stopBtn.disabled = true;
    api.cancelRun(activeRunId).catch((err) => {
      toast('终止追问失败：' + errText(err), 'error');
    });
  }

  stopBtn.addEventListener('click', handleStop);

  function renderNotices() {
    noticesBox.textContent = '';
    if (currentThread && currentThread.context && currentThread.context.truncated) {
      noticesBox.appendChild(el('div', {
        class: 'chat-notice chat-notice-truncated',
      }, '上下文已截断：捕获的上下文超过 128 KiB 上限，仅保留前部内容参与追问。'));
    }
    if (isReadOnly()) {
      noticesBox.appendChild(el('div', {
        class: 'chat-notice chat-notice-readonly',
      }, `该会话已达到 ${MAX_EXCHANGES} 轮追问上限，仅可阅读。`));
    }
    if (transientError) {
      noticesBox.appendChild(el('div', {
        class: 'chat-notice chat-notice-error error-text',
      }, transientError));
    }
  }

  /**
   * @param {ChatMessage} msg
   * @param {ChatMessage[]} allMessages
   */
  function renderMessageNode(msg, allMessages) {
    const isUser = msg.role === 'user';
    const item = el('div', {
      class: `chat-message chat-message-${msg.role} explain-follow-item`,
      dataset: {
        messageId: msg.id || '',
        requestId: msg.requestId || '',
        role: msg.role,
        status: msg.status || 'complete',
      },
    });

    const head = el('div', { class: 'chat-message-head' });
    head.appendChild(el('span', { class: 'chat-message-role' }, isUser ? '追问' : '回答'));

    if (msg.createdAt) {
      head.appendChild(el('span', { class: 'chat-message-time' },
        new Date(msg.createdAt).toLocaleTimeString()));
    }

    if (msg.status && msg.status !== 'complete') {
      const badgeLabel = STATUS_LABELS[msg.status] || msg.status;
      head.appendChild(el('span', {
        class: `chat-status-badge chat-status-${msg.status}`,
      }, badgeLabel));
    }

    const actions = el('div', { class: 'chat-message-actions' });
    if (isUser) {
      const pairedAssistant = allMessages.find(
        (m) => m && m.role === 'assistant' && m.requestId === msg.requestId,
      );
      const turnStatus = pairedAssistant && pairedAssistant.status !== 'complete'
        ? pairedAssistant.status
        : msg.status;
      const canRetry = turnStatus === 'failed' || turnStatus === 'cancelled' || turnStatus === 'interrupted';
      if (canRetry) {
        const retryBtn = /** @type {HTMLButtonElement} */ (el('button', {
          class: 'btn chat-action-btn chat-retry-btn',
          type: 'button',
          onClick: () => {
            sendQuestion(msg.content, { fromRetry: true });
          },
        }, '重试'));
        retryBtn.disabled = sending || isReadOnly();
        actions.appendChild(retryBtn);
      }
    } else {
      const latestAnswer = [...allMessages].reverse().find((m) => m.role === 'assistant' && m.status === 'complete');
      const question = allMessages.find((m) => m.role === 'user' && m.requestId === msg.requestId);
      if (msg === latestAnswer && question) {
        const regen = /** @type {HTMLButtonElement} */ (el('button', {
          class: 'btn chat-action-btn chat-regenerate-btn', type: 'button',
          onClick: () => sendQuestion(question.content, { fromRetry: true }),
        }, '重新生成'));
        regen.disabled = sending || isReadOnly();
        actions.appendChild(regen);
      }
      if (msg.content) {
        const copyBtn = /** @type {HTMLButtonElement} */ (el('button', {
          class: 'btn chat-action-btn chat-copy-btn',
          type: 'button',
          onClick: () => {
            copyMarkdown(msg.content, toast);
          },
        }, '复制'));
        actions.appendChild(copyBtn);
      }
    }

    if (actions.firstChild) {
      head.appendChild(actions);
    }
    item.appendChild(head);

    if (msg.content) {
      const mdNode = el('div', {
        class: `md chat-message-body${isUser ? ' explain-follow-q' : ''}`,
      });
      mdNode.innerHTML = renderMarkdown(msg.content);
      item.appendChild(mdNode);
    }

    if (msg.status && msg.status !== 'complete') {
      const errorText = msg.error || STATUS_DEFAULT_ERRORS[msg.status] || '';
      if (errorText) {
        item.appendChild(el('div', {
          class: `chat-message-error ${msg.status === 'pending' ? 'chat-pending-text' : 'error-text'}`,
        }, errorText));
      }
    } else if (msg.error) {
      item.appendChild(el('div', { class: 'chat-message-error error-text' }, msg.error));
    }

    if (!isUser && msg.stats) {
      const statsText = formatStoredStats(msg.stats);
      if (statsText) {
        item.appendChild(el('div', { class: 'ai-stats chat-message-stats' }, statsText));
      }
    }

    return item;
  }

  function renderMessages() {
    messagesBox.textContent = '';
    const messages = currentThread && Array.isArray(currentThread.messages)
      ? currentThread.messages
      : [];
    for (const msg of messages) {
      if (!msg) continue;
      messagesBox.appendChild(renderMessageNode(msg, messages));
    }

    if (sending && pendingQuestion) {
      const userPreview = el('div', {
        class: 'chat-message chat-message-user explain-follow-item is-optimistic',
      });
      const uHead = el('div', { class: 'chat-message-head' });
      uHead.appendChild(el('span', { class: 'chat-message-role' }, '追问'));
      userPreview.appendChild(uHead);
      const uBody = el('div', { class: 'md chat-message-body explain-follow-q' });
      uBody.innerHTML = renderMarkdown(pendingQuestion);
      userPreview.appendChild(uBody);
      messagesBox.appendChild(userPreview);

      const pendingItem = el('div', {
        class: 'chat-message chat-message-assistant explain-follow-item is-pending',
        dataset: { role: 'assistant', status: 'pending' },
      });
      const aHead = el('div', { class: 'chat-message-head' });
      aHead.appendChild(el('span', { class: 'chat-message-role' }, '回答'));
      aHead.appendChild(el('span', { class: 'chat-status-badge chat-status-pending' }, STATUS_LABELS.pending));
      pendingItem.appendChild(aHead);

      if (activeRunStatus && activeRunStatus.root) {
        pendingItem.appendChild(activeRunStatus.root);
      } else {
        const loadingRow = el('div', { class: 'explain-loading chat-loading-row' });
        loadingRow.appendChild(el('span', { class: 'spinner' }));
        loadingRow.appendChild(el('span', {}, 'AI 思考中，请稍候…'));
        pendingItem.appendChild(loadingRow);
      }

      if (activeStream && activeStream.parent) {
        pendingItem.appendChild(activeStream.parent);
      }
      messagesBox.appendChild(pendingItem);
    }
  }

  function syncComposerState() {
    const readOnly = isReadOnly();
    textarea.disabled = sending || readOnly;
    sendBtn.disabled = sending || readOnly;
    stopBtn.style.display = sending ? '' : 'none';
    stopBtn.disabled = !sending;
  }

  function render() {
    if (disposed) return;
    renderNotices();
    renderMessages();
    syncComposerState();
  }

  function focusComposer() {
    if (document.contains(textarea) && !textarea.disabled) {
      textarea.focus();
    }
  }

  /**
   * @param {string} rawQuestion
   * @param {{ fromRetry?: boolean }} [options]
   */
  async function sendQuestion(rawQuestion, { fromRetry = false } = {}) {
    const question = String(rawQuestion || '').trim();
    const folder = originFolder;
    if (!question || sending || !folder || isReadOnly()) return;

    transientError = '';
    sending = true;
    pendingQuestion = question;
    if (!fromRetry) {
      textarea.value = '';
    }
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const requestId = makeRequestId();
    activeRunId = runId;
    onSendingChanged?.(true, { runId, requestId, question });

    cleanupStream();
    activeRunStatus = createRunStatus({
      el,
      api,
      bus,
      runId,
      label: 'AI 思考中，请稍候…',
      skeleton: false,
      compact: true,
      onCancel: () => handleStop(),
      toast,
      errText,
    });
    const streamHolder = el('div', { class: 'chat-stream-holder' });
    const preview = createStreamPreview({ el, api, runId, parent: streamHolder });
    activeStream = { parent: streamHolder, ...preview };

    render();
    announce('正在生成追问回答…');

    try {
      if (!currentThread) {
        if (typeof ensureThread === 'function') {
          const created = await ensureThread();
           if (disposed || getFolder() !== folder) return;
          currentThread = created;
          currentThreadId = created ? created.id : null;
          if (created && created.persistenceWarnings) {
            emitPersistenceWarnings(created.persistenceWarnings);
          }
        } else if (currentThreadId && typeof api.getChatThread === 'function') {
          const loaded = await api.getChatThread({ folder, id: currentThreadId });
           if (disposed || getFolder() !== folder) return;
          currentThread = loaded;
        }
      }
      if (!currentThread || !currentThread.id) {
        throw new Error('会话尚未就绪，无法发送追问');
      }

      const res = await api.sendChatMessage({
        folder,
        threadId: currentThread.id,
        question,
        requestId,
        runId,
      });
      if (getFolder() !== folder) return;

      if (res && res.thread) {
        currentThread = res.thread;
        currentThreadId = res.thread.id;
        if (!disposed && res.thread.persistenceWarnings) {
          emitPersistenceWarnings(res.thread.persistenceWarnings);
        }
        if (typeof onThreadUpdated === 'function') {
          onThreadUpdated(currentThread);
        }
        const assistantMsg = currentThread.messages.find(
          (m) => m && m.role === 'assistant' && m.requestId === requestId,
        );
        if (assistantMsg) {
          if (assistantMsg.status === 'complete') {
            announce('追问回答已生成');
          } else if (assistantMsg.status === 'cancelled') {
            announce('追问已终止');
          } else if (assistantMsg.status === 'failed') {
            announce(`追问失败：${assistantMsg.error || ''}`);
          }
        }
      }
    } catch (err) {
      if (getFolder() !== folder) return;
      const msg = errText(err);
      transientError = `追问失败：${msg}`;
      if (!disposed) announce(transientError);
      if (!disposed && !fromRetry && !textarea.value) {
        textarea.value = question;
      }
      if (currentThreadId && typeof api.getChatThread === 'function') {
        try {
          const refreshed = await api.getChatThread({ folder, id: currentThreadId });
          if (getFolder() === folder && refreshed) {
            currentThread = refreshed;
            onThreadUpdated?.(refreshed);
          }
        } catch {
          console.warn('刷新追问会话失败');
        }
      }
    } finally {
      const hadFocus = !disposed && root.contains(document.activeElement);
      cleanupStream();
      sending = false;
      if (getFolder() === folder) onSendingChanged?.(false, null);
      activeRunId = null;
      pendingQuestion = '';
      if (!disposed && getFolder() === folder) {
        render();
        if (hadFocus) focusComposer();
      }
    }
  }

  sendBtn.addEventListener('click', () => {
    sendQuestion(textarea.value, { fromRetry: false });
  });

  textarea.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      ev.stopPropagation();
      sendQuestion(textarea.value, { fromRetry: false });
    }
  });

  /**
   * @param {ChatThread | null} nextThread
   */
  function setThread(nextThread) {
    if (disposed) return;
    currentThread = nextThread || null;
    currentThreadId = (nextThread && nextThread.id) || null;
    transientError = '';
    if (nextThread && nextThread.persistenceWarnings) {
      emitPersistenceWarnings(nextThread.persistenceWarnings);
    }
    if (!sending) render();
  }

  /**
   * @param {string} [idToLoad]
   */
  async function loadThread(idToLoad = currentThreadId || '') {
    const folder = originFolder;
    if (disposed || getFolder() !== folder) return null;
    if (!folder || !idToLoad || typeof api.getChatThread !== 'function') return null;
    try {
      const loaded = await api.getChatThread({ folder, id: idToLoad });
      if (disposed || getFolder() !== folder) return null;
      currentThread = loaded;
      currentThreadId = loaded ? loaded.id : idToLoad;
      transientError = '';
      render();
      return loaded;
    } catch (err) {
      if (disposed || getFolder() !== folder) return null;
      transientError = `加载会话失败：${errText(err)}`;
      render();
      return null;
    }
  }

  const onProjectChanged = () => {
    root.hidden = getFolder() !== originFolder;
    dispose();
  };
  function dispose() {
    if (disposed) return;
    disposed = true;
    bus?.removeEventListener('project:changed', onProjectChanged);
    cleanupStream();
    sending = false;
    activeRunId = null;
    syncComposerState();
  }
  render();
  bus?.addEventListener('project:changed', onProjectChanged);
  if (!currentThread && currentThreadId) {
    loadThread(currentThreadId);
  }

  return {
    root,
    dispose,
    setThread,
    setSending(value) { sending = value; render(); },
    /** @param {PendingChatOperation | null} operation */
    setPendingOperation(operation) {
      const hadFocus = root.contains(document.activeElement);
      sending = Boolean(operation);
      activeRunId = operation?.runId || null;
      pendingQuestion = operation?.question || '';
      render();
      if (!operation && hadFocus) focusComposer();
    },
    loadThread,
    getThread: () => currentThread,
    focus: focusComposer,
  };
}

export { formatStoredStats as formatChatStats };

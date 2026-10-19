import { formatStats, changesTitle, defaultExportName as makeExportName, copyMarkdown, exportReview } from '../../lib/aiShared.js';
import { renderMarkdownPage } from '../../markdown.js';

import { createChatView } from '../../lib/chatView.js';

export function createResultTools(context) {
  const chats = new Set();
  const disposeChats = () => { for (const chat of chats) chat.dispose(); chats.clear(); };
  context.bus.addEventListener('project:changed', disposeChats);
  // ---------- 通用小部件 ----------
  const statsLine = (stats) =>
    context.el('div', { class: 'ai-stats' }, formatStats(stats));

  const defaultExportName = (ext) => makeExportName('review', ext || 'md');

  const exportBtn = (markdown) => {
    const btn = context.el('button', { class: 'btn', type: 'button' }, '导出 Markdown');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await exportReview(context.api, context.toast, context.errText, () => ({
          defaultName: defaultExportName('md'), content: markdown, ext: 'md',
        }));
      } finally {
        btn.disabled = false;
      }
    });
    return btn;
  };

  const copyBtn = (markdown) => {
    const btn = context.el('button', { class: 'btn', type: 'button' }, '复制');
    btn.addEventListener('click', () => {
      copyMarkdown(markdown, context.toast);
    });
    return btn;
  };

  const exportHtmlBtn = (markdown) => {
    const btn = context.el('button', { class: 'btn', type: 'button' }, '导出 HTML');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await exportReview(context.api, context.toast, context.errText, () => ({
          defaultName: defaultExportName('html'),
          content: renderMarkdownPage(autoTitle(), markdown),
          ext: 'html',
        }));
      } finally {
        btn.disabled = false;
      }
    });
    return btn;
  };

  const exportGroup = (markdown) => {
    const group = context.el('div', { class: 'export-group' });
    group.appendChild(exportBtn(markdown));
    group.appendChild(copyBtn(markdown));
    group.appendChild(exportHtmlBtn(markdown));
    return group;
  };

  // 当前整体分析结果的维度标记：{ [小节标题]: 'useful' | 'useless' }，
  // 随评审历史持久化在 stats.sectionFeedback；重新分析时重置
  /** @type {Record<string, 'useful' | 'useless'>} */
  let sectionFeedback = {};
  /** @type {{ id?: string, title: string, markdown: string, stats: any, folder: string } | null} */
  let currentResult = null;

  // 维度标记回写：按 id 原地更新历史记录的 stats（不再整条重写，历史文件不膨胀）；
  // 旧版本产生的重复记录仍由历史列表按 title+markdown 去重展示
  const persistSectionFeedback = () => {
    if (!currentResult || currentResult.folder !== context.state.folder || typeof context.api.updateReviewStats !== 'function') return;
    const merged = { ...(currentResult.stats || {}), sectionFeedback: { ...sectionFeedback } };
    currentResult.stats = merged;
    if (!currentResult.id) return;
    context.api.updateReviewStats({ folder: currentResult.folder, id: currentResult.id, stats: merged })
      .catch((err) => context.toast('评审标记保存失败：' + context.errText(err), 'error'));
  };

  const buildSectionFollowUp = (folder, reviewId, title) =>
    createChatView({
      el: context.el,
      api: context.api,
      bus: context.bus,
      getFolder: () => context.state.folder,
      originFolder: folder,
      ensureThread: () => context.api.createChatThread({ folder, reviewId, sectionTitle: title }),
      placeholder: `就「${title}」继续提问（⌘Enter 发送）…`,
      label: `就「${title}」继续追问`,
      className: 'section-follow',
      toast: context.toast,
      errText: context.errText,
    });

  // 渲染完成后给每个 h2 小节注入操作条（追问 / 有用 / 没用）。
  // 流式期间不注入（只在整体分析完成后调用）；追问表单懒构建（首次点「追问」才创建），
  // 容器挂在小节正文之后；导出走原始 markdown 字符串，这些注入的 DOM 不会进入导出内容
  const injectSectionTools = (folder, reviewId) => {
    if (!reviewId || typeof context.api.createChatThread !== 'function') return;
    const sectionChats = new Map();
    for (const h2 of context.mdBox.querySelectorAll(':scope > h2')) {
      const title = (h2.textContent || '').trim(); // 注入按钮前先取纯标题
      // 懒构建追问表单：绝大多数小节永远不会被点开
      const ensureFollowChat = () => {
        let chat = sectionChats.get(h2);
        if (!chat) {
          chat = buildSectionFollowUp(folder, reviewId, title);
          chats.add(chat);
          chat.root.style.display = 'none';
          let next = h2.nextSibling;
          while (next && !(next.nodeType === 1 && /** @type {Element} */ (next).tagName === 'H2')) {
            next = next.nextSibling;
          }
          if (next) context.mdBox.insertBefore(chat.root, next);
          else context.mdBox.appendChild(chat.root);
          sectionChats.set(h2, chat);
        }
        return chat;
      };

      const tools = context.el('span', { class: 'section-tools' });
      const askBtn = context.el('button', {
        class: 'section-tool', type: 'button', title: '就这一节继续追问',
      }, '追问');
      const usefulBtn = context.el('button', {
        class: 'section-tool', type: 'button', title: '帮助改进评审维度',
      }, '有用');
      const uselessBtn = context.el('button', {
        class: 'section-tool', type: 'button', title: '帮助改进评审维度',
      }, '没用');
      const syncMarkUI = () => {
        const v = sectionFeedback[title];
        usefulBtn.classList.toggle('marked', v === 'useful');
        uselessBtn.classList.toggle('marked', v === 'useless');
        tools.classList.toggle('has-mark', !!v);
      };
      askBtn.addEventListener('click', () => {
        if (context.state.folder !== folder) return;
        const chat = ensureFollowChat();
        const opening = chat.root.style.display === 'none';
        chat.root.style.display = opening ? '' : 'none';
        h2.classList.toggle('tools-open', opening);
        if (opening) chat.focus();
      });
      usefulBtn.addEventListener('click', () => {
        if (context.state.folder !== folder) return;
        if (sectionFeedback[title] === 'useful') delete sectionFeedback[title];
        else sectionFeedback[title] = 'useful';
        syncMarkUI();
        persistSectionFeedback();
      });
      uselessBtn.addEventListener('click', () => {
        if (context.state.folder !== folder) return;
        if (sectionFeedback[title] === 'useless') delete sectionFeedback[title];
        else sectionFeedback[title] = 'useless';
        syncMarkUI();
        persistSectionFeedback();
      });
      tools.appendChild(askBtn);
      tools.appendChild(usefulBtn);
      tools.appendChild(uselessBtn);
      h2.appendChild(tools);
      syncMarkUI();
    }
  };

  const buildFollowUp = (folder, reviewId) => {
    if (!reviewId || typeof context.api.createChatThread !== 'function') return null;
    const chat = createChatView({
      el: context.el,
      api: context.api,
      bus: context.bus,
      getFolder: () => context.state.folder,
      originFolder: folder,
      ensureThread: () => context.api.createChatThread({ folder, reviewId }),
      placeholder: '就这次评审继续提问（⌘Enter 发送）…',
      label: '就本次评审继续追问',
      toast: context.toast,
      errText: context.errText,
    });
    chats.add(chat);
    return chat.root;
  };

  const autoTitle = () => changesTitle(context.state.changes ? context.state.changes.files : []);

  return {
  get disposeChats() { return disposeChats; },
  get sectionFeedback() { return sectionFeedback; },
  set sectionFeedback(value) { sectionFeedback = value; },
  get currentResult() { return currentResult; },
  set currentResult(value) { currentResult = value; },
  get injectSectionTools() { return injectSectionTools; },
  get statsLine() { return statsLine; },
  get exportGroup() { return exportGroup; },
  get buildFollowUp() { return buildFollowUp; },
  get autoTitle() { return autoTitle; },
  get defaultExportName() { return defaultExportName; },
  };
}

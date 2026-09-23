// 链接导入：隐藏 BrowserWindow 抓取 PRD 网页正文 / 设计稿网页截图，
// 使用持久 session（persist:planfetch）复用登录态；遇到登录墙时弹出窗口让用户登录后重试
const { BrowserWindow, session } = require('electron');

const TEXT_CAP = 50000;
const PAGE_TIMEOUT_MS = 30000;
const PRD_WAIT_MS = 2500; // SPA 渲染等待
const SHOT_WAIT_MS = 3000;
const MAX_PAGE_HEIGHT = 4000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    throw new Error('链接格式不正确，请输入完整的 http/https 地址');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http/https 链接，不支持 file:// 等其他协议');
  }
  return parsed;
}

// 登录墙判定（保守）：关键词出现在 title 或正文开头，且页面没有大段正文时才判定，
// 避免短页面或长文提到「登录」二字被误伤
function looksLikeLoginWall(title, text) {
  const body = String(text || '').trim();
  if (body.length >= 2000) return false;
  const head = `${title || ''}\n${body.slice(0, 500)}`.toLowerCase();
  return /登录|扫码|log\s?in|sign\s?in/i.test(head);
}

// UTF-8 被按 Latin-1/CP1252 误读时的典型字符集：高位拉丁扩展 + CP1252 高位映射标点
const MOJIBAKE_RUN =
  /[\u0080-\u00ff\u0152\u0153\u0160\u0161\u0178\u017d\u017e\u0192\u02c6\u02dc\u2013\u2014\u2018-\u201a\u201c-\u201e\u2020-\u2022\u2026\u2030\u2039\u203a\u20ac\u2122]{2,}/g;
const CJK_CHAR = /[\u4e00-\u9fff]/g;

// 乱码启发式：连续高位拉丁/CP1252 字符成段出现（正常欧洲语言中极少相邻），
// 且文本中没有足量真实 CJK（有则说明解码正常，混排页面不以乱码论）
function looksLikeMojibake(text) {
  const s = String(text || '');
  if (!s) return false;
  const runs = s.match(MOJIBAKE_RUN);
  if (!runs) return false;
  const runChars = runs.reduce((n, r) => n + r.length, 0);
  if (runChars < 8) return false;
  const cjk = (s.match(CJK_CHAR) || []).length;
  if (cjk * 3 >= runChars) return false;
  return runChars / s.length > 0.05;
}

function createFetchWindow(width, height) {
  return new BrowserWindow({
    show: false,
    width,
    height,
    session: session.fromPartition('persist:planfetch'),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
}

function destroyWindow(win) {
  if (win && !win.isDestroyed()) win.destroy();
}

function loadWithTimeout(win, url) {
  return Promise.race([
    win.loadURL(url),
    sleep(PAGE_TIMEOUT_MS).then(() => { throw new Error('页面加载超时（30 秒）'); }),
  ]);
}

// 弹出窗口让用户登录 / 操作，用户关闭窗口后 resolve(false)（此时窗口已销毁）；
// 120 秒兜底超时：自动关闭窗口并 resolve(true)，避免 IPC 无限挂起。
// 等待时长可用 PLANFETCH_LOGIN_WAIT_MS 覆盖（测试用）
const LOGIN_WAIT_MS = Number(process.env.PLANFETCH_LOGIN_WAIT_MS) || 120000;

function promptLogin(win) {
  return new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      destroyWindow(win); // 触发 closed
    }, LOGIN_WAIT_MS);
    win.setTitle('登录后关闭此窗口，将自动重试抓取');
    win.once('closed', () => {
      clearTimeout(timer);
      resolve(timedOut);
    });
    win.show();
    win.focus();
  });
}

const EXTRACT_JS = `(() => {
  const root = document.querySelector('article') || document.querySelector('main');
  const text = (root && root.innerText) || (document.body && document.body.innerText) || '';
  return { title: document.title || '', text };
})()`;

async function extractPage(win, url, waitMs) {
  await loadWithTimeout(win, url);
  await sleep(waitMs);
  const result = await win.webContents.executeJavaScript(EXTRACT_JS);
  return {
    title: String((result && result.title) || '').trim(),
    text: String((result && result.text) || '').slice(0, TEXT_CAP),
  };
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'");
}

// 回退路径：直接 fetch HTML 并去标签提取正文
async function fetchPrdFallback(parsed) {
  const res = await fetch(parsed.href, { redirect: 'follow', headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`网页请求失败（HTTP ${res.status}），页面可能需要登录`);
  const html = await res.text();
  const title = decodeEntities(
    (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '',
  ).trim();
  const text = decodeEntities(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, '\n'))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
    .slice(0, TEXT_CAP);
  if (text.length < 20) throw new Error('未能从网页提取到有效正文，页面可能需要登录后查看');
  return { title: title || parsed.hostname, text };
}

async function fetchPrdFromUrl(url) {
  const parsed = assertHttpUrl(url);
  let win = null;
  let result = null;
  try {
    try {
      win = createFetchWindow(1280, 800);
      result = await extractPage(win, parsed.href, PRD_WAIT_MS);
      if (looksLikeLoginWall(result.title, result.text)) {
        const timedOut = await promptLogin(win);
        win = createFetchWindow(1280, 800);
        result = await extractPage(win, parsed.href, PRD_WAIT_MS);
        if (timedOut && looksLikeLoginWall(result.title, result.text)) {
          throw new Error('登录窗口等待超时，请登录后重试');
        }
      }
    } catch (err) {
      if (err && String(err.message).includes('登录窗口等待超时')) throw err;
      result = null; // 隐藏窗口抓取失败，走 fetch 回退
    }
    // 隐藏窗口对未声明 charset 的 UTF-8 页面可能按 Latin-1/CP1252 解码产生乱码，
    // 检测到乱码时回退 fetch 路径（res.text() 按规范 UTF-8 解码），title 也从 <title> 重取
    if (result && looksLikeMojibake(`${result.title}\n${result.text.slice(0, 2000)}`)) {
      try {
        const fallback = await fetchPrdFallback(parsed);
        if (!looksLikeMojibake(`${fallback.title}\n${fallback.text.slice(0, 2000)}`)) {
          return fallback;
        }
      } catch { /* 回退失败或回退后仍乱码：保留原结果照常返回 */ }
    }
    if (result && result.text.trim().length >= 20) {
      return { title: result.title || parsed.hostname, text: result.text };
    }
    return await fetchPrdFallback(parsed);
  } finally {
    destroyWindow(win);
  }
}

const MIME_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
};

function sanitizeFileName(name) {
  const base = String(name || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_')
    .trim();
  if (!base || base === '.' || base === '..') return '';
  return base.slice(0, 100);
}

// 图片名取 URL 末段并清洗非法字符；无文件名或缺扩展名时用 域名-时间戳.扩展名
function imageNameFromUrl(parsed, mime) {
  let base = '';
  try {
    base = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
  } catch {
    base = '';
  }
  base = sanitizeFileName(base);
  const ext = MIME_EXT[mime] || '.png';
  if (!base) return `${parsed.hostname}-${Date.now().toString(36)}${ext}`;
  if (!/\.[a-z0-9]{2,5}$/i.test(base)) base += ext;
  return base;
}

async function pageMeta(win) {
  try {
    return await win.webContents.executeJavaScript(EXTRACT_JS);
  } catch {
    return { title: '', text: '' };
  }
}

// 整页截图：量出页面高度（封顶 MAX_PAGE_HEIGHT）后调整窗口再 capturePage
async function captureFullPage(win) {
  const height = await win.webContents.executeJavaScript(
    `Math.min(Math.max(` +
    `document.documentElement ? document.documentElement.scrollHeight : 0,` +
    `document.body ? document.body.scrollHeight : 0, 600), ${MAX_PAGE_HEIGHT})`);
  win.setContentSize(1440, Math.max(600, Number(height) || 900));
  await sleep(300); // 等重排与懒加载
  const image = await win.webContents.capturePage();
  return image.toPNG().toString('base64');
}

async function fetchDesignFromUrl(url) {
  const parsed = assertHttpUrl(url);
  // 图片直链：直接下载转 base64
  let res = null;
  try {
    res = await fetch(parsed.href, { redirect: 'follow', headers: { 'user-agent': UA } });
  } catch {
    res = null;
  }
  const mime = res && res.ok
    ? String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    : '';
  if (res && res.ok && mime.startsWith('image/')) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('图片内容为空');
    return { name: imageNameFromUrl(parsed, mime), base64: buf.toString('base64'), mime };
  }
  if (res && res.body) {
    try { res.body.cancel(); } catch { /* 忽略 */ }
  }
  // 网页（Figma 等）：隐藏窗口整页截图
  let win = null;
  try {
    win = createFetchWindow(1440, 900);
    await loadWithTimeout(win, parsed.href);
    await sleep(SHOT_WAIT_MS);
    const meta = await pageMeta(win);
    if (looksLikeLoginWall(meta.title, meta.text)) {
      const timedOut = await promptLogin(win);
      win = createFetchWindow(1440, 900);
      await loadWithTimeout(win, parsed.href);
      await sleep(SHOT_WAIT_MS);
      if (timedOut) {
        const retryMeta = await pageMeta(win);
        if (looksLikeLoginWall(retryMeta.title, retryMeta.text)) {
          throw new Error('登录窗口等待超时，请登录后重试');
        }
      }
    }
    const base64 = await captureFullPage(win);
    return {
      name: `${parsed.hostname}-${Date.now().toString(36)}.png`,
      base64,
      mime: 'image/png',
    };
  } finally {
    destroyWindow(win);
  }
}

module.exports = {
  fetchPrdFromUrl,
  fetchDesignFromUrl,
  // 以下为纯逻辑函数，导出供单元测试使用
  assertHttpUrl,
  looksLikeLoginWall,
  looksLikeMojibake,
  sanitizeFileName,
  imageNameFromUrl,
  decodeEntities,
  fetchPrdFallback,
};

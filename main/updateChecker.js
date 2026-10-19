const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const RELEASE_API = 'https://api.github.com/repos/iqaijey/ReviewFlow/releases/latest';
// 直链不走 api.github.com，不受未登录 60 次/小时的限流影响
const LATEST_YML_URL = 'https://github.com/iqaijey/ReviewFlow/releases/latest/download/latest-mac.yml';

// 三段数字 semver 比较：a > b 返回正数，a < b 返回负数，相等返回 0
function compareVersions(a, b) {
  const parse = (v) => String(v).replace(/^v/, '').split('-')[0]
    .split('.').map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// 从 latest-mac.yml 提取版本号和 dmg 文件名（简易文本解析，避免引入 yaml 依赖）
function parseLatestYml(text) {
  const versionMatch = text.match(/^version:\s*(\S+)/m);
  const entries = text.split(/^\s*-\s+url:\s*/m).slice(1);
  const selected = entries.find((entry) => /^\S+-arm64\.dmg\s*$/m.test(entry.split('\n')[0]));
  const dmgFile = selected ? selected.split('\n')[0].trim() : '';
  const digest = selected?.match(/^\s+sha512:\s*([A-Za-z0-9+/]+={0,2})\s*$/m)?.[1] || '';
  return {
    version: versionMatch ? versionMatch[1] : '',
    dmgFile,
    sha512: digest && Buffer.from(digest, 'base64').length === 64 ? digest : '',
  };
}

async function fetchNotes() {
  // 更新说明走 API（best-effort，限流时降级为空）
  try {
    const response = await fetch(RELEASE_API, {
      headers: { 'User-Agent': 'ReviewFlow', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return { notes: '', releaseUrl: '' };
    const release = /** @type {any} */ (await response.json());
    return {
      notes: release.name || release.body || '',
      releaseUrl: release.html_url || '',
    };
  } catch {
    return { notes: '', releaseUrl: '' };
  }
}

async function checkForUpdates() {
  let response;
  try {
    response = await fetch(LATEST_YML_URL, {
      headers: { 'User-Agent': 'ReviewFlow' },
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw new Error(`检查更新失败：网络请求出错（${err.message}）`);
  }
  if (!response.ok) {
    throw new Error(`检查更新失败：GitHub 返回 ${response.status}`);
  }
  const text = await response.text();
  const { version: latestVersion, dmgFile } = parseLatestYml(text);
  if (!latestVersion) throw new Error('检查更新失败：无法解析最新版本信息');

  const currentVersion = app.getVersion();
  const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

  let notes = '';
  let releaseUrl = 'https://github.com/iqaijey/ReviewFlow/releases/latest';
  if (hasUpdate) {
    const extra = await fetchNotes();
    notes = extra.notes;
    if (extra.releaseUrl) releaseUrl = extra.releaseUrl;
  }

  return {
    hasUpdate,
    latestVersion,
    currentVersion,
    notes,
    dmgUrl: dmgFile
      ? `https://github.com/iqaijey/ReviewFlow/releases/latest/download/${dmgFile}`
      : null,
    releaseUrl,
  };
}

// 下载地址只允许来自本项目 GitHub Releases，防止渲染层传入任意 URL 后被下载并 shell.openPath
const DOWNLOAD_URL_PREFIX = 'https://github.com/iqaijey/ReviewFlow/releases/';

/** @param {string} file @param {string} expected */
async function verifiedDownload(file, expected) {
  try {
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.size > 1024 ** 3) return false;
    const digest = crypto.createHash('sha512');
    for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
    return digest.digest('base64') === expected;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** @template T @param {(signal:AbortSignal, received:()=>void)=>Promise<T>} operation */
async function withDownloadStallTimeout(operation) {
  const controller = new AbortController();
  let timer;
  let received;
  const timeout = new Promise((_, reject) => {
    received = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const error = new Error('下载停滞：60 秒未收到数据');
        reject(error);
        controller.abort(error);
      }, 60000);
    };
    received();
  });
  try { return await Promise.race([operation(controller.signal, received), timeout]); }
  finally { clearTimeout(timer); }
}

async function downloadUpdate(dmgUrl, onProgress) {
  const url = String(dmgUrl || '');
  if (!url.startsWith(DOWNLOAD_URL_PREFIX)) {
    throw new Error('下载失败：非法的下载地址');
  }
  const fileName = path.basename(decodeURIComponent(new URL(url).pathname));
  if (!fileName.endsWith('.dmg')) throw new Error('下载失败：非法的安装包文件名');
  const manifest = await fetch(LATEST_YML_URL, { headers: { 'User-Agent': 'ReviewFlow' }, signal: AbortSignal.timeout(30000) });
  if (!manifest.ok) throw new Error('下载失败：无法获取更新包校验信息');
  const selected = parseLatestYml(await manifest.text());
  if (selected.dmgFile !== fileName || !selected.sha512) throw new Error('下载失败：缺少匹配的更新包校验信息');
  const downloadDir = path.join(app.getPath('userData'), 'downloads');
  await fs.promises.mkdir(downloadDir, { recursive: true });
  const filePath = path.join(downloadDir, fileName);
  if (await verifiedDownload(filePath, selected.sha512)) {
    if (typeof onProgress === 'function') onProgress(100);
    return filePath;
  }
  return withDownloadStallTimeout(async (signal, received) => {
  let response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': 'ReviewFlow' },
      signal,
    });
  } catch (err) {
    throw new Error(`下载失败：网络请求出错（${err.message}）`);
  }
  if (!response.ok || !response.body) {
    throw new Error(`下载失败：服务器返回 ${response.status}`);
  }

  const partial = path.join(downloadDir, `.${fileName}.${crypto.randomUUID()}.part`);
  const length = response.headers.get('content-length');
  const total = length === null ? null : Number(length);
  const cap = 1024 * 1024 * 1024;
  if (total !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(total) || total > cap)) {
    await response.body.cancel();
    throw new Error('下载失败：更新包大小超过 1 GiB 或长度无效');
  }
  const hash = crypto.createHash('sha512');
  const writer = await fs.promises.open(partial, 'wx', 0o600);
  let downloaded = 0;
  let lastReported = -1;

  try {
    for await (const chunk of response.body) {
      if (chunk.length) received();
      downloaded += chunk.length;
      if (downloaded > cap || (total !== null && downloaded > total)) throw new Error('更新包大小超过限制或与声明不符');
      hash.update(chunk);
      await writer.writeFile(chunk);
      if (total !== null && total > 0) {
        const percent = Math.min(100, Math.floor((downloaded / total) * 100));
        if (percent - lastReported >= 5 || percent === 100) {
          lastReported = percent;
          if (typeof onProgress === 'function') onProgress(percent);
        }
      }
    }
    if (total !== null && downloaded !== total) throw new Error('更新包长度与声明不符');
    if (hash.digest('base64') !== selected.sha512) throw new Error('更新包校验失败，已删除下载文件');
    await writer.sync();
  } catch (err) {
    await writer.close();
    await fs.promises.unlink(partial);
    throw err;
  }
  await writer.close();
  try {
    await fs.promises.rename(partial, filePath);
  } catch (error) {
    await fs.promises.unlink(partial);
    throw error;
  }
  if (typeof onProgress === 'function') onProgress(100);
  return filePath;
  });
}

module.exports = { checkForUpdates, downloadUpdate, compareVersions, parseLatestYml };

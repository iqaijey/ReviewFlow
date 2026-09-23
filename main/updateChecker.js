const fs = require('fs');
const path = require('path');
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
  const dmgMatch = text.match(/url:\s*(\S+-arm64\.dmg)/);
  return {
    version: versionMatch ? versionMatch[1] : '',
    dmgFile: dmgMatch ? dmgMatch[1] : '',
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

async function downloadUpdate(dmgUrl, onProgress) {
  let response;
  try {
    // 下载不限总时长：AbortSignal.timeout 会中断整个 body 读取
    response = await fetch(dmgUrl, {
      headers: { 'User-Agent': 'ReviewFlow' },
    });
  } catch (err) {
    throw new Error(`下载失败：网络请求出错（${err.message}）`);
  }
  if (!response.ok || !response.body) {
    throw new Error(`下载失败：服务器返回 ${response.status}`);
  }

  const downloadDir = path.join(app.getPath('userData'), 'downloads');
  await fs.promises.mkdir(downloadDir, { recursive: true });
  const fileName = decodeURIComponent(dmgUrl.split('?')[0].split('/').pop() || 'ReviewFlow-update.dmg');
  const filePath = path.join(downloadDir, fileName);

  const total = parseInt(response.headers.get('content-length') || '0', 10);

  // 已完整下载过同名文件时直接复用（用于「重新打开安装包」）
  if (total > 0) {
    try {
      if (fs.statSync(filePath).size === total) {
        await response.body.cancel().catch(() => {});
        if (typeof onProgress === 'function') onProgress(100);
        return filePath;
      }
    } catch { /* 文件不存在或已损坏则重新下载 */ }
  }

  const writer = fs.createWriteStream(filePath);
  let downloaded = 0;
  let lastReported = -1;

  try {
    for await (const chunk of response.body) {
      if (!writer.write(chunk)) {
        await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
          writer.once('drain', () => resolve());
          writer.once('error', reject);
        }));
      }
      downloaded += chunk.length;
      if (total > 0) {
        const percent = Math.min(100, Math.floor((downloaded / total) * 100));
        if (percent - lastReported >= 5 || percent === 100) {
          lastReported = percent;
          if (typeof onProgress === 'function') onProgress(percent);
        }
      }
    }
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      writer.end((err) => (err ? reject(err) : resolve()));
    }));
  } catch (err) {
    writer.destroy();
    await fs.promises.unlink(filePath).catch(() => {});
    throw new Error(`下载失败：${err.message}`);
  }

  if (total === 0 && typeof onProgress === 'function') onProgress(100);
  return filePath;
}

module.exports = { checkForUpdates, downloadUpdate, compareVersions };

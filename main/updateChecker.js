const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const RELEASE_API = 'https://api.github.com/repos/iqaijey/ReviewFlow/releases/latest';

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

async function checkForUpdates() {
  let response;
  try {
    response = await fetch(RELEASE_API, {
      headers: {
        'User-Agent': 'ReviewFlow',
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    throw new Error(`检查更新失败：网络请求出错（${err.message}）`);
  }
  if (!response.ok) {
    throw new Error(`检查更新失败：GitHub 返回 ${response.status}`);
  }

  let release;
  try {
    release = await response.json();
  } catch {
    throw new Error('检查更新失败：无法解析 GitHub 响应');
  }
  if (release.draft || release.prerelease) {
    throw new Error('检查更新失败：最新发布为草稿或预发布版本');
  }

  const tagName = release.tag_name || '';
  const latestVersion = tagName.replace(/^v/, '');
  const currentVersion = app.getVersion();
  const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const dmgAsset = assets.find((a) => typeof a.name === 'string' && a.name.endsWith('-arm64.dmg'));

  return {
    hasUpdate,
    latestVersion,
    currentVersion,
    notes: release.name || release.body || '',
    dmgUrl: dmgAsset ? dmgAsset.browser_download_url : null,
    releaseUrl: release.html_url || '',
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
        await new Promise((resolve, reject) => {
          writer.once('drain', resolve);
          writer.once('error', reject);
        });
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
    await new Promise((resolve, reject) => {
      writer.end((err) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    writer.destroy();
    await fs.promises.unlink(filePath).catch(() => {});
    throw new Error(`下载失败：${err.message}`);
  }

  if (total === 0 && typeof onProgress === 'function') onProgress(100);
  return filePath;
}

module.exports = { checkForUpdates, downloadUpdate, compareVersions };

// 应用图标自定义：选图 → sips/iconutil 生成 icns → 写入 app bundle + Dock 即时生效
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const exec = (bin, args) => /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
  execFile(bin, args, { timeout: 60_000 }, (err, _stdout, stderr) => {
    if (err) reject(new Error(stderr || err.message));
    else resolve();
  });
}));

function customIconPath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'custom-icon.png');
}

function bundleIcnsPath() {
  const { app } = require('electron');
  if (!app.isPackaged) return null;
  return path.join(path.dirname(path.dirname(app.getPath('exe'))), 'Resources', 'icon.icns');
}

// 启动时恢复自定义图标（Dock）
function applyOnStartup() {
  const { app } = require('electron');
  const custom = customIconPath();
  if (app.dock && fs.existsSync(custom)) {
    try {
      app.dock.setIcon(custom);
    } catch { /* 图标损坏则忽略 */ }
  }
}

// 用系统 sips/iconutil 把任意图片转成 iconset + icns
async function imageToIcns(imagePath) {
  const tmp = path.join(os.tmpdir(), `reviewflow-icon-${process.pid}-${Date.now()}`);
  const iconset = `${tmp}.iconset`;
  fs.mkdirSync(iconset, { recursive: true });
  const specs = [
    [1024, 'icon_512x512@2x'], [512, 'icon_512x512'], [512, 'icon_256x256@2x'],
    [256, 'icon_256x256'], [256, 'icon_128x128@2x'], [128, 'icon_128x128'],
    [64, 'icon_32x32@2x'], [32, 'icon_32x32'], [32, 'icon_16x16@2x'], [16, 'icon_16x16'],
  ];
  try {
    for (const [px, name] of specs) {
      await exec('/usr/bin/sips', ['-z', String(px), String(px), imagePath, '--out', path.join(iconset, `${name}.png`)]);
    }
    const icnsOut = `${tmp}.icns`;
    await exec('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icnsOut]);
    return icnsOut;
  } finally {
    fs.rmSync(iconset, { recursive: true, force: true });
  }
}

// 128px 预览图的 data URL
async function previewDataUrl(imagePath) {
  const tmpPng = path.join(os.tmpdir(), `reviewflow-icon-preview-${process.pid}-${Date.now()}.png`);
  try {
    await exec('/usr/bin/sips', ['-z', '128', '128', imagePath, '--out', tmpPng]);
    const buf = fs.readFileSync(tmpPng);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } finally {
    fs.rmSync(tmpPng, { force: true });
  }
}

async function applyCustomIcon(imagePath) {
  const { app } = require('electron');
  if (!fs.existsSync(imagePath)) throw new Error('图片文件不存在');
  const icns = await imageToIcns(imagePath);
  // 持久化源图（Dock 启动恢复 + 预览）
  fs.mkdirSync(path.dirname(customIconPath()), { recursive: true });
  fs.copyFileSync(imagePath, customIconPath());
  if (app.dock) {
    try {
      app.dock.setIcon(customIconPath());
    } catch { /* Dock 即时刷新失败不影响持久化 */ }
  }
  // 打包版：写入 bundle，让 Finder / 下次启动也用新图标
  let bundleUpdated = false;
  const bundleIcns = bundleIcnsPath();
  if (bundleIcns) {
    const defaultBackup = bundleIcns + '.default';
    try {
      if (!fs.existsSync(defaultBackup)) fs.copyFileSync(bundleIcns, defaultBackup);
      fs.copyFileSync(icns, bundleIcns);
      // 刷新 Finder 图标缓存
      const appDir = path.dirname(path.dirname(bundleIcns));
      await exec('/usr/bin/touch', [appDir]).catch(() => {});
      bundleUpdated = true;
    } catch { /* 无写入权限时仅 Dock 生效 */ }
  }
  fs.rmSync(icns, { force: true });
  return { bundleUpdated };
}

async function resetIcon() {
  const { app } = require('electron');
  fs.rmSync(customIconPath(), { force: true });
  const bundleIcns = bundleIcnsPath();
  const defaultBackup = bundleIcns ? bundleIcns + '.default' : null;
  if (bundleIcns && defaultBackup && fs.existsSync(defaultBackup)) {
    try {
      fs.copyFileSync(defaultBackup, bundleIcns);
      fs.rmSync(defaultBackup, { force: true });
      await exec('/usr/bin/touch', [path.dirname(path.dirname(bundleIcns))]).catch(() => {});
    } catch { /* 无写入权限 */ }
  }
  if (app.dock) {
    try {
      app.dock.setIcon(path.join(app.getAppPath(), 'build', 'icon.png'));
    } catch { /* 忽略 */ }
  }
}

function currentCustomIcon() {
  const custom = customIconPath();
  if (!fs.existsSync(custom)) return null;
  return previewDataUrl(custom);
}

module.exports = {
  applyOnStartup,
  applyCustomIcon,
  resetIcon,
  currentCustomIcon,
  previewDataUrl,
  imageToIcns,
};

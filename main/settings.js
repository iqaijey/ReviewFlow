const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  provider: 'openai-compatible',
  backend: 'api',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  opencodeModel: '',
  kimiModel: '',
  codexModel: '',
  customPrompt: '',
  reasoningEffort: '',
  overviewWidth: 0,
};

function settingsPath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'settings.json');
}

// 打包后 userData 从 auto-review 变为 Auto Review，旧设置一次性迁移
function migrateLegacySettings(file) {
  try {
    if (fs.existsSync(file)) return;
    const { app } = require('electron');
    if (path.basename(app.getPath('userData')) === 'auto-review') return;
    const legacyFile = path.join(app.getPath('appData'), 'auto-review', 'settings.json');
    if (fs.existsSync(legacyFile)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(legacyFile, file);
    }
  } catch { /* 迁移失败不影响启动 */ }
}

async function getSettings() {
  try {
    const file = settingsPath();
    migrateLegacySettings(file);
    const raw = await fs.promises.readFile(file, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return { ...DEFAULTS };
    return { ...DEFAULTS, ...data };
  } catch {
    return { ...DEFAULTS };
  }
}

async function saveSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('设置必须是对象');
  }
  const file = settingsPath();
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  // 与磁盘现有设置合并，避免只传部分字段时把其他设置重置为默认值
  const existing = await getSettings();
  const merged = { ...existing, ...settings };
  await fs.promises.writeFile(file, JSON.stringify(merged, null, 2), 'utf8');
}

module.exports = { getSettings, saveSettings };

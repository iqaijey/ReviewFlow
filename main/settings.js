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
  customDimensions: '',
  reasoningEffort: '',
  timeoutMin: 10,
  overviewWidth: 0,
  // 评审预设：[{id, name, dimensions[], customPrompt, backend, model, effort}]
  presets: [],
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

// 每批 AI 调用都会读设置：按 mtime 缓存，写盘（saveSettings）后 mtime 变化自然失效；
// 旧设置迁移检查只做一次
let migrateChecked = false;
/** @type {{ mtimeMs: number, value: any } | null} */
let settingsCache = null;

async function getSettings() {
  try {
    const file = settingsPath();
    if (!migrateChecked) {
      migrateChecked = true;
      migrateLegacySettings(file);
    }
    let mtimeMs;
    try {
      mtimeMs = (await fs.promises.stat(file)).mtimeMs;
    } catch {
      settingsCache = null;
      return { ...DEFAULTS };
    }
    if (settingsCache && settingsCache.mtimeMs === mtimeMs) return settingsCache.value;
    const raw = await fs.promises.readFile(file, 'utf8');
    const data = JSON.parse(raw);
    const value = !data || typeof data !== 'object' ? { ...DEFAULTS } : { ...DEFAULTS, ...data };
    settingsCache = { mtimeMs, value };
    return value;
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

const VALID_BACKENDS = new Set(['api', 'opencode', 'kimi', 'codex']);

// 预设导入的校验与合并：逐项规范化（name 必填，dimensions 转字符串数组，backend 白名单），
// 重名加「（导入）」后缀，id 缺失/冲突时重新生成。纯函数，便于单测
function mergeImportedPresets(data, existingPresets) {
  const list = data && Array.isArray(data.presets) ? data.presets : null;
  if (!list) throw new Error('导入失败：不是 ReviewFlow 预设文件');
  const existing = Array.isArray(existingPresets) ? existingPresets : [];
  const existingNames = new Set(existing.map((p) => p && p.name));
  const existingIds = new Set(existing.map((p) => p && p.id));
  const imported = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) continue;
    let finalName = name;
    if (existingNames.has(finalName)) finalName = `${name}（导入）`;
    let id = typeof raw.id === 'string' && raw.id ? raw.id : '';
    if (!id || existingIds.has(id)) id = `p${Date.now().toString(36)}${imported.length}`;
    existingNames.add(finalName);
    existingIds.add(id);
    imported.push({
      id,
      name: finalName,
      dimensions: (Array.isArray(raw.dimensions) ? raw.dimensions : [])
        .map((d) => String(d || '').trim()).filter(Boolean),
      customPrompt: typeof raw.customPrompt === 'string' ? raw.customPrompt : '',
      backend: VALID_BACKENDS.has(raw.backend) ? raw.backend : 'api',
      model: typeof raw.model === 'string' ? raw.model : '',
      effort: typeof raw.effort === 'string' ? raw.effort : '',
    });
  }
  if (!imported.length) throw new Error('导入失败：文件中没有有效的预设');
  return { imported, presets: existing.concat(imported) };
}

module.exports = { getSettings, saveSettings, mergeImportedPresets };

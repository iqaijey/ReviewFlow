const fs = require('fs');
const path = require('path');
const { writeFileAtomic, readJsonFile } = require('./atomicFile');

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
  noiseLevel: 'balanced',
  excludePatterns: ['**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/Podfile.lock', '**/Cargo.lock', '**/go.sum', '**/*.min.js', '**/*.map'],
  timeoutMin: 10,
  overviewWidth: 0,
  // 评审预设：[{id, name, dimensions[], customPrompt, backend, model, effort}]
  presets: [],
  pricing: {},
};

function settingsPath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'settings.json');
}

// 打包后 userData 从 auto-review 变为 Auto Review，旧设置一次性迁移
function migrateLegacySettings(file) {
  if (process.env.REVIEWFLOW_USER_DATA_DIR) return;
  try {
    if (fs.existsSync(file)) return;
    const { app } = require('electron');
    if (path.basename(app.getPath('userData')) === 'auto-review') return;
    const legacyFile = path.join(app.getPath('appData'), 'auto-review', 'settings.json');
    if (fs.existsSync(legacyFile)) {
      writeFileAtomic(file, fs.readFileSync(legacyFile), { mode: 0o600 });
    }
  } catch { /* 迁移失败不影响启动 */ }
}

// 每批 AI 调用都会读设置：按 mtime 缓存，写盘（saveSettings）后 mtime 变化自然失效；
// 旧设置迁移检查只做一次
let migrateChecked = false;
/** @type {{ mtimeMs: number, value: any } | null} */
let settingsCache = null;

async function getSettings() {
  const file = settingsPath();
  if (!migrateChecked) {
    migrateChecked = true;
    migrateLegacySettings(file);
  }
  let mtimeMs;
  try {
    const stat = await fs.promises.stat(file);
    if ((stat.mode & 0o777) !== 0o600) await fs.promises.chmod(file, 0o600);
    mtimeMs = stat.mtimeMs;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    settingsCache = null;
    return { ...DEFAULTS };
  }
  if (settingsCache && settingsCache.mtimeMs === mtimeMs) return settingsCache.value;
  const data = readJsonFile(file, null);
  const value = !data || typeof data !== 'object' ? { ...DEFAULTS } : { ...DEFAULTS, ...data };
  for (const field of Object.keys(DEFAULTS)) {
    try {
      if (field === 'excludePatterns') value[field] = validateExcludePatterns(value[field]);
      else if (field === 'pricing') value[field] = validatePricing(value[field]);
      else if (field === 'presets') {
        if (!Array.isArray(value[field])) throw new Error('类型无效');
        value[field] = sanitizePresets(value[field]);
      } else if (typeof value[field] !== typeof DEFAULTS[field]
        || (typeof value[field] === 'number' && !Number.isFinite(value[field]))
        || (field === 'noiseLevel' && !['quiet', 'balanced', 'detailed'].includes(value[field]))) throw new Error('类型无效');
    } catch {
      console.warn(`设置字段 ${field} 无效，已使用默认值`);
      value[field] = structuredClone(DEFAULTS[field]);
    }
  }
  settingsCache = { mtimeMs, value };
  return value;
}

async function saveSettings(settings) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('设置必须是对象');
  }
  const file = settingsPath();
  // 与磁盘现有设置合并，避免只传部分字段时把其他设置重置为默认值
  const existing = await getSettings();
  if (settings.noiseLevel !== undefined && !['quiet', 'balanced', 'detailed'].includes(settings.noiseLevel)) throw new Error('噪声等级必须为 quiet、balanced 或 detailed');
  if (settings.excludePatterns !== undefined) validateExcludePatterns(settings.excludePatterns);
  if (settings.pricing !== undefined) validatePricing(settings.pricing);
  const { clearApiKey, apiKeySet, apiKeyHint, ...patch } = settings;
  if (patch.apiKey !== undefined && typeof patch.apiKey !== 'string') throw new Error('API Key 必须为文本');
  const merged = { ...existing, ...patch,
    apiKey: clearApiKey === true ? '' : patch.apiKey?.trim() || (patch.baseUrl !== undefined && patch.baseUrl !== existing.baseUrl ? '' : existing.apiKey) };
  if (Array.isArray(merged.presets)) merged.presets = sanitizePresets(merged.presets);
  // ad-hoc 签名更新会反复触发钥匙串授权，因此不用 safeStorage/Keychain，文件仅本人可读写。
  writeFileAtomic(file, JSON.stringify(merged, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fs.promises.chmod(file, 0o600);
  settingsCache = null;
}

const VALID_BACKENDS = new Set(['api', 'opencode', 'kimi', 'codex']);

/** @typedef {{inputPerMTokens:number,outputPerMTokens:number,currency:'USD'|'CNY'}} Price */
/** @param {unknown} pricing @returns {Record<string,Price>} */
function validatePricing(pricing) {
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing) || Object.keys(pricing).length > 50) throw new Error('价格配置必须是最多 50 项的对象');
  const entries = Object.entries(pricing).map(([key, value]) => {
    if (!/^(api|opencode|kimi|codex)(?::[^\s\0\r\n]{1,200})?$/.test(key) || !value || typeof value !== 'object' || Array.isArray(value)
      || !['USD', 'CNY'].includes(value.currency) || ![value.inputPerMTokens, value.outputPerMTokens].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) throw new Error(`价格配置无效：${key}`);
    return [key, { inputPerMTokens: value.inputPerMTokens, outputPerMTokens: value.outputPerMTokens, currency: value.currency }];
  });
  return Object.fromEntries(entries);
}

/** @param {unknown} patterns @returns {string[]} */
function validateExcludePatterns(patterns) {
  if (!Array.isArray(patterns) || patterns.length > 200 || patterns.some((p) => typeof p !== 'string' || p.length > 200 || /[\0\r\n]/.test(p))) {
    throw new Error('排除规则必须为字符串数组，最多 200 条，每条最多 200 字');
  }
  return patterns.map((p) => p.trim()).filter(Boolean);
}

async function getExcludePatterns() {
  // Node 单测不启动 Electron，使用同一份默认规则。
  if (!require('electron').app) return [...DEFAULTS.excludePatterns];
  return (await getSettings()).excludePatterns;
}

function sanitizePresets(presets) {
  return presets.filter((p) => p && typeof p === 'object').map((p) => ({
    id: typeof p.id === 'string' ? p.id : '', name: typeof p.name === 'string' ? p.name : '',
    dimensions: Array.isArray(p.dimensions) ? p.dimensions.filter((d) => typeof d === 'string') : [],
    customPrompt: typeof p.customPrompt === 'string' ? p.customPrompt : '',
    backend: typeof p.backend === 'string' ? p.backend : 'api',
    model: typeof p.model === 'string' ? p.model : '', effort: typeof p.effort === 'string' ? p.effort : '',
  }));
}

async function getPublicSettings() {
  const settings = await getSettings();
  const key = typeof settings.apiKey === 'string' ? settings.apiKey : '';
  return { ...settings, presets: sanitizePresets(settings.presets || []), apiKey: '', apiKeySet: Boolean(key), apiKeyHint: key ? `••••${key.slice(-4)}` : '' };
}

async function resolveConnectionSettings(requested) {
  const stored = await getSettings();
  if (!requested) return stored;
  if ((requested.backend && requested.backend !== 'api') || requested.apiKey?.trim()) return requested;
  if (requested.baseUrl !== stored.baseUrl) throw new Error('更换了接口地址，请重新填写 API Key');
  return { ...requested, apiKey: requested.clearApiKey ? '' : stored.apiKey };
}

// 预设导入的校验与合并：逐项规范化（name 必填，dimensions 转字符串数组，backend 白名单），
// 重名加「（导入）」后缀，id 缺失/冲突时重新生成。纯函数，便于单测
function mergeImportedPresets(data, existingPresets) {
  const list = data && Array.isArray(data.presets) ? data.presets : null;
  if (!list) throw new Error('导入失败：不是 ReviewFlow 预设文件');
  const existing = Array.isArray(existingPresets) ? sanitizePresets(existingPresets) : [];
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

module.exports = { getSettings, getPublicSettings, resolveConnectionSettings, saveSettings, mergeImportedPresets, sanitizePresets, validateExcludePatterns, validatePricing, getExcludePatterns };

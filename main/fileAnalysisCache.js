const path = require('path');
const { hash } = require('./reviewSnapshot');
const { assertFolder } = require('./chatStore');
const { readJsonFile, writeFileAtomic } = require('./atomicFile');

/** @typedef {{backend:string,endpoint:string|null,requestedModel:string|null,resolvedModel:string|null,effort:string,cliConfigFingerprint:string|null,maxTokens:number,temperature:number,promptVersion:string}} Execution */
/** @typedef {{schemaVersion:2,key:string,path:string,diffFingerprint:string,promptHash:string,executionHash:string,promptVersion:string,backend:string,model:string|null,effort:string,reusable:boolean,createdAt:number,lastUsedAt:number,markdown:string,stats:Record<string,unknown>|null,coverageNotices:string[]}} FileAnalysisCacheEntry */
/** @typedef {Omit<FileAnalysisCacheEntry,'createdAt'|'lastUsedAt'|'markdown'|'stats'|'coverageNotices'>} CacheIdentity */
/** @typedef {{markdown:string,stats:Record<string,unknown>|null,coverageNotices:string[],cacheHit:boolean,cacheKey:string|null,cachedAt:number|null,reusable?:boolean,persistenceWarnings?:string[]}} AnalysisResult */

/** @param {{path:string,diffFingerprint:string,system:string,user:string,execution:Execution,reusable?:boolean}} input @returns {CacheIdentity} */
function buildIdentity({ path: filePath, diffFingerprint, system, user, execution, reusable = true }) {
  const promptHash = hash(system + JSON.stringify(['user', user]));
  // 白名单排序构造，API key、URL 用户信息与配置原文不进入指纹。
  const executionHash = hash(JSON.stringify([execution.backend, execution.endpoint, execution.requestedModel, execution.resolvedModel,
    execution.effort, execution.cliConfigFingerprint, execution.maxTokens, execution.temperature, execution.promptVersion]));
  const keyParts = ['file-v2', diffFingerprint, promptHash, executionHash];
  if (!reusable) keyParts.push('non-reusable', filePath);
  return { schemaVersion: 2, reusable, key: hash(JSON.stringify(keyParts)), path: filePath,
    diffFingerprint, promptHash, executionHash, promptVersion: execution.promptVersion, backend: execution.backend, model: execution.resolvedModel, effort: execution.effort };
}

/** @param {{root?:()=>string,maxEntries?:number,maxBytes?:number}} [options] */
function createFileAnalysisCache({ root = () => require('electron').app.getPath('userData'), maxEntries = 200, maxBytes = 20 * 1024 * 1024 } = {}) {
  /** @type {Map<string,Promise<AnalysisResult>>} */
  const inFlight = new Map();
  function filename(folder) { assertFolder(folder); return path.join(root(), 'review-file-cache', `${hash(folder)}.json`); }
  /** @param {string} folder @returns {{schemaVersion:2,folder:string,entries:FileAnalysisCacheEntry[]}} */
  function read(folder) {
    const value = readJsonFile(filename(folder), { schemaVersion: 2, folder, entries: [] });
    if (value.schemaVersion !== 2 || value.folder !== folder || !Array.isArray(value.entries)
      || value.entries.some((e) => !e || e.schemaVersion !== 2 || !/^[a-f0-9]{64}$/.test(e.key) || typeof e.markdown !== 'string'
        || typeof e.path !== 'string' || !Number.isSafeInteger(e.lastUsedAt)
        || (e.coverageNotices !== undefined && (!Array.isArray(e.coverageNotices) || e.coverageNotices.some((n) => typeof n !== 'string'))))) throw new Error('逐文件缓存存储结构无效，请保留文件并修复');
    return value;
  }
  function write(folder, container) {
    container.entries.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    container.entries = container.entries.slice(0, maxEntries);
    while (container.entries.length && Buffer.byteLength(JSON.stringify(container)) > maxBytes) container.entries.pop();
    writeFileAtomic(filename(folder), JSON.stringify(container), 'utf8');
  }
  /** @param {FileAnalysisCacheEntry} entry @param {boolean} cacheHit @returns {AnalysisResult} */
  function result(entry, cacheHit) { return { markdown: entry.markdown, stats: entry.stats, coverageNotices: entry.coverageNotices || [], cacheHit, cacheKey: entry.key, cachedAt: entry.createdAt, reusable: entry.reusable !== false }; }
  function warning(error) { return `逐文件结果缓存失败：${error instanceof Error ? error.message : String(error)}`; }
  function lookup(folder, key) {
    const container = read(folder);
    const entry = container.entries.find((e) => e.key === key && e.reusable !== false);
    if (!entry) return null;
    entry.lastUsedAt = Math.max(Date.now(), ...container.entries.map((e) => e.lastUsedAt + 1));
    const hit = result(entry, true);
    try { write(folder, container); } catch (error) { hit.persistenceWarnings = [warning(error)]; }
    return hit;
  }
  /** @param {string} folder @param {CacheIdentity[]} identities */
  function list(folder, identities) {
    if (!identities.length) return [];
    const container = read(folder);
    const matches = identities.flatMap((identity) => {
      const entry = container.entries.filter((e) => e.path === identity.path && (e.reusable === false
        ? e.diffFingerprint === identity.diffFingerprint : identity.reusable && e.key === identity.key))
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      return entry ? [entry] : [];
    });
    if (!matches.length) return [];
    const now = Math.max(Date.now(), ...container.entries.map((e) => e.lastUsedAt + 1));
    for (const entry of matches) entry.lastUsedAt = now;
    const results = matches.map((entry) => ({ path: entry.path, ...result(entry, entry.reusable !== false), reusable: entry.reusable !== false }));
    try { write(folder, container); } catch (error) {
      for (const entry of results) Object.assign(entry, { persistenceWarnings: [warning(error)] });
    }
    return results;
  }
  /** @param {string} folder @param {CacheIdentity|null} identity @param {()=>Promise<{markdown:string,stats:Record<string,unknown>|null,coverageNotices?:string[]}>} call @param {boolean} [force] @returns {Promise<AnalysisResult>} */
  async function run(folder, identity, call, force = false) {
    assertFolder(folder);
    if (!identity) {
      const response = await call();
      return { ...response, coverageNotices: response.coverageNotices || [], cacheHit: false, cacheKey: null, cachedAt: null };
    }
    const flightKey = JSON.stringify([folder, identity.key]);
    const pending = inFlight.get(flightKey);
    if (pending) return pending;
    const warnings = [];
    if (!force && identity.reusable) {
      try { const hit = lookup(folder, identity.key); if (hit) return hit; }
      catch (error) { warnings.push(warning(error)); }
    }
    const promise = (async () => {
      const raw = await call();
      const response = { ...raw, coverageNotices: raw.coverageNotices || [] };
      if (typeof response.markdown !== 'string' || !response.markdown.trim()) throw new Error('逐文件分析返回空结果，未写入缓存');
      try {
        const container = read(folder);
        const now = Math.max(Date.now(), ...container.entries.map((e) => e.lastUsedAt + 1));
        const entry = { ...identity, ...response, createdAt: now, lastUsedAt: now };
        container.entries = container.entries.filter((e) => e.key !== identity.key);
        container.entries.unshift(entry);
        write(folder, container);
        return { ...result(entry, false), ...(warnings.length ? { persistenceWarnings: warnings } : {}) };
      } catch (error) {
        warnings.push(warning(error));
        return { ...response, cacheHit: false, cacheKey: null, cachedAt: null, reusable: identity.reusable, persistenceWarnings: [...new Set(warnings)] };
      }
    })();
    inFlight.set(flightKey, promise);
    try { return await promise; } finally { inFlight.delete(flightKey); }
  }
  return { lookup, run, list };
}
module.exports = { ...createFileAnalysisCache(), createFileAnalysisCache, buildIdentity };

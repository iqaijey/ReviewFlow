const { readRepoFile, inspectRepoFile } = require('./safeRead');

// 文件内容缓存：同一次评审链路里 extractClasses 与 prompt 构建（buildContext）会重复读
// 同一文件 2~3 次。按 path+mtimeMs 缓存，文件被修改后自动失效；LRU 封顶防止长期占用
const MAX_ENTRIES = 300;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
let cachedBytes = 0;
/** @type {Map<string, { mtimeMs: number, content: string, bytes: number }>} */
const cache = new Map();

// 读取项目内文件的 utf8 文本；不存在或读取失败返回 null（调用方按「无上下文」降级）
function readFile(folder, rel) {
  const key = `${folder}\n${rel}`;
  let mtimeMs;
  try {
    const { stat } = inspectRepoFile(folder, rel, { maxBytes: MAX_FILE_BYTES });
    mtimeMs = stat.mtimeMs;
  } catch {
    const stale = cache.get(key);
    if (stale) { cachedBytes -= stale.bytes; cache.delete(key); }
    return null;
  }
  const hit = cache.get(key);
  if (hit && hit.mtimeMs === mtimeMs) {
    cache.delete(key);
    cache.set(key, hit);
    return hit.content;
  }
  let content;
  try {
    content = readRepoFile(folder, rel, { maxBytes: MAX_FILE_BYTES }).toString('utf8');
  } catch {
    return null;
  }
  if (hit) cachedBytes -= hit.bytes;
  const bytes = Buffer.byteLength(content);
  cache.delete(key);
  cache.set(key, { mtimeMs, content, bytes });
  cachedBytes += bytes;
  while (cache.size > MAX_ENTRIES || cachedBytes > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cachedBytes -= cache.get(oldest)?.bytes || 0;
    cache.delete(oldest);
  }
  return content;
}

module.exports = { readFile };

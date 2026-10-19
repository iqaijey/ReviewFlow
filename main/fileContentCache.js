const fs = require('fs');
const path = require('path');

// 文件内容缓存：同一次评审链路里 extractClasses 与 prompt 构建（buildContext）会重复读
// 同一文件 2~3 次。按 path+mtimeMs 缓存，文件被修改后自动失效；LRU 封顶防止长期占用
const MAX_ENTRIES = 300;
/** @type {Map<string, { mtimeMs: number, content: string }>} */
const cache = new Map();

// 读取项目内文件的 utf8 文本；不存在或读取失败返回 null（调用方按「无上下文」降级）
function readFile(folder, rel) {
  const key = `${folder}\n${rel}`;
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(path.join(folder, rel)).mtimeMs;
  } catch {
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
    content = fs.readFileSync(path.join(folder, rel), 'utf8');
  } catch {
    return null;
  }
  cache.set(key, { mtimeMs, content });
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return content;
}

module.exports = { readFile };

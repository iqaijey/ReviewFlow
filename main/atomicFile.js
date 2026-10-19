const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

/**
 * @param {string} file
 * @param {string | NodeJS.ArrayBufferView} data
 * @param {import('fs').WriteFileOptions} [options]
 */
function writeFileAtomic(file, data, options) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  let mode;
  try {
    mode = fs.statSync(file).mode & 0o7777;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temp = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
  /** @type {number | undefined} */
  let fd;
  let created = false;
  try {
    const requestedMode = options && typeof options === 'object' ? options.mode : undefined;
    fd = fs.openSync(temp, 'wx', mode ?? requestedMode);
    created = true;
    // 同目录替换保证读者只会看到完整的新旧版本，落盘前不动原文件。
    fs.writeFileSync(fd, data, options);
    if (mode !== undefined) fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        console.warn('原子写入失败：无法关闭临时文件');
      }
    }
    if (created) {
      try {
        fs.unlinkSync(temp);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') console.warn('原子写入失败：无法清理临时文件');
      }
    }
    throw error;
  }
}

/**
 * @param {string} file
 * @param {unknown} fallback
 */
function readJsonFile(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
  try {
    return JSON.parse(raw) ?? fallback;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // 隔离失败必须阻止后续保存，不能覆盖唯一的损坏副本。
    const backup = `${file}.corrupt-${Date.now()}-${randomUUID()}`;
    fs.renameSync(file, backup);
    console.warn(`JSON 文件损坏，已保留为 ${path.basename(backup)}`);
    return fallback;
  }
}

module.exports = { writeFileAtomic, readJsonFile };

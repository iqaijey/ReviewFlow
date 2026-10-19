const fs = require('fs');
const path = require('path');

/** @param {string} root @param {string} file */
function assertContained(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('文件路径必须位于项目目录内');
  }
}

/** @param {string} folder @param {string} relPath @param {{maxBytes:number}} options */
function inspectRepoFile(folder, relPath, { maxBytes }) {
  if (typeof relPath !== 'string' || !relPath || relPath.includes('\0') || path.isAbsolute(relPath)
    || path.win32.isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..')) throw new Error('文件路径必须是项目内相对路径');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('文件大小限制无效');
  const root = fs.realpathSync(folder);
  if (!fs.statSync(root).isDirectory()) throw new Error('项目路径不是目录');
  let file = root;
  for (const component of relPath.split(path.sep).filter(Boolean)) {
    file = path.join(file, component);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('项目文件路径不能包含符号链接');
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new Error('项目文件必须是普通文件');
  assertContained(root, fs.realpathSync(file));
  if (stat.size > maxBytes) throw Object.assign(new Error('项目文件超过大小限制'), { code: 'ERR_REPO_FILE_TOO_LARGE' });
  return { root, file, stat };
}

/** 同步有界读取；缓存命中也须重新检查每层路径。 @param {string} folder @param {string} relPath @param {{maxBytes:number}} options @returns {Buffer} */
function readRepoFile(folder, relPath, options) {
  const { root, file, stat } = inspectRepoFile(folder, relPath, options);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('项目文件在读取前已变化');
    if (opened.size > options.maxBytes) throw Object.assign(new Error('项目文件超过大小限制'), { code: 'ERR_REPO_FILE_TOO_LARGE' });
    // Node 无 openat；并发写入工作树的本地参与者仍可能精确竞态，分层检查仅将窗口缩至最小。
    const second = inspectRepoFile(root, relPath, options).stat;
    if (second.dev !== opened.dev || second.ino !== opened.ino) throw new Error('项目文件在读取前已变化');
    const buffer = Buffer.alloc(options.maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    if (bytes > options.maxBytes) throw Object.assign(new Error('项目文件超过大小限制'), { code: 'ERR_REPO_FILE_TOO_LARGE' });
    const third = inspectRepoFile(root, relPath, options).stat;
    if (third.dev !== opened.dev || third.ino !== opened.ino) throw new Error('项目文件在读取期间已变化');
    return buffer.subarray(0, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { readRepoFile, inspectRepoFile };

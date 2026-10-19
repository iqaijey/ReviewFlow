const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { hash } = require('./findingModel');
const { excludedBy } = require('./globMatch');
const { readRepoFile } = require('./safeRead');
const exec = promisify(execFile);
/** @typedef {{path:string,additions:number,deletions:number}} PatchFile */

function validateFolder(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || /[\0\r\n]/.test(folder)) throw new Error('缺少有效项目绝对路径');
  return folder;
}
function safePath(value) {
  if (typeof value !== 'string' || !value || /[\\\0\r\n\t"]/.test(value) || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)
    || value.split('/').some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git')) throw new Error(`补丁路径不安全：${value}`);
  return value;
}
/** 检查每一级目录，不能经符号链接绕过仓库边界。 @param {string} folder @param {string} relative */
function readTarget(folder, relative) {
  safePath(relative);
  let full = fs.realpathSync(validateFolder(folder));
  for (const part of relative.split('/')) {
    full = path.join(full, part);
    try {
      if (fs.lstatSync(full).isSymbolicLink()) throw new Error(`不允许修改符号链接：${relative}`);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  if (!fs.statSync(full).isFile()) throw new Error(`目标不是普通文件：${relative}`);
  let content;
  try { content = readRepoFile(folder, relative, { maxBytes: 2 * 1024 * 1024 }); }
  catch (error) {
    if (error.code === 'ERR_REPO_FILE_TOO_LARGE') throw new Error(`目标文件超过 2 MiB 大小限制：${relative}`);
    throw error;
  }
  if (content.includes(0)) throw new Error(`不允许修改二进制文件：${relative}`);
  return content;
}
function extractDiff(content) {
  const match = String(content || '').replace(/\r\n/g, '\n').match(/^\s*```diff[^\S\n]*\n([\s\S]*?)^\s*```\s*$/mi);
  if (!match || !match[1].trim()) throw new Error('未返回有效的非空 diff 围栏');
  if (Buffer.byteLength(match[1]) > 2 * 1024 * 1024) throw new Error('补丁超过 2 MB 限制');
  return match[1].replace(/\n*$/, '\n');
}
/** @returns {{files:PatchFile[],strip:number}} */
function inspectDiff(diff) {
  if (/^(?:GIT binary patch|Binary files |(?:old|new|new file|deleted file) mode |rename |copy |similarity index|dissimilarity index)/m.test(diff)) throw new Error('补丁仅支持普通文本内容修改，不支持二进制、模式或重命名');
  /** @type {PatchFile[]} */
  const files = [];
  const lines = diff.split('\n');
  let strip = -1;
  let header = '';
  let inHunk = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) { header = line; inHunk = false; continue; }
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      const old = line.slice(4), next = lines[++i].slice(4);
      const prefixed = old.startsWith('a/') && next.startsWith('b/');
      const n = prefixed ? 1 : 0;
      const a = safePath(prefixed ? old.slice(2) : old), b = safePath(prefixed ? next.slice(2) : next);
      if (a !== b) throw new Error('补丁不允许新增、删除或重命名文件');
      if (strip !== -1 && strip !== n) throw new Error('补丁路径前缀不一致');
      strip = n;
      if (header && header !== `diff --git ${old} ${next}`) throw new Error('补丁文件头路径不一致');
      if (files.some((f) => f.path === b)) throw new Error('补丁包含重复文件头');
      files.push({ path: b, additions: 0, deletions: 0 });
      header = ''; inHunk = false;
    } else if (line.startsWith('@@ ')) {
      if (!files.length || !/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) throw new Error('补丁块格式无效');
      inHunk = true;
    } else if (inHunk && line.startsWith('+')) files[files.length - 1].additions++;
    else if (inHunk && line.startsWith('-')) files[files.length - 1].deletions++;
    else if (line && !line.startsWith(' ') && !line.startsWith('\\ No newline') && !/^index [0-9a-f]+\.\.[0-9a-f]+(?: 100(?:644|755))?$/.test(line)) throw new Error('补丁包含不支持的内容');
  }
  if (header || !files.length || files.some((f) => !f.additions && !f.deletions)) throw new Error('补丁没有有效内容改动');
  return { files, strip };
}
async function validateTargets(folder, files, findingPath) {
  const patterns = [...await require('./settings').getExcludePatterns(), ...require('./effectiveRules').rootIgnorePatterns(folder)];
  for (const file of files) {
    safePath(file.path);
    if (file.path !== findingPath) throw new Error(`默认仅允许修改问题所在文件 ${findingPath}，补丁包含其他文件：${file.path}`);
    if (excludedBy(file.path, patterns)) throw new Error(`补丁文件已被排除：${file.path}`);
    if (require('./git').isResourcePath(file.path)) throw new Error(`资源文件不允许生成补丁：${file.path}`);
    if (readTarget(folder, file.path) === null) throw new Error(`目标文件不存在：${file.path}`);
  }
}
async function runGit(folder, args) {
  return (await exec('git', ['-C', validateFolder(folder), ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout;
}
async function applyGit(folder, diff, strip, reverse = false, check = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewflow-patch-'));
  const file = path.join(dir, 'patch.diff');
  try {
    fs.writeFileSync(file, diff, { mode: 0o600, flag: 'wx' });
    await runGit(folder, ['apply', ...(reverse ? ['-R'] : []), ...(check ? ['--check'] : []), '--recount', `-p${strip}`, '--', file]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function targetHashes(folder, files) {
  return Object.fromEntries(files.map((f) => { const content = readTarget(folder, f.path); return [f.path, content === null ? null : hash(content)]; }));
}
module.exports = { validateFolder, safePath, readTarget, extractDiff, inspectDiff, validateTargets, runGit, applyGit, targetHashes };

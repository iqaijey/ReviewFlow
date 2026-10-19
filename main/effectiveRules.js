const path = require('path');
const { execFileSync } = require('child_process');
const { hash } = require('./reviewSnapshot');
const { readRepoFile, inspectRepoFile } = require('./safeRead');

const RULE_FILE_MAX_BYTES = 1024 * 1024;

/** @typedef {{path:string,raw:string,text:string,mtime:number,size:number}} RuleFile */
/** @typedef {{files:Array<{path:string,chars:number,included:boolean,truncated:boolean}>,text:string,truncated:boolean,totalChars:number}} EffectiveRules */
/** @type {Map<string,{key:string,files:RuleFile[]}>} */
const cache = new Map();
const MARKER = '\n（内容过长已截断）';

/** @param {string} raw */
function parseRules(raw) {
  const patterns = [];
  const lines = raw.split(/\r?\n/);
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const opening = lines[i].match(/^ {0,3}(`{3,}|~{3,})\s*reviewflow-ignore\s*$/);
    if (!opening) { kept.push(lines[i]); continue; }
    const fence = opening[1];
    while (++i < lines.length) {
      const closing = lines[i].trim();
      if (closing.length >= fence.length && [...closing].every((ch) => ch === fence[0])) break;
      const pattern = lines[i].trim();
      if (pattern && !pattern.startsWith('#') && pattern.length <= 200 && patterns.length < 200) patterns.push(pattern);
    }
  }
  return { text: kept.join('\n').trim(), patterns };
}

/** @param {string} folder @param {string[]} args */
function gitRead(folder, args) {
  return execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** @param {string} folder @returns {RuleFile[]} */
function discoverRules(folder) {
  if (!folder) return [];
  let names = ['.reviewflow.md'];
  let head = '';
  try {
    // 由 git 按 pathspec 过滤：大仓库全量列文件会同步阻塞主进程，还可能超出 maxBuffer
    names.push(...gitRead(folder, ['ls-files', '-co', '--exclude-standard', '-z', '--', ':(glob)**/.reviewflow.md'])
      .split('\0').filter((p) => path.posix.basename(p) === '.reviewflow.md'));
    head = gitRead(folder, ['rev-parse', '--verify', 'HEAD']).trim();
  } catch (error) {
    // 非仓库、unborn HEAD 或输出超限时仍可使用根规则，已发现的文件不丢弃。
    if (!error.status && error.code !== 'ENOENT' && error.code !== 'ENOBUFS') throw error;
  }
  names = [...new Set(names)].filter((p) => !path.isAbsolute(p) && !p.split('/').includes('..'))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b)).slice(0, 50);
  /** @param {string} name @param {(name: string) => T} read @returns {T[]} @template T */
  const safely = (name, read) => {
    try {
      return [read(name)];
    } catch (error) {
      // 符号链接、非普通文件、越界或超大的规则文件按不存在处理，与此前跳过符号链接的行为一致
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ERR_REPO_FILE_TOO_LARGE' || !error.code) return [];
      throw new Error(`读取项目评审规范失败：${error.message}`);
    }
  };
  const stats = names.flatMap((name) => safely(name, (n) => {
    const { stat } = inspectRepoFile(folder, n, { maxBytes: RULE_FILE_MAX_BYTES });
    return { path: n, mtime: stat.mtimeMs, size: stat.size };
  }));
  const key = JSON.stringify([head, stats]);
  const previous = cache.get(folder);
  if (previous?.key === key) return previous.files;
  const files = stats.flatMap((stat) => safely(stat.path, (n) => {
    const raw = readRepoFile(folder, n, { maxBytes: RULE_FILE_MAX_BYTES }).toString('utf8');
    return { ...stat, raw, text: parseRules(raw).text };
  }));
  const oldest = cache.keys().next().value;
  if (cache.size >= 20 && oldest !== undefined) cache.delete(oldest);
  cache.set(folder, { key, files });
  return files;
}

/** @param {RuleFile[]} files @param {string[]} paths */
function relevantRules(files, paths) {
  return files.filter((file) => file.path === '.reviewflow.md' || paths.some((p) => p.startsWith(file.path.slice(0, -'.reviewflow.md'.length))));
}

/** @param {RuleFile[]} rules @returns {EffectiveRules} */
function renderRules(rules) {
  const limit = rules.some((f) => f.path !== '.reviewflow.md') ? 8000 : 4000;
  let text = '';
  const files = rules.map((file) => {
    const header = `### 规则来源：${file.path}\n`;
    const block = file.text ? `${header}${file.text}` : '';
    const separator = text && block ? '\n\n' : '';
    const available = Math.max(0, limit - text.length - separator.length);
    const truncated = block.length > available;
    // 浅层优先保留，后面的深层规则先被截断；标记也计入总预算。
    const shown = truncated ? (available >= header.length + MARKER.length ? block.slice(0, available - MARKER.length) + MARKER : '') : block;
    if (shown) text += separator + shown;
    return { path: file.path, chars: file.text.length, included: Boolean(shown), truncated };
  });
  const truncated = files.some((f) => f.truncated);
  if (truncated && !text.includes(MARKER) && text.length + MARKER.length <= limit) text += MARKER;
  return { files, text, truncated, totalChars: rules.reduce((n, f) => n + f.text.length, 0) };
}

/** @param {string} folder @param {string[]} [paths] */
function captureRules(folder, paths = [], discovered = discoverRules(folder)) {
  const rules = relevantRules(discovered, paths);
  const effective = renderRules(rules);
  return { ...effective, fileHash: rules.length ? hash(JSON.stringify(rules.map((f) => [f.path, f.raw]))) : null,
    injectedHash: hash(effective.text), ruleFiles: rules };
}

/** @param {{folder:string,paths?:string[]}} input @returns {EffectiveRules} */
function getEffectiveRules({ folder, paths = [] }) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('缺少有效项目绝对路径');
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string' || path.isAbsolute(p) || p.split('/').includes('..') || p.includes('\0'))) throw new Error('规则查询路径必须是仓库内相对路径');
  const { files, text, truncated, totalChars } = captureRules(folder, paths);
  return { files, text, truncated, totalChars };
}

/** 仅根规则定义项目排除项。 @param {string} folder */
function rootIgnorePatterns(folder) {
  const root = discoverRules(folder).find((f) => f.path === '.reviewflow.md');
  return root ? parseRules(root.raw).patterns : [];
}
module.exports = { parseRules, discoverRules, relevantRules, renderRules, captureRules, getEffectiveRules, rootIgnorePatterns };

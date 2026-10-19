const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const { readRepoFile } = require('./safeRead');
const fileCache = require('./fileContentCache');
const { captureSnapshot } = require('./reviewSnapshot');
const { excludedBy } = require('./globMatch');
const { rootIgnorePatterns } = require('./effectiveRules');

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 50 * 1024 * 1024;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 500 * 1024;
const MAX_HUNK_LINES = 3000;

async function git(folder, args) {
  const { stdout } = await execFileAsync('git', ['-C', folder, ...args], {
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
}

async function getChanges(folder, options) {
  const base = options && typeof options.base === 'string' && options.base.trim() ? options.base.trim() : null;
  const commits = options && Array.isArray(options.commits) && options.commits.length
    ? options.commits.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim())
    : null;

  let inside = '';
  try {
    inside = (await git(folder, ['rev-parse', '--is-inside-work-tree'])).trim();
  } catch {
    inside = '';
  }
  if (inside !== 'true') {
    throw new Error('所选文件夹不是 Git 仓库，无法分析改动');
  }

  // 外部 ref 先解析为完整 SHA，后续 diff/show 不再接受选项或路径歧义。
  const resolve = async (ref) => {
    if (ref.startsWith('-') || /[\0\r\n]/.test(ref)) throw new Error('无效的 Git 引用');
    return (await git(folder, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
  };
  const headSha = await resolve('HEAD').catch(() => null);
  const rangeMatch = base?.match(/^(.+?)(\.{2,3})(.+)$/);
  let revisionRange;
  /** @type {string|null} */
  let baseSha = null;
  if (base) {
    try {
      if (rangeMatch) {
        const fromSha = await resolve(rangeMatch[1]);
        const toSha = await resolve(rangeMatch[3]);
        revisionRange = { fromSha, toSha, operator: rangeMatch[2] };
        baseSha = rangeMatch[2] === '...' ? (await git(folder, ['merge-base', fromSha, toSha])).trim() : fromSha;
      } else baseSha = await resolve(base);
    } catch { throw new Error(`无法生成对比：'${base}' 不是有效的分支或提交`); }
  }
  const resolvedCommits = commits ? await Promise.all(commits.map(async (ref) => {
    const sha = await resolve(ref);
    const parents = (await git(folder, ['show', '-s', '--format=%P', sha, '--'])).trim();
    return { sha, parentShas: parents ? parents.split(/\s+/) : [] };
  })) : [];
  let mode = options?.mode;
  if (mode !== undefined && !['uncommitted', 'branch', 'ref', 'commits', 'staged', 'unstaged', 'untracked'].includes(mode)) throw new Error('无效的改动模式');
  if (!mode) {
    const localBranch = base && !base.startsWith('-') ? await git(folder, ['show-ref', '--verify', '--hash', base.startsWith('refs/heads/') ? base : `refs/heads/${base}`]).then(() => true, () => false) : false;
    mode = commits ? 'commits' : base ? (localBranch ? 'branch' : 'ref') : 'uncommitted';
  }
  if ((mode === 'commits' && !commits) || (['branch', 'ref'].includes(mode) && !base) || (['uncommitted', 'staged', 'unstaged', 'untracked'].includes(mode) && (base || commits)) || (mode !== 'commits' && commits)) throw new Error('改动模式与 base/commits 不一致');

  let branch = '';
  try {
    branch = (await git(folder, headSha ? ['rev-parse', '--abbrev-ref', 'HEAD'] : ['symbolic-ref', '--short', 'HEAD'])).trim();
  } catch {
    branch = '';
  }

  let diffText = '';
  let commitRange = false;
  if (commits) {
    try {
      const selected = new Map(resolvedCommits.map((c) => [c.sha, c]));
      const parents = new Set(resolvedCommits.map((c) => c.parentShas[0]));
      const newest = resolvedCommits.filter((c) => !parents.has(c.sha));
      const chain = [];
      let current = newest.length === 1 ? newest[0] : undefined;
      while (current && !chain.includes(current)) {
        chain.push(current);
        current = selected.get(current.parentShas[0]);
      }
      commitRange = selected.size === resolvedCommits.length && chain.length === resolvedCommits.length;
      if (commitRange) {
        const oldest = chain[chain.length - 1];
        const parent = oldest.parentShas[0] || (await git(folder, ['hash-object', '-t', 'tree', '/dev/null'])).trim();
        baseSha = parent;
        diffText = await git(folder, ['diff', parent, chain[0].sha, '--unified=3', '--no-color', '--']);
      } else {
        const parts = await Promise.all(resolvedCommits.map(({ sha }) =>
          git(folder, ['show', '--unified=3', '--no-color', '--format=', sha, '--'])));
        diffText = parts.join('\n');
      }
    } catch {
      throw new Error('无法生成提交对比：包含无效的 commit');
    }
  } else if (base) {
    try {
      diffText = await git(folder, ['diff', baseSha, ...(revisionRange ? [revisionRange.toSha] : []), '--unified=3', '--no-color', '--']);
    } catch {
      throw new Error(`无法生成对比：'${base}' 不是有效的分支或提交`);
    }
  } else if (mode !== 'untracked') {
    let hasHead = true;
    try {
      await git(folder, ['rev-parse', '--verify', 'HEAD']);
    } catch {
      hasHead = false;
    }
    try {
      diffText = await git(
        folder,
        mode === 'staged' ? ['diff', '--cached', '--unified=3', '--no-color', '--'] : mode === 'unstaged' ? ['diff', '--unified=3', '--no-color', '--'] : hasHead
          ? ['diff', 'HEAD', '--unified=3', '--no-color']
          : ['diff', '--cached', '--unified=3', '--no-color']
      );
    } catch (err) {
      // 无 HEAD 的场景已由 hasHead 分支覆盖，走到这里的失败都是真错误，不能静默当成「没有改动」
      const detail = String((err && err.stderr) || (err && err.message) || '').trim();
      throw new Error(`读取改动失败：${detail.slice(0, 200) || 'git diff 执行失败'}`);
    }
  }

  const files = parseDiff(diffText);
  const skippedUntracked = [];

  if (mode === 'uncommitted' || mode === 'untracked') {
    let statusOut = '';
    try {
      statusOut = await git(folder, ['status', '--porcelain', '-z', '--untracked-files=all']);
    } catch {
      statusOut = '';
    }
    for (const line of statusOut.split('\0')) {
      if (!line.startsWith('??')) continue;
      const rel = line.slice(3);
      if (!rel || files.some((f) => f.path === rel)) continue;
      const untracked = buildUntrackedFile(folder, rel, skippedUntracked);
      if (untracked) files.push(untracked);
    }
  }

  const limited = files.slice(0, MAX_FILES);
  const patterns = [...await require('./settings').getExcludePatterns(), ...rootIgnorePatterns(folder)];
  for (const file of limited) {
    const pattern = excludedBy(file.path, patterns);
    if (pattern) { file.excluded = true; file.excludedBy = pattern; }
    try {
      file.classes = extractClasses(folder, file);
    } catch {
      file.classes = [];
    }
    delete file._content;
  }

  const semantics = commits ? (commitRange ? 'commit-range' : 'concatenated-show') : revisionRange ? 'commit-range' : base ? 'base-to-worktree'
    : mode === 'staged' ? 'head-to-index' : mode === 'unstaged' ? 'index-to-worktree' : mode === 'untracked' ? 'untracked-only' : 'head-to-worktree';
  const snapshot = captureSnapshot(folder, limited, { mode, requestedBase: base, branch: branch || null, headSha, baseSha,
    commits: resolvedCommits, semantics, ...(revisionRange ? { revisionRange } : {}), ...(commits && !commitRange ? { nonContiguous: true } : {}) });
  return { branch, base, commits: commits || null, files: limited.map((f, i) => ({ ...f, diffFingerprint: snapshot.files[i].diffFingerprint })),
    snapshotId: snapshot.snapshotId, source: snapshot.source, diffFingerprint: snapshot.diffFingerprint,
    limits: { maxFiles: MAX_FILES, totalFiles: files.length, omittedFiles: files.slice(MAX_FILES, MAX_FILES + 50).map((f) => f.path),
      truncatedFiles: limited.filter((f) => f.truncated).map((f) => ({ path: f.path, shownLines: f.hunks.reduce((n, h) => n + h.lines.length, 0) })), skippedUntracked } };
}

async function getCommits(folder, limit = 50) {
  const out = await git(folder, [
    'log', `--max-count=${limit}`, '--format=%H%x1f%h%x1f%s%x1f%cr%x1f%an',
  ]);
  return out
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const [sha, short, subject, date, author] = line.split('\x1f');
      return { sha, short, subject, date, author };
    });
}

async function getBranches(folder) {
  let current = '';
  try {
    current = (await git(folder, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch {
    current = '';
  }
  if (!current) current = 'HEAD';

  let out = '';
  try {
    out = await git(folder, ['branch', '--format=%(refname:short)']);
  } catch {
    out = '';
  }

  const seen = new Set();
  const branches = [];
  if (current !== 'HEAD') {
    seen.add(current);
    branches.push(current);
  }
  const rest = out
    .split('\n')
    .map((b) => b.trim())
    .filter((b) => b && !b.startsWith('(') && b !== 'HEAD' && !seen.has(b))
    .sort();
  for (const b of rest) {
    seen.add(b);
    branches.push(b);
    if (branches.length >= 50) break;
  }
  return { current, branches };
}

/** @param {string} folder @param {string} rel @param {Array<{path:string,reason:'too-large'|'binary'|'unreadable'}>} skipped */
function buildUntrackedFile(folder, rel, skipped) {
  let buf;
  try {
    buf = readRepoFile(folder, rel, { maxBytes: MAX_FILE_BYTES });
  } catch (error) {
    skipped.push({ path: rel, reason: error.code === 'ERR_REPO_FILE_TOO_LARGE' ? 'too-large' : 'unreadable' });
    return null;
  }
  if (buf.includes(0)) { skipped.push({ path: rel, reason: 'binary' }); return null; }
  const content = buf.toString('utf8');
  const textLines = content.split('\n');
  if (textLines.length && textLines[textLines.length - 1] === '') textLines.pop();
  const hunks =
    textLines.length === 0
      ? []
      : [
          {
            header: `@@ -0,0 +1,${textLines.length} @@`,
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: textLines.length,
             lines: textLines.slice(0, MAX_HUNK_LINES).map((c, i) => ({
              type: 'add',
              content: c,
              oldLine: null,
              newLine: i + 1,
            })),
          },
        ];
  return { path: rel, status: 'added', hunks, classes: [], _content: content, resource: isResourcePath(rel), truncated: textLines.length > MAX_HUNK_LINES };
}

function stripPrefix(p) {
  return p.replace(/^[ab]\//, '');
}

/**
 * @typedef {object} DiffLine
 * @property {'add' | 'del' | 'context'} type
 * @property {string} content
 * @property {number | null} oldLine
 * @property {number | null} newLine
 */

/**
 * @typedef {object} DiffHunk
 * @property {string} header
 * @property {number} oldStart
 * @property {number} oldLines
 * @property {number} newStart
 * @property {number} newLines
 * @property {DiffLine[]} lines
 */

/**
 * @typedef {object} DiffFile
 * @property {string} path
 * @property {string} [oldPath]
 * @property {string} status
 * @property {DiffHunk[]} hunks
 * @property {string[]} classes
 * @property {boolean} [resource]
 * @property {boolean} [excluded]
 * @property {string} [excludedBy]
 * @property {boolean} [truncated]
 * @property {string} [diffFingerprint]
 */

// 资源文件：图片/字体/媒体/资源目录等，不参与 AI 评审
const RESOURCE_RE = /\.(png|jpe?g|gif|webp|svg|ico|icns|bmp|tiff?|mp[34]|wav|aac|ttf|otf|woff2?|eot|pdf|zip|gz|tar|a|so|dylib|jar|car|lottie)$/i;
const RESOURCE_DIR_RE = /\.(xcassets|imageset|appiconset|launchimage|colorset|dataset)\//i;

function isResourcePath(p) {
  if (typeof p !== 'string' || !p) return false;
  return RESOURCE_RE.test(p) || RESOURCE_DIR_RE.test(p + '/');
}

function parseDiff(text) {
  const files = [];
  /** @type {DiffFile | null} */
  let cur = null;
  /** @type {DiffHunk | null} */
  let hunk = null;
  let oldLn = 0;
  let newLn = 0;
  let lineCount = 0;
  let truncated = false;

  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      if (cur) files.push(cur);
      cur = { path: '', status: 'modified', hunks: [], classes: [] };
      hunk = null;
      lineCount = 0;
      truncated = false;
      const m = raw.match(/^diff --git a\/(.*?) b\/(.*)$/);
      if (m) cur.path = m[2];
      continue;
    }
    if (!cur) continue;

    if (!hunk && raw.startsWith('new file mode')) {
      cur.status = 'added';
      continue;
    }
    if (!hunk && raw.startsWith('deleted file mode')) {
      cur.status = 'deleted';
      continue;
    }
    if (!hunk && raw.startsWith('rename from ')) {
      cur.status = 'renamed';
      cur.oldPath = raw.slice(12).trim();
      continue;
    }
    if (!hunk && raw.startsWith('rename to ')) {
      cur.status = 'renamed';
      cur.path = raw.slice(10).trim();
      continue;
    }
    if (!hunk && raw.startsWith('--- ')) {
      const p = raw.slice(4).trim();
      if (p !== '/dev/null') cur.path = stripPrefix(p);
      continue;
    }
    if (!hunk && raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      if (p !== '/dev/null') cur.path = stripPrefix(p);
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (m) {
        hunk = {
          header: raw,
          oldStart: parseInt(m[1], 10),
          oldLines: m[2] === undefined ? 1 : parseInt(m[2], 10),
          newStart: parseInt(m[3], 10),
          newLines: m[4] === undefined ? 1 : parseInt(m[4], 10),
          lines: [],
        };
        cur.hunks.push(hunk);
        oldLn = hunk.oldStart;
        newLn = hunk.newStart;
      }
      continue;
    }
    if (!hunk || truncated) continue;
    if (raw.startsWith('\\')) continue;

    if (lineCount >= MAX_HUNK_LINES) {
      truncated = true;
      cur.truncated = true;
      continue;
    }
    const t = raw[0];
    const c = raw.slice(1);
    if (t === '+') {
      hunk.lines.push({ type: 'add', content: c, oldLine: null, newLine: newLn++ });
      lineCount++;
    } else if (t === '-') {
      hunk.lines.push({ type: 'del', content: c, oldLine: oldLn++, newLine: null });
      lineCount++;
    } else if (t === ' ') {
      hunk.lines.push({ type: 'context', content: c, oldLine: oldLn++, newLine: newLn++ });
      lineCount++;
    }
  }
  if (cur) files.push(cur);
  for (const f of files) f.resource = isResourcePath(f.path);
  return files;
}

function reconstructOldContent(file) {
  const arr = [];
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.type !== 'add' && l.oldLine != null) arr[l.oldLine - 1] = l.content;
    }
  }
  let max = arr.length;
  while (max > 0 && arr[max - 1] === undefined) max--;
  const out = [];
  for (let i = 0; i < max; i++) out.push(arr[i] === undefined ? '' : arr[i]);
  return out.join('\n');
}

const JS_PATTERNS = [
  {
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    kind: () => 'class',
    name: (m) => m[1],
  },
  {
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    kind: () => 'function',
    name: (m) => m[1],
  },
  {
    re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>|function\b)/,
    kind: () => 'function',
    name: (m) => m[1],
  },
];

const JVM_PATTERNS = [
  {
    re: /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|partial|record|inline|annotation)\s+)*(class|interface|enum|object)\s+([A-Za-z_$][\w$]*)/,
    kind: (m) => m[1],
    name: (m) => m[2],
  },
];

const SWIFT_PATTERNS = [
  {
    re: /^\s*(?:(?:public|private|internal|fileprivate|open|final|indirect)\s+)*(class|struct|enum|extension|protocol)\s+([A-Za-z_$][\w$]*)/,
    kind: (m) => m[1],
    name: (m) => m[2],
  },
];

const OBJC_PATTERNS = [
  {
    re: /^\s*@(interface|implementation)\s+([A-Za-z_$][\w$]*)/,
    kind: (m) => '@' + m[1],
    name: (m) => m[2],
  },
];

const PY_PATTERNS = [
  { re: /^(class)\s+([A-Za-z_]\w*)/, kind: (m) => m[1], name: (m) => m[2] },
  { re: /^(def)\s+([A-Za-z_]\w*)/, kind: (m) => m[1], name: (m) => m[2] },
];

function patternsFor(ext) {
  if (['.js', '.jsx', '.ts', '.tsx'].includes(ext)) return JS_PATTERNS;
  if (['.java', '.kt', '.cs'].includes(ext)) return JVM_PATTERNS;
  if (ext === '.swift') return SWIFT_PATTERNS;
  if (ext === '.m' || ext === '.h') return OBJC_PATTERNS;
  if (ext === '.py') return PY_PATTERNS;
  return null;
}

function leadingWs(s) {
  const m = s.match(/^[ \t]*/);
  return m ? m[0].replace(/\t/g, '    ').length : 0;
}

function indentEnd(lines, startLine) {
  const indent = leadingWs(lines[startLine - 1]);
  let end = startLine;
  for (let i = startLine; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    if (leadingWs(l) <= indent) break;
    end = i + 1;
  }
  return end;
}

function braceEnd(lines, startLine) {
  let balance = 0;
  let opened = false;
  for (let i = startLine - 1; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') {
        balance++;
        opened = true;
      } else if (ch === '}') {
        balance--;
      }
    }
    if (opened && balance <= 0) return i + 1;
  }
  return opened ? lines.length : indentEnd(lines, startLine);
}

function computeEnd(lines, startLine, ext) {
  if (ext === '.py') return indentEnd(lines, startLine);
  if (ext === '.m' || ext === '.h') {
    for (let i = startLine; i < lines.length; i++) {
      if (/^\s*@end\b/.test(lines[i])) return i + 1;
    }
    return indentEnd(lines, startLine);
  }
  return braceEnd(lines, startLine);
}

function findDeclarations(filePath, lines) {
  const ext = path.extname(filePath).toLowerCase();
  const patterns = patternsFor(ext);
  if (!patterns) return [];
  const decls = [];
  for (let i = 0; i < lines.length; i++) {
    for (const p of patterns) {
      const m = lines[i].match(p.re);
      if (m) {
        decls.push({ name: p.name(m), kind: p.kind(m), startLine: i + 1, endLine: 0 });
        break;
      }
    }
  }
  for (const d of decls) d.endLine = computeEnd(lines, d.startLine, ext);
  return decls;
}

function extractClasses(folder, file) {
  let content;
  if (file._content !== undefined) {
    content = file._content;
  } else if (file.status === 'deleted') {
    content = reconstructOldContent(file);
  } else {
    content = fileCache.readFile(folder, file.path);
    if (content == null) return [];
  }
  const lines = content.split('\n');
  const decls = findDeclarations(file.path, lines);

  const changedLines = [];
  const useOld = file.status === 'deleted';
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.type !== 'add' && l.type !== 'del') continue;
      const n = useOld ? l.oldLine : l.newLine;
      if (n != null) changedLines.push(n);
    }
  }

  return decls.map((d) => ({
    name: d.name,
    kind: d.kind,
    startLine: d.startLine,
    endLine: d.endLine,
    changed: changedLines.some((n) => n >= d.startLine && n <= d.endLine),
  }));
}

module.exports = { getChanges, getBranches, getCommits, parseDiff, isResourcePath };

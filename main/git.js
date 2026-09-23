const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

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

  let branch = '';
  try {
    branch = (await git(folder, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch {
    branch = '';
  }

  let diffText = '';
  if (commits) {
    // 查看指定提交：每个 commit 各自 git show（纯 diff），拼接后统一解析
    try {
      const parts = await Promise.all(commits.map((sha) =>
        git(folder, ['show', sha, '--unified=3', '--no-color', '--format='])));
      diffText = parts.join('\n');
    } catch {
      throw new Error('无法生成提交对比：包含无效的 commit');
    }
  } else if (base) {
    try {
      diffText = await git(folder, ['diff', base, '--unified=3', '--no-color', '--']);
    } catch {
      throw new Error(`无法生成对比：'${base}' 不是有效的分支或提交`);
    }
  } else {
    let hasHead = true;
    try {
      await git(folder, ['rev-parse', '--verify', 'HEAD']);
    } catch {
      hasHead = false;
    }
    try {
      diffText = await git(
        folder,
        hasHead
          ? ['diff', 'HEAD', '--unified=3', '--no-color']
          : ['diff', '--cached', '--unified=3', '--no-color']
      );
    } catch {
      diffText = '';
    }
  }

  const files = parseDiff(diffText);

  if (!base && !commits) {
    let statusOut = '';
    try {
      statusOut = await git(folder, ['status', '--porcelain']);
    } catch {
      statusOut = '';
    }
    for (const line of statusOut.split('\n')) {
      if (!line.startsWith('??')) continue;
      let rel = line.slice(3).trim();
      if (rel.startsWith('"') && rel.endsWith('"')) rel = rel.slice(1, -1);
      if (!rel || files.some((f) => f.path === rel)) continue;
      const untracked = buildUntrackedFile(folder, rel);
      if (untracked) files.push(untracked);
    }
  }

  const limited = files.slice(0, MAX_FILES);
  for (const file of limited) {
    try {
      file.classes = extractClasses(folder, file);
    } catch {
      file.classes = [];
    }
    delete file._content;
  }

  return { branch, base, commits: commits || null, files: limited };
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

function buildUntrackedFile(folder, rel) {
  let buf;
  try {
    buf = fs.readFileSync(path.join(folder, rel));
  } catch {
    return null;
  }
  if (buf.length > MAX_FILE_BYTES || buf.includes(0)) return null;
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
            lines: textLines.map((c, i) => ({
              type: 'add',
              content: c,
              oldLine: null,
              newLine: i + 1,
            })),
          },
        ];
  return { path: rel, status: 'added', hunks, classes: [], _content: content };
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
 * @property {string} status
 * @property {DiffHunk[]} hunks
 * @property {string[]} classes
 */

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
    content = fs.readFileSync(path.join(folder, file.path), 'utf8');
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

module.exports = { getChanges, getBranches, getCommits, parseDiff };

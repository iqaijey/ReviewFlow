const { test } = require('node:test');
const assert = require('node:assert');

const { parseDiff } = require('../../main/git');

test('parseDiff 解析修改文件：路径、状态、hunk 与行号', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js',
    'index 1111111..2222222 100644',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,3 +1,3 @@',
    ' context',
    '-old',
    '+new',
    '\\ No newline at end of file',
  ].join('\n');
  const files = parseDiff(diff);
  assert.strictEqual(files.length, 1);
  const f = files[0];
  assert.strictEqual(f.path, 'src/a.js');
  assert.strictEqual(f.status, 'modified');
  assert.strictEqual(f.hunks.length, 1);
  const h = f.hunks[0];
  assert.strictEqual(h.oldStart, 1);
  assert.strictEqual(h.oldLines, 3);
  assert.strictEqual(h.newStart, 1);
  assert.strictEqual(h.newLines, 3);
  assert.deepStrictEqual(h.lines, [
    { type: 'context', content: 'context', oldLine: 1, newLine: 1 },
    { type: 'del', content: 'old', oldLine: 2, newLine: null },
    { type: 'add', content: 'new', oldLine: null, newLine: 2 },
  ]);
});

test('parseDiff 解析新增与删除文件', () => {
  const added = parseDiff([
    'diff --git a/new.js b/new.js',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.js',
    '@@ -0,0 +1,2 @@',
    '+a',
    '+b',
  ].join('\n'));
  assert.strictEqual(added[0].status, 'added');
  assert.strictEqual(added[0].path, 'new.js');
  assert.deepStrictEqual(
    added[0].hunks[0].lines.map((l) => l.newLine),
    [1, 2],
  );

  const deleted = parseDiff([
    'diff --git a/old.js b/old.js',
    'deleted file mode 100644',
    '--- a/old.js',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-gone',
  ].join('\n'));
  assert.strictEqual(deleted[0].status, 'deleted');
  assert.strictEqual(deleted[0].path, 'old.js'); // +++ /dev/null 不覆盖 --- 的路径
  assert.strictEqual(deleted[0].hunks[0].lines[0].type, 'del');
});

test('parseDiff 解析重命名文件', () => {
  const files = parseDiff([
    'diff --git a/old.txt b/new.txt',
    'similarity index 90%',
    'rename from old.txt',
    'rename to new.txt',
  ].join('\n'));
  assert.strictEqual(files[0].status, 'renamed');
  assert.strictEqual(files[0].path, 'new.txt');
});

test('parseDiff 多文件与省略行数的 hunk 头', () => {
  const files = parseDiff([
    'diff --git a/a.js b/a.js',
    '--- a/a.js',
    '+++ b/a.js',
    '@@ -5 +5 @@',
    '-x',
    '+y',
    'diff --git a/b.js b/b.js',
    '--- a/b.js',
    '+++ b/b.js',
    '@@ -1,2 +1,2 @@',
    ' c',
    '-d',
    '+e',
  ].join('\n'));
  assert.strictEqual(files.length, 2);
  assert.strictEqual(files[0].path, 'a.js');
  assert.strictEqual(files[0].hunks[0].oldLines, 1); // 省略计数时默认为 1
  assert.strictEqual(files[0].hunks[0].newLines, 1);
  assert.strictEqual(files[1].path, 'b.js');
});

test('parseDiff 空输入与非 diff 内容', () => {
  assert.deepStrictEqual(parseDiff(''), []);
  assert.deepStrictEqual(parseDiff('random text\nmore text'), []);
});

test('isResourcePath：识别图片/字体/资源目录，代码文件不误判', () => {
  const { isResourcePath } = require('../../main/git');
  for (const p of [
    'Assets/Media.xcassets/profile/x.imageset/Contents.json',
    'Assets/Media.xcassets/profile/x.imageset/bg@2x.png',
    'res/logo.PNG',
    'fonts/PingFang.woff2',
    'lib/foo.dylib',
    'doc/spec.pdf',
  ]) {
    assert.strictEqual(isResourcePath(p), true, p);
  }
  for (const p of [
    'src/a.js',
    'XCChat/Controllers/XCHomeViewController.m',
    'package.json',
    'src/config.json',
    'src/svgParser.js',
    'README.md',
  ]) {
    assert.strictEqual(isResourcePath(p), false, p);
  }
  assert.strictEqual(isResourcePath(''), false);
  assert.strictEqual(isResourcePath(null), false);
});

test('parseDiff：资源文件被标记 resource，代码文件不标记', () => {
  const diff = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,1 +1,1 @@',
    '-old',
    '+new',
    'diff --git a/Assets/Media.xcassets/x.imageset/Contents.json b/Assets/Media.xcassets/x.imageset/Contents.json',
    '--- a/Assets/Media.xcassets/x.imageset/Contents.json',
    '+++ b/Assets/Media.xcassets/x.imageset/Contents.json',
    '@@ -1,1 +1,1 @@',
    '-{}',
    '+{}',
  ].join('\n');
  const files = parseDiff(diff);
  assert.strictEqual(files.length, 2);
  assert.strictEqual(files[0].resource, false);
  assert.strictEqual(files[1].resource, true);
});

const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

let INITIAL_DIFF_ROW_BUDGET;
let CHUNK_DIFF_ROW_BUDGET;
let FILE_LIST_INCREMENTAL_THRESHOLD;
let computeFileFingerprint;
let buildChangesSearchIndex;
let matchesFileSearch;
let filterFilesWithIndex;
let computeDiffHunkOffsets;
let planHunkRenderBatch;
let estimateRequiredRowsForScroll;
let findNextUnreadFile;
let clampSplitterWidth;

before(async () => {
  const src = fs.readFileSync(path.join(__dirname, '../../renderer/lib/overviewPerf.js'), 'utf8');
  const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
  INITIAL_DIFF_ROW_BUDGET = mod.INITIAL_DIFF_ROW_BUDGET;
  CHUNK_DIFF_ROW_BUDGET = mod.CHUNK_DIFF_ROW_BUDGET;
  FILE_LIST_INCREMENTAL_THRESHOLD = mod.FILE_LIST_INCREMENTAL_THRESHOLD;
  computeFileFingerprint = mod.computeFileFingerprint;
  buildChangesSearchIndex = mod.buildChangesSearchIndex;
  matchesFileSearch = mod.matchesFileSearch;
  filterFilesWithIndex = mod.filterFilesWithIndex;
  computeDiffHunkOffsets = mod.computeDiffHunkOffsets;
  planHunkRenderBatch = mod.planHunkRenderBatch;
  estimateRequiredRowsForScroll = mod.estimateRequiredRowsForScroll;
  findNextUnreadFile = mod.findNextUnreadFile;
  clampSplitterWidth = mod.clampSplitterWidth;
});

test('buildChangesSearchIndex 与 filterFilesWithIndex 支持文件路径和 diff 正文检索', () => {
  const files = [
    {
      path: 'src/services/UserService.js',
      status: 'modified',
      hunks: [
        {
          header: '@@ -10,4 +10,5 @@',
          lines: [
            { type: 'context', content: 'const cache = new Map();' },
            { type: 'add', content: 'return fetchUserToken(id);' },
          ],
        },
      ],
    },
    {
      path: 'ios/MainViewController.m',
      status: 'modified',
      hunks: [
        {
          header: '@@ -1,3 +1,4 @@',
          lines: [
            { type: 'del', content: '[self legacySetup];' },
            { type: 'add', content: '[self configureNavigationBar];' },
          ],
        },
      ],
    },
  ];
  const index = buildChangesSearchIndex({ files });

  assert.strictEqual(filterFilesWithIndex(index, files, '').length, 2);
  assert.deepStrictEqual(
    filterFilesWithIndex(index, files, 'userservice').map((f) => f.path),
    ['src/services/UserService.js'],
  );
  assert.deepStrictEqual(
    filterFilesWithIndex(index, files, 'FETCHUSERTOKEN').map((f) => f.path),
    ['src/services/UserService.js'],
  );
  assert.deepStrictEqual(
    filterFilesWithIndex(index, files, 'configurenavigationbar').map((f) => f.path),
    ['ios/MainViewController.m'],
  );
  assert.strictEqual(matchesFileSearch(index, files[0], 'non-existent-keyword'), false);
});

test('computeDiffHunkOffsets 为跨 hunk 的改动行生成稳定 cpos 偏移', () => {
  const file = {
    path: 'src/a.js',
    status: 'modified',
    hunks: [
      {
        header: '@@ -1,3 +1,4 @@',
        lines: [
          { type: 'context', content: 'a' },
          { type: 'add', content: 'b' },
          { type: 'del', content: 'c' },
        ],
      },
      {
        header: '@@ -10,2 +11,3 @@',
        lines: [
          { type: 'add', content: 'd' },
          { type: 'context', content: 'e' },
        ],
      },
      {
        header: '@@ -20,1 +22,2 @@',
        lines: [
          { type: 'del', content: 'f' },
        ],
      },
    ],
  };

  const offsets = computeDiffHunkOffsets(file);
  assert.deepStrictEqual(offsets.hunkStartCpos, [0, 2, 3]);
  assert.strictEqual(offsets.totalClickable, 4);
  assert.strictEqual(offsets.totalLines, 6);
});

test('planHunkRenderBatch 按行预算切分 hunk 并跳过已折叠 hunk 的行数', () => {
  const makeHunk = (idx, count) => ({
    header: `@@ -${idx},1 +${idx},${count} @@`,
    lines: Array.from({ length: count }, (_, i) => ({ type: 'add', content: `line ${i}` })),
  });
  const hunks = [
    makeHunk(1, 180),
    makeHunk(2, 180),
    makeHunk(3, 180),
    makeHunk(4, 180),
  ];

  const batch1 = planHunkRenderBatch({
    hunks,
    startHunkIndex: 0,
    rowBudget: 400,
  });
  assert.strictEqual(batch1.endHunkIndex, 3);
  assert.strictEqual(batch1.renderedRows, 540);
  assert.strictEqual(batch1.hasMore, true);

  const batch2 = planHunkRenderBatch({
    hunks,
    startHunkIndex: batch1.endHunkIndex,
    rowBudget: 400,
  });
  assert.strictEqual(batch2.endHunkIndex, 4);
  assert.strictEqual(batch2.renderedRows, 180);
  assert.strictEqual(batch2.hasMore, false);

  const collapsedBatch = planHunkRenderBatch({
    hunks,
    startHunkIndex: 0,
    rowBudget: 200,
    isHunkCollapsed: (_, idx) => idx < 2,
  });
  assert.strictEqual(collapsedBatch.endHunkIndex, 4);
  assert.strictEqual(collapsedBatch.renderedRows, 360);
});

test('planHunkRenderBatch 强制覆盖指定目标 hunk（如 diff:jump 定位）', () => {
  const hunks = Array.from({ length: 10 }, (_, idx) => ({
    header: `@@ -${idx} +${idx} @@`,
    lines: Array.from({ length: 150 }, () => ({ type: 'context', content: 'x' })),
  }));
  const batch = planHunkRenderBatch({
    hunks,
    startHunkIndex: 0,
    rowBudget: 300,
    minTargetHunkIndex: 7,
  });
  assert.strictEqual(batch.endHunkIndex, 8);
  assert.strictEqual(batch.hasMore, true);
});

test('estimateRequiredRowsForScroll 为历史滚动恢复计算充足行预算', () => {
  assert.strictEqual(estimateRequiredRowsForScroll(0, 600), INITIAL_DIFF_ROW_BUDGET);
  const rowsForDeepScroll = estimateRequiredRowsForScroll(24_000, 800, 20);
  assert.ok(rowsForDeepScroll > 1200);
});

test('findNextUnreadFile 支持环形查找未读文件与指纹比对', () => {
  const f1 = { path: 'a.js', status: 'modified', diffFingerprint: 'fp-1', hunks: [] };
  const f2 = { path: 'b.js', status: 'modified', diffFingerprint: 'fp-2', hunks: [] };
  const f3 = { path: 'c.js', status: 'added', diffFingerprint: 'fp-3', hunks: [] };
  const files = [f1, f2, f3];

  const markers = {
    'a.js': 'fp-1',
    'b.js': 'fp-old',
    'c.js': 'fp-3',
  };
  assert.strictEqual(findNextUnreadFile(files, f1, markers), f2);
  assert.strictEqual(findNextUnreadFile(files, f2, markers), f2);

  const allRead = {
    'a.js': computeFileFingerprint(f1),
    'b.js': computeFileFingerprint(f2),
    'c.js': computeFileFingerprint(f3),
  };
  assert.strictEqual(findNextUnreadFile(files, f1, allRead), null);
});

test('clampSplitterWidth 限制文件列表最小与最大宽度', () => {
  const r1 = clampSplitterWidth(100, 1000);
  assert.strictEqual(r1.width, 160);
  assert.strictEqual(r1.min, 160);
  assert.strictEqual(r1.max, 760);

  const r2 = clampSplitterWidth(900, 1000);
  assert.strictEqual(r2.width, 760);

  const r3 = clampSplitterWidth(320, 1000);
  assert.strictEqual(r3.width, 320);

  assert.strictEqual(CHUNK_DIFF_ROW_BUDGET, 400);
  assert.strictEqual(FILE_LIST_INCREMENTAL_THRESHOLD, 300);
});

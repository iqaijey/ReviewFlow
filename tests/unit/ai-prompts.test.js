const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewflow-prompts-'));

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const prompts = require('../../main/ai/prompts');

function makeFile(filePath, lines, extra = {}) {
  return {
    path: filePath,
    status: 'modified',
    hunks: [
      {
        header: '@@ -1,1 +1,1 @@',
        lines: [
          { type: 'del', content: 'old line' },
          { type: 'add', content: 'new line' },
          { type: 'context', content: 'ctx' },
        ],
      },
    ],
    ...extra,
  };
}

// ---------- splitIntoBatches ----------

test('splitIntoBatches 空文件列表返回空批', () => {
  const { batches, reviewed } = prompts.splitIntoBatches(tmpDir, []);
  assert.deepStrictEqual(batches, []);
  assert.strictEqual(reviewed, 0);
});

test('splitIntoBatches 小文件合并进同一批', () => {
  const files = [makeFile('a.js'), makeFile('b.js'), makeFile('c.js')];
  const { batches, reviewed } = prompts.splitIntoBatches(tmpDir, files);
  assert.strictEqual(batches.length, 1);
  assert.strictEqual(batches[0].length, 3);
  assert.strictEqual(reviewed, 3);
  assert.ok(batches[0][0].includes('文件: a.js (修改)'));
});

test('splitIntoBatches 按累计长度分批，文件不拆半', () => {
  // 每个文件约 2600 字符，10000 限制下每批最多 3 个
  const bigLine = 'x'.repeat(2500);
  const files = Array.from({ length: 5 }, (_, i) =>
    makeFile(`f${i}.js`, null, {
      hunks: [{ header: '@@ h @@', lines: [{ type: 'add', content: bigLine }] }],
    }),
  );
  const { batches, reviewed } = prompts.splitIntoBatches(tmpDir, files);
  assert.strictEqual(reviewed, 5);
  assert.strictEqual(batches.length, 2);
  assert.strictEqual(batches[0].length, 3);
  assert.strictEqual(batches[1].length, 2);
  for (const batch of batches) {
    assert.ok(batch.join('\n').length <= 10000 + 1000); // 单批不超上限太多（批内累加受控）
  }
});

test('splitIntoBatches 单文件超限单独成批并截断', () => {
  const huge = makeFile('huge.js', null, {
    hunks: [{ header: '@@ h @@', lines: [{ type: 'add', content: 'y'.repeat(20000) }] }],
  });
  const small = makeFile('small.js');
  const { batches, reviewed } = prompts.splitIntoBatches(tmpDir, [huge, small]);
  assert.strictEqual(reviewed, 2);
  // 超限文件单独一批且被截断标记
  const hugeBatch = batches.find((b) => b.length === 1 && b[0].includes('huge.js'));
  assert.ok(hugeBatch);
  assert.ok(hugeBatch[0].includes('(diff 过长已截断)'));
  assert.ok(hugeBatch[0].length <= 10000 + 30);
});

test('splitIntoBatches 最多 6 批，溢出文件不计入 reviewed', () => {
  const bigLine = 'z'.repeat(2500);
  const files = Array.from({ length: 30 }, (_, i) =>
    makeFile(`f${i}.js`, null, {
      hunks: [{ header: '@@ h @@', lines: [{ type: 'add', content: bigLine }] }],
    }),
  );
  const { batches, reviewed } = prompts.splitIntoBatches(tmpDir, files);
  assert.ok(batches.length <= 6);
  assert.ok(reviewed < files.length);
});

// ---------- buildContext ----------

test('buildContext 无 folder / 文件已删除 / 无改动类时返回空串', () => {
  const file = makeFile('nope.js');
  assert.strictEqual(prompts.buildContext('', file), '');
  assert.strictEqual(prompts.buildContext(tmpDir, null), '');
  assert.strictEqual(prompts.buildContext(tmpDir, { path: 'a.js', status: 'deleted' }), '');
  assert.strictEqual(prompts.buildContext(tmpDir, makeFile('a.js')), '');
});

test('buildContext 提取改动类的完整定义', () => {
  const src = ['line1', 'class Foo {', '  bar() {}', '}', 'line5'].join('\n');
  fs.writeFileSync(path.join(tmpDir, 'ctx.js'), src);
  const file = makeFile('ctx.js', null, {
    classes: [{ name: 'Foo', changed: true, startLine: 2, endLine: 4 }],
  });
  const out = prompts.buildContext(tmpDir, file);
  assert.ok(out.includes('### Foo（ctx.js:2-4）'));
  assert.ok(out.includes('class Foo {'));
  assert.ok(out.includes('}'));
  assert.ok(!out.includes('line1'));
  fs.unlinkSync(path.join(tmpDir, 'ctx.js'));
});

test('buildContext 文件读取失败返回空串', () => {
  const file = makeFile('missing.js', null, {
    classes: [{ name: 'X', changed: true, startLine: 1, endLine: 2 }],
  });
  assert.strictEqual(prompts.buildContext(tmpDir, file), '');
});

test('buildContext 忽略未改动或行号非法的类', () => {
  fs.writeFileSync(path.join(tmpDir, 'ctx2.js'), 'a\nb\nc');
  const file = makeFile('ctx2.js', null, {
    classes: [
      { name: 'NoChange', changed: false, startLine: 1, endLine: 3 },
      { name: 'BadRange', changed: true, startLine: 0, endLine: 0 },
      null,
    ],
  });
  assert.strictEqual(prompts.buildContext(tmpDir, file), '');
  fs.unlinkSync(path.join(tmpDir, 'ctx2.js'));
});

test('buildContext 超长定义块截断到 200 行', () => {
  const src = Array.from({ length: 300 }, (_, i) => `l${i + 1}`).join('\n');
  fs.writeFileSync(path.join(tmpDir, 'long.js'), src);
  const file = makeFile('long.js', null, {
    classes: [{ name: 'Big', changed: true, startLine: 1, endLine: 300 }],
  });
  const out = prompts.buildContext(tmpDir, file);
  assert.ok(out.includes('（定义过长已截断）'));
  assert.ok(!out.includes('l201'));
  fs.unlinkSync(path.join(tmpDir, 'long.js'));
});

// ---------- overviewSectionsText / buildOverviewSystem ----------

test('overviewSectionsText 默认 9 个固定维度', () => {
  const text = prompts.overviewSectionsText({});
  for (const dim of ['改动概述', '安全性', '结构问题', '影响面', '逻辑严谨性', '臃肿与冗余', '可扩展性', '可复用性', '总结与建议']) {
    assert.ok(text.includes(`## ${dim}`), dim);
  }
  assert.ok(!text.includes('需求符合度'));
});

test('overviewSectionsText cfg 为空或 customDimensions 非字符串时不崩', () => {
  assert.ok(prompts.overviewSectionsText(null).includes('改动概述'));
  assert.ok(prompts.overviewSectionsText({ customDimensions: 123 }).includes('改动概述'));
});

test('overviewSectionsText 追加自定义维度（去空白、最多 8 个）', () => {
  const cfg = { customDimensions: ' 性能 \n\n代码风格\n' + Array.from({ length: 8 }, (_, i) => `D${i}`).join('\n') };
  const text = prompts.overviewSectionsText(cfg);
  assert.ok(text.includes('## 性能'));
  assert.ok(text.includes('## 代码风格'));
  // 前两个 + 8 个中的前 6 个（总共截断到 8 个自定义维度）
  assert.ok(text.includes('## D5'));
  assert.ok(!text.includes('## D6'));
  // 自定义维度插在「可复用性」与「总结与建议」之间
  assert.ok(text.indexOf('## 可复用性') < text.indexOf('## 性能'));
  assert.ok(text.indexOf('## 性能') < text.indexOf('## 总结与建议'));
});

test('overviewSectionsText hasPlan 追加需求符合度一节', () => {
  const text = prompts.overviewSectionsText({}, true);
  assert.ok(text.includes('## 需求符合度'));
  assert.ok(text.includes('对照需求方案/PRD'));
  assert.ok(text.indexOf('## 需求符合度') < text.indexOf('## 总结与建议'));
});

test('buildOverviewSystem 包含专家人设与分节要求', () => {
  const sys = prompts.buildOverviewSystem({ customDimensions: '性能' }, true);
  assert.ok(sys.startsWith('你是一位资深代码评审专家'));
  assert.ok(sys.includes('markdown'));
  assert.ok(sys.includes('## 性能'));
  assert.ok(sys.includes('## 需求符合度'));
});

// ---------- 其他导出的小函数 ----------

test('withCustomPrompt 追加额外评审要求', () => {
  assert.strictEqual(prompts.withCustomPrompt('SYS', {}), 'SYS');
  assert.strictEqual(prompts.withCustomPrompt('SYS', { customPrompt: '  关注并发  ' }), 'SYS\n额外评审要求（必须遵守）：关注并发');
  assert.strictEqual(prompts.withCustomPrompt('SYS', null), 'SYS');
});

test('applyPromptOverride 非空覆盖替代 cfg.customPrompt 且不改原对象', () => {
  const cfg = { customPrompt: 'old', other: 1 };
  const out = prompts.applyPromptOverride(cfg, '  new  ');
  assert.strictEqual(out.customPrompt, 'new');
  assert.strictEqual(out.other, 1);
  assert.strictEqual(cfg.customPrompt, 'old');
  assert.strictEqual(prompts.applyPromptOverride(cfg, '   '), cfg);
  assert.strictEqual(prompts.applyPromptOverride(cfg, null), cfg);
});

test('buildExplainContext 单行 hunk 标记被询问行', () => {
  const hunk = {
    header: '@@ -1,2 +1,2 @@',
    lines: [
      { type: 'del', content: 'a', oldLine: 1 },
      { type: 'add', content: 'b', newLine: 1 },
    ],
  };
  const { multi, context } = prompts.buildExplainContext({ filePath: 'f.js', hunk, line: hunk.lines[1] });
  assert.strictEqual(multi, false);
  assert.ok(context.includes('文件: f.js'));
  assert.ok(context.includes('>+1 b'));
  assert.ok(context.includes(' -1 a'));
  assert.throws(() => prompts.buildExplainContext({ filePath: 'f.js' }), /缺少要解释的改动行/);
});

test('buildExplainContext 多段框选', () => {
  const line = { type: 'add', content: 'x', newLine: 5 };
  const segments = [
    { filePath: 'a.js', hunk: { header: '@@ h1 @@', lines: [line] }, lines: [line] },
    { filePath: 'b.js', hunk: { header: '@@ h2 @@', lines: [] }, lines: [] },
  ];
  const { multi, context } = prompts.buildExplainContext({ filePath: 'a.js', segments });
  assert.strictEqual(multi, true);
  assert.ok(context.includes('文件: a.js'));
  assert.ok(context.includes('文件: b.js'));
  assert.ok(context.includes('>+5 x'));
});

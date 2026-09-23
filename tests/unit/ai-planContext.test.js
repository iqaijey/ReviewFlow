const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewflow-planctx-'));

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const planContext = require('../../main/ai/planContext');

const RULES_FILE = path.join(tmpDir, '.reviewflow.md');

function cleanup() {
  try { fs.unlinkSync(RULES_FILE); } catch { /* 不存在 */ }
}

// ---------- normalizePlanContext ----------

test('normalizePlanContext 非字符串或空白串返回空串', () => {
  assert.strictEqual(planContext.normalizePlanContext(null), '');
  assert.strictEqual(planContext.normalizePlanContext(undefined), '');
  assert.strictEqual(planContext.normalizePlanContext(123), '');
  assert.strictEqual(planContext.normalizePlanContext(''), '');
  assert.strictEqual(planContext.normalizePlanContext('   \n  '), '');
});

test('normalizePlanContext 去掉首尾空白', () => {
  assert.strictEqual(planContext.normalizePlanContext('  需求：做一个评审工具 \n'), '需求：做一个评审工具');
});

// ---------- loadProjectRules ----------

test('loadProjectRules 无 folder 或文件不存在返回空串', () => {
  cleanup();
  assert.strictEqual(planContext.loadProjectRules(''), '');
  assert.strictEqual(planContext.loadProjectRules(null), '');
  assert.strictEqual(planContext.loadProjectRules(tmpDir), '');
});

test('loadProjectRules 读取并 trim 规则内容', () => {
  fs.writeFileSync(RULES_FILE, '  规则一：先查安全性\n');
  assert.strictEqual(planContext.loadProjectRules(tmpDir), '规则一：先查安全性');
  cleanup();
});

test('loadProjectRules 按 mtime 缓存：mtime 不变时不重读文件', () => {
  fs.writeFileSync(RULES_FILE, '第一版规则');
  assert.strictEqual(planContext.loadProjectRules(tmpDir), '第一版规则');

  // 拦截 readFileSync 验证缓存命中（mtime 未变，不应发生读取）
  const origRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (...args) { reads += 1; return origRead.apply(this, args); };
  try {
    assert.strictEqual(planContext.loadProjectRules(tmpDir), '第一版规则');
    assert.strictEqual(reads, 0);
  } finally {
    fs.readFileSync = origRead;
  }

  // mtime 变化后重读新内容
  const stat = fs.statSync(RULES_FILE);
  fs.writeFileSync(RULES_FILE, '第二版规则');
  fs.utimesSync(RULES_FILE, stat.atimeMs / 1000, (stat.mtimeMs + 5000) / 1000);
  assert.strictEqual(planContext.loadProjectRules(tmpDir), '第二版规则');
  cleanup();
});

test('loadProjectRules 超过 4000 字截断并追加说明', () => {
  const long = '规'.repeat(5000);
  fs.writeFileSync(RULES_FILE, long);
  const out = planContext.loadProjectRules(tmpDir);
  assert.ok(out.startsWith('规'.repeat(100)));
  assert.strictEqual(out.length, 4000 + '\n（内容过长已截断）'.length);
  assert.ok(out.endsWith('（内容过长已截断）'));
  cleanup();
});

// ---------- withProjectRules ----------

test('withProjectRules 无规则文件时原样返回', () => {
  cleanup();
  assert.strictEqual(planContext.withProjectRules('SYS', tmpDir), 'SYS');
});

test('withProjectRules 有规则时追加到 system 末尾', () => {
  fs.writeFileSync(RULES_FILE, '项目特有规则');
  const out = planContext.withProjectRules('SYS', tmpDir);
  assert.strictEqual(out, 'SYS\n\n## 项目评审规范（.reviewflow.md）\n项目特有规则');
  cleanup();
});

// ---------- imageMime ----------

test('imageMime 按扩展名推断，未知类型回退 png', () => {
  assert.strictEqual(planContext.imageMime('a.png'), 'image/png');
  assert.strictEqual(planContext.imageMime('a.JPG'), 'image/jpeg');
  assert.strictEqual(planContext.imageMime('a.jpeg'), 'image/jpeg');
  assert.strictEqual(planContext.imageMime('a.gif'), 'image/gif');
  assert.strictEqual(planContext.imageMime('a.webp'), 'image/webp');
  assert.strictEqual(planContext.imageMime('a.bmp'), 'image/png');
  assert.strictEqual(planContext.imageMime(''), 'image/png');
  assert.strictEqual(planContext.imageMime(null), 'image/png');
});

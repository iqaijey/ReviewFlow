const { test } = require('node:test');
const assert = require('node:assert/strict');
const f = require('../../main/findings');

const report = (lines) => `## 问题清单\n${lines}`;
test('同一次运行的近似问题不能互相模糊合并', () => {
  const result = f.reconcile({ stored: [], reviewId: 'same-run', markdown: report(
    '- [高][正确性] @"a.js":new:10 | 用户账户列表未校验空数组直接访问首项导致崩溃\n' +
    '- [高][正确性] @"a.js":new:18 | 用户账户列表未校验空数组直接访问首项导致异常') });
  assert.equal(result.findings.length, 2);
});
const issue = (text = '空账户列表仍访问首项，会导致崩溃', line = 42) =>
  f.parseIssueList(report(`- [ ] [高][正确性] @"src/账户.js":new:${line} | ${text}`)).findings[0];

test('解析标签、中文路径、描述中的竖线及复选框，不把勾选当修复', () => {
  const result = f.parseIssueList(report('1. [x] 【high】【正确性】 @"src/账户.js":old:42-47 | 空数组 | 未检查'));
  assert.equal(result.findings[0].severity, '高');
  assert.equal(result.findings[0].status, 'pending');
  assert.equal(result.findings[0].location.path, 'src/账户.js');
  assert.equal(result.findings[0].text, '空数组 | 未检查');
});

test('所有问题节、子标题和 fenced code 的边界', () => {
  const result = f.parseIssueList('```md\n## 问题清单\n- 假问题\n```\n## 问题清单\n### 子节\n+ 真问题\n## 其他\n- 忽略\n## 问题清单\n* 另一问题');
  assert.deepEqual(result.findings.map((x) => x.text), ['真问题', '另一问题']);
  assert.equal(f.parseIssueList('没有节').parsed, false);
  assert.equal(f.parseIssueList(report('不是列表')).parsed, false);
  assert.equal(f.parseIssueList(report('无')).parsed, true);
});

test('已知文件 fallback 和非法行范围降级', () => {
  const files = [{ path: 'src/账户.js', hunks: [] }];
  for (const token of ['src/账户.js:12-15', 'src/账户.js#L12-L15', 'src/账户.js 第 12 行']) {
    assert.equal(f.parseIssueList(report(`- ${token} 未校验`), files).findings[0].location.startLine, 12);
  }
  for (const range of ['0', '9007199254740992', '12-3']) {
    assert.equal(f.parseIssueList(report(`- @"a.js":new:${range} | 未校验`)).findings[0].location.startLine, null);
  }
});

test('规范化保留数字标识符与否定词，指纹忽略严重性和行号', () => {
  assert.equal(f.normalizeDescription(' **ＦＯＯ**  不检查 12 '), 'foo 不检查 12');
  assert.equal(f.normalizeDescription('account_id 不等于 accountid'), 'account_id 不等于 accountid');
  assert.notEqual(f.fingerprint(issue('允许空数组')), f.fingerprint(issue('不允许空数组')));
  assert.equal(f.fingerprint(issue(undefined, 42)), f.fingerprint(issue(undefined, 60)));
});

test('四种复核结论、未知 ID 与 legacy 唯一精确匹配', () => {
  const item = { ...issue(), id: 'a' };
  for (const [verdict, status] of Object.entries({ 已修复: 'fixed', 仍存在: 'pending', 部分修复: 'partial', 已过时: 'outdated' })) {
    const result = f.reconcile({ stored: [item], markdown: `- [id=a] => ${verdict}（说明）`, captured: [{ id: 'a', updatedAt: item.updatedAt }], reviewId: 'r', now: 10 });
    assert.equal(result.checklist[0].status, status);
  }
  assert.equal(f.parseVerificationLines('- [id=unknown] => 已修复', [item]).length, 0);
  assert.equal(f.parseVerificationLines(`- ${item.text} => 已修复`, [item]).length, 1);
  assert.equal(f.parseVerificationLines(`- ${item.text} => 已修复`, [item, { ...item, id: 'b' }]).length, 0);
  assert.equal(f.parseVerificationLines('- 空账户 => 已修复', [item]).length, 0);
});

test('用户编辑、复现、矛盾结论优先于关闭', () => {
  const item = { ...issue(), id: 'a', updatedAt: 5 };
  const base = { stored: [item], captured: [{ id: 'a', updatedAt: 5 }], reviewId: 'r', now: 10 };
  let result = f.reconcile({ ...base, markdown: report('- [高][正确性] @"src/账户.js":new:42 | ' + item.text) + '\n## 核对\n- [id=a] => 已修复' });
  assert.equal(result.checklist[0].status, 'pending');
  assert.equal(result.verificationResults[0].applied, false);
  result = f.reconcile({ ...base, captured: [{ id: 'a', updatedAt: 4 }], markdown: '- [id=a] => 已修复' });
  assert.equal(result.checklist[0].status, 'pending');
  assert.match(result.verificationResults[0].conflict, /用户/);
  result = f.reconcile({ ...base, markdown: '- [id=a] => 已修复\n- [id=a] => 仍存在' });
  assert.equal(result.checklist[0].status, 'pending');
});

test('固定/过时复现重新打开，不处理复现不自动打开，未提及保持状态', () => {
  for (const status of ['fixed', 'outdated', 'wontfix']) {
    const stored = [{ ...issue(), id: 'a', status }];
    const result = f.reconcile({ stored, markdown: report('- [高][正确性] @"src/账户.js":new:49 | ' + stored[0].text), reviewId: 'r' });
    assert.equal(result.checklist[0].status, status === 'wontfix' ? 'wontfix' : 'pending');
    assert.equal(f.reconcile({ stored, markdown: '无可解析内容', reviewId: 'r' }).checklist[0].status, status);
  }
});

test('模糊匹配要求路径类别、长度、位置和领先差距', () => {
  const a = issue('用户账户列表未校验空数组直接访问首项导致崩溃');
  const b = issue('用户账户列表未校验空数组直接访问首项导致异常');
  assert.ok(f.dice(f.normalizeDescription(a.text), f.normalizeDescription(b.text)) >= 0.9);
  assert.equal(f.matchFinding(b, [a]), a);
  assert.equal(f.matchFinding({ ...b, location: { ...b.location, startLine: 100, endLine: 100 } }, [a]), null);
  assert.equal(f.matchFinding(b, [a, { ...a, id: 'second' }]), null);
  assert.equal(f.matchFinding({ ...b, category: '其他' }, [a]), null);
});

test('从 diff 提取三行锚点，同文本不同位置保持独立', () => {
  const files = [{ path: 'src/账户.js', hunks: [{ lines: Array.from({ length: 12 }, (_, i) => ({ newLine: i + 40, content: `line${i}`, type: 'add' })) }] }];
  const parsed = f.parseIssueList(report('- [高][正确性] @"src/账户.js":new:42-44 | 同一问题\n- [高][正确性] @"src/账户.js":new:48 | 同一问题'), files);
  assert.deepEqual(parsed.findings[0].location.anchor.target, ['line2', 'line3', 'line4']);
  assert.equal(f.dedupeFindings(parsed.findings).length, 2);
  assert.equal(f.dedupeFindings([parsed.findings[0], parsed.findings[0]]).length, 1);
});

test('容量先淘汰最旧终态，活动溢出只留历史并返回警告', () => {
  const stored = Array.from({ length: 200 }, (_, i) => ({ ...issue(`问题${i}`), id: `a${i}`, createdAt: i }));
  const result = f.reconcile({ stored, markdown: report('- 新发现'), reviewId: 'r' });
  assert.equal(result.checklist.length, 200);
  assert.equal(result.findings.length, 201);
  assert.equal(result.persistenceWarnings.length, 1);
  stored[20].status = 'fixed';
  const terminal = f.reconcile({ stored, markdown: report('- 新发现'), reviewId: 'r' });
  assert.equal(terminal.checklist.some((x) => x.id === 'a20'), false);
  assert.equal(terminal.persistenceWarnings.length, 0);
});

test('显式 rename 的旧侧路径仍能从捕获 diff 提取锚点', () => {
  const files = [{ path: 'src/new.js', oldPath: 'src/old.js', status: 'renamed', hunks: [{ lines: [{ oldLine: 4, type: 'del', content: 'oldTarget' }] }] }];
  const result = f.parseIssueList(report('- [中][正确性] @"src/old.js":old:4 | 删除校验'), files);
  assert.deepEqual(result.findings[0].location.anchor.target, ['oldTarget']);
});

test('短描述、未知路径、低于阈值和歧义位置不做模糊匹配', () => {
  const a = issue('短问题');
  assert.equal(f.matchFinding(issue('短故障'), [a]), null);
  const long = issue('用户账户列表未校验空数组直接访问首项导致崩溃');
  assert.equal(f.matchFinding({ ...issue('用户账户列表未校验空数组直接访问首项导致异常'), location: null }, [long]), null);
  assert.equal(f.matchFinding(issue('读取数据库后在不相关路径漏掉事务回滚'), [long]), null);
});

const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

let renderMarkdown;
let renderMarkdownPage;
let extractH2Titles;

before(async () => {
  // renderer 是原生 ESM，但 package.json 未声明 type:module，
  // 读取源码经 data: URL 动态 import，测试真实文件内容
  const src = fs.readFileSync(path.join(__dirname, '../../renderer/markdown.js'), 'utf8');
  const mod = await import('data:text/javascript;charset=utf-8,' + encodeURIComponent(src));
  renderMarkdown = mod.renderMarkdown;
  renderMarkdownPage = mod.renderMarkdownPage;
  extractH2Titles = mod.extractH2Titles;
});

test('renderMarkdown 渲染标题', () => {
  assert.strictEqual(renderMarkdown('## 二级'), '<h2>二级</h2>');
  assert.strictEqual(renderMarkdown('### 三级'), '<h3>三级</h3>');
});

test('renderMarkdown 渲染代码块且不解析内部标记', () => {
  const html = renderMarkdown('```\nconst a = 1 ** 2;\n```');
  assert.strictEqual(html, '<pre><code>const a = 1 ** 2;</code></pre>');
});

test('renderMarkdown 渲染无序与有序列表', () => {
  assert.strictEqual(
    renderMarkdown('- 甲\n- 乙'),
    '<ul><li>甲</li><li>乙</li></ul>',
  );
  assert.strictEqual(
    renderMarkdown('1. 第一\n2. 第二'),
    '<ol><li>第一</li><li>第二</li></ol>',
  );
});

test('renderMarkdown 渲染引用块', () => {
  assert.strictEqual(
    renderMarkdown('> 引用一\n> 引用二'),
    '<blockquote>引用一<br>引用二</blockquote>',
  );
});

test('renderMarkdown 行内代码与加粗', () => {
  assert.strictEqual(
    renderMarkdown('使用 `foo()` 与 **重点**'),
    '<p>使用 <code>foo()</code> 与 <strong>重点</strong></p>',
  );
});

test('renderMarkdown 转义 HTML 防止注入', () => {
  const html = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('renderMarkdown 段落合并连续普通行，空行分段', () => {
  assert.strictEqual(renderMarkdown('第一行\n第二行'), '<p>第一行<br>第二行</p>');
  assert.strictEqual(
    renderMarkdown('段落一\n\n段落二'),
    '<p>段落一</p>\n<p>段落二</p>',
  );
});

test('renderMarkdown 空输入与 null', () => {
  assert.strictEqual(renderMarkdown(''), '');
  assert.strictEqual(renderMarkdown(null), '');
  assert.strictEqual(renderMarkdown(undefined), '');
});

test('renderMarkdownPage 输出完整 HTML 文档并转义标题', () => {
  const html = renderMarkdownPage('标题<X>', '## 内容');
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('<title>标题&lt;X&gt;</title>'));
  assert.ok(html.includes('<h1>标题&lt;X&gt;</h1>'));
  assert.ok(html.includes('<h2>内容</h2>'));
  assert.ok(html.includes('</html>'));
});

test('renderMarkdown 渲染一级标题', () => {
  assert.strictEqual(renderMarkdown('# 一级'), '<h1>一级</h1>');
});

test('renderMarkdown 渲染表格', () => {
  const html = renderMarkdown('| 名称 | 说明 |\n| --- | --- |\n| a | **b** |');
  assert.strictEqual(
    html,
    '<div class="md-table-wrap"><table><thead><tr><th>名称</th><th>说明</th></tr></thead>' +
    '<tbody><tr><td>a</td><td><strong>b</strong></td></tr></tbody></table></div>',
  );
});

test('renderMarkdown 表格行不被并入前一段落', () => {
  const html = renderMarkdown('前文\n| a |\n| --- |\n| b |');
  assert.ok(html.startsWith('<p>前文</p>'));
  assert.ok(html.includes('<table>'));
});

test('extractH2Titles 提取二级标题，跳过三级标题与代码块', () => {
  const md = '## 需求理解\n### 小节\n```\n## 代码里的假标题\n```\n## 功能点拆解\n# 一级不算\n## 风险点';
  assert.deepStrictEqual(extractH2Titles(md), ['需求理解', '功能点拆解', '风险点']);
});

test('extractH2Titles 空输入', () => {
  assert.deepStrictEqual(extractH2Titles(''), []);
  assert.deepStrictEqual(extractH2Titles(null), []);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { globMatch, excludedBy } = require('../../main/globMatch');

for (const [pattern, target, expected] of [
  ['*.js', 'src/a.js', true], ['src/*.js', 'src/deep/a.js', false],
  ['**/yarn.lock', 'yarn.lock', true], ['**/yarn.lock', 'a/b/yarn.lock', true],
  ['src/**/a?.[jt]s', 'src/a1.js', true], ['src/**/a?.[jt]s', 'src/x/a2.ts', true],
  ['a?.js', 'abx.js', false], ['[abc].js', 'src/b.js', true], ['[abc].js', 'd.js', false],
  ['vendor/', 'src/vendor/x.js', true], ['src/vendor/', 'src/vendor/deep/a', true],
  ['vendor/', 'vendor.js', false], ['/vendor/', 'src/vendor/a', false],
  ['[', '[', true], ['[z-a]', 'z', false], ['*.map', 'x.map/y.js', false],
]) test(`glob ${pattern} / ${target}`, () => assert.equal(globMatch(target, pattern), expected));

test('最后匹配生效，否定规则重新纳入且返回实际排除模式', () => {
  const patterns = ['**/*.js', '!src/*.js', 'src/generated.js'];
  assert.equal(excludedBy('lib/a.js', patterns), '**/*.js');
  assert.equal(excludedBy('src/a.js', patterns), null);
  assert.equal(excludedBy('src/generated.js', patterns), 'src/generated.js');
});

test('排除设置验证字符串与数量长度上限', () => {
  const { validateExcludePatterns } = require('../../main/settings');
  assert.deepEqual(validateExcludePatterns([' a ', '', '!b']), ['a', '!b']);
  for (const raw of [null, 'a', [1], ['a\nb'], Array(201).fill('a'), ['x'.repeat(201)]]) {
    assert.throws(() => validateExcludePatterns(raw), /排除规则/);
  }
  assert.equal(validateExcludePatterns(Array(200).fill('x'.repeat(200))).length, 200);
});

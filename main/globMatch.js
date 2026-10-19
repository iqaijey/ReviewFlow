/** @param {string} pattern @returns {RegExp} */
function compile(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') { source += '(?:.*/)?'; i++; }
        else source += '.*';
      } else source += '[^/]*';
    } else if (ch === '?') source += '[^/]';
    else if (ch === '[') {
      const end = pattern.indexOf(']', i + 1);
      const body = end > i + 1 ? pattern.slice(i + 1, end) : '';
      if (body && !body.includes('/') && !body.includes('\\')) {
        source += `(?!/)[${body.replace(/^!/, '^')}]`;
        i = end;
      } else source += '\\[';
    } else source += ch.replace(/[\\^$+?.()|{}\]]/g, '\\$&');
  }
  try { return new RegExp(`^${source}$`); }
  catch { return /$a/; } // 无效字符组不匹配，不能影响其他规则。
}

/** @param {string} filePath @param {string} pattern */
function globMatch(filePath, pattern) {
  const directory = pattern.endsWith('/');
  const anchored = pattern.startsWith('/');
  const value = pattern.replace(/^\//, '').replace(/\/$/, '');
  if (!value) return false;
  const matcher = compile(value);
  const parts = filePath.replace(/^\.\//, '').split('/');
  if (!value.includes('/') && !anchored) {
    return directory ? parts.slice(0, -1).some((part) => matcher.test(part)) : matcher.test(parts.at(-1) || '');
  }
  if (directory) return parts.slice(0, -1).some((_, i) => matcher.test(parts.slice(0, i + 1).join('/')));
  return matcher.test(parts.join('/'));
}

/** 最后匹配生效，否定规则可重新纳入文件。 @param {string} filePath @param {string[]} patterns @returns {string|null} */
function excludedBy(filePath, patterns) {
  /** @type {string|null} */
  let result = null;
  for (const pattern of patterns) {
    const negate = pattern.startsWith('!');
    if (globMatch(filePath, negate ? pattern.slice(1) : pattern)) result = negate ? null : pattern;
  }
  return result;
}
module.exports = { globMatch, excludedBy };

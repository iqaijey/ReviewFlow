const { test, after } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return { BrowserWindow: class {}, session: { fromPartition: () => ({}) } };
  }
  return originalLoad.call(this, request, ...rest);
};

const urlFetch = require('../../main/urlFetch');
const {
  assertHttpUrl,
  looksLikeLoginWall,
  looksLikeMojibake,
  sanitizeFileName,
  imageNameFromUrl,
  decodeEntities,
  fetchPrdFallback,
} = urlFetch;

after(() => {
  Module._load = originalLoad;
});

test('assertHttpUrl 接受 http/https 并裁剪空白', () => {
  assert.strictEqual(assertHttpUrl('https://example.com/a').hostname, 'example.com');
  assert.strictEqual(assertHttpUrl('  http://a.b/c?d=1 ').href, 'http://a.b/c?d=1');
});

test('assertHttpUrl 拒绝非 http/https 与非法格式', () => {
  for (const bad of ['ftp://x.com/f', 'file:///etc/passwd', 'javascript:alert(1)']) {
    assert.throws(() => assertHttpUrl(bad), /仅支持 http\/https/);
  }
  for (const bad of ['', null, undefined, 'not a url', 'example.com']) {
    assert.throws(() => assertHttpUrl(bad), /链接格式不正确/);
  }
});

test('looksLikeLoginWall：长正文不误判，短页面命中关键词', () => {
  assert.strictEqual(looksLikeLoginWall('请登录后查看', '短内容'), true);
  assert.strictEqual(looksLikeLoginWall('Sign in', 'hello'), true);
  assert.strictEqual(looksLikeLoginWall('正常标题', '正常内容，没有关键词'), false);
  assert.strictEqual(looksLikeLoginWall('请登录', '长'.repeat(2000)), false);
});

test('looksLikeMojibake 乱码启发式', () => {
  assert.strictEqual(looksLikeMojibake(''), false);
  assert.strictEqual(looksLikeMojibake(null), false);
  assert.strictEqual(looksLikeMojibake('这是一段正常的中文文本，不应该被判定为乱码。'), false);
  // 单字符高位拉丁不构成乱码段
  assert.strictEqual(looksLikeMojibake('café au lait'), false);
  // UTF-8 被按 Latin-1 误读的经典乱码
  const mojibake = Buffer.from('你好世界这是一段中文文本内容', 'utf8').toString('latin1');
  assert.strictEqual(looksLikeMojibake(mojibake), true);
  // 乱码段 + 足量真实 CJK：视为正常混排
  assert.strictEqual(looksLikeMojibake('ääääääää' + '中文混排内容'.repeat(10)), false);
});

test('sanitizeFileName 清洗非法字符与危险名字', () => {
  assert.strictEqual(sanitizeFileName('a/b.png'), 'a_b.png');
  assert.strictEqual(sanitizeFileName('a\\b:c.png'), 'a_b_c.png');
  assert.strictEqual(sanitizeFileName('a?.png'), 'a_.png');
  assert.strictEqual(sanitizeFileName(''), '');
  assert.strictEqual(sanitizeFileName(null), '');
  assert.strictEqual(sanitizeFileName('.'), '');
  assert.strictEqual(sanitizeFileName('..'), '');
  assert.strictEqual(sanitizeFileName('x'.repeat(150)).length, 100);
});

test('imageNameFromUrl 取 URL 末段并补扩展名', () => {
  assert.strictEqual(
    imageNameFromUrl(new URL('https://x.com/img/pic.jpg'), 'image/jpeg'),
    'pic.jpg',
  );
  assert.strictEqual(
    imageNameFromUrl(new URL('https://x.com/img/pic'), 'image/png'),
    'pic.png',
  );
  const fallback = imageNameFromUrl(new URL('https://x.com/'), 'image/webp');
  assert.match(fallback, /^x\.com-[a-z0-9]+\.webp$/);
  // 非法字符被清洗
  assert.strictEqual(
    imageNameFromUrl(new URL('https://x.com/a%20b.png'), 'image/png'),
    'a b.png',
  );
});

test('decodeEntities 解码常见 HTML 实体', () => {
  assert.strictEqual(decodeEntities('&amp;&lt;&gt;&quot;&#39;&nbsp;x'), '&<>"\' x');
  assert.strictEqual(decodeEntities('&#039;'), "'");
  assert.strictEqual(decodeEntities('无实体'), '无实体');
});

test('fetchPrdFallback 去标签提取正文与标题', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    assert.strictEqual(url, 'https://example.com/prd');
    assert.ok(typeof opts.headers['user-agent'] === 'string' && opts.headers['user-agent'].length > 0);
    return {
      ok: true,
      text: async () =>
        '<html><head><title>需求 &amp; 设计</title>' +
        '<style>.a{color:red}</style></head><body>' +
        '<script>var x = 1;</script>' +
        '<article><p>这是正文内容，需要足够长才不会被判定为无效正文。</p></article>' +
        '</body></html>',
    };
  };
  try {
    const result = await fetchPrdFallback(new URL('https://example.com/prd'));
    assert.strictEqual(result.title, '需求 & 设计');
    assert.ok(result.text.includes('这是正文内容'));
    assert.ok(!result.text.includes('var x'));
    assert.ok(!result.text.includes('color:red'));
    assert.ok(!result.text.includes('<p>'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('fetchPrdFallback HTTP 错误与正文过短时抛错', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 403 });
    await assert.rejects(
      () => fetchPrdFallback(new URL('https://example.com/x')),
      /HTTP 403/,
    );

    globalThis.fetch = async () => ({ ok: true, text: async () => '<p>太短</p>' });
    await assert.rejects(
      () => fetchPrdFallback(new URL('https://example.com/x')),
      /未能从网页提取到有效正文/,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

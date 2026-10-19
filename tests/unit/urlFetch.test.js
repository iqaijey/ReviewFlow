const { test, after } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const http = require('http');

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return new URL(`http://127.0.0.1:${server.address().port}/prd`);
}

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

test('fetchPrdFallback 去标签提取正文与标题', async (t) => {
  const url = await serve(t, (req, res) => {
    assert.strictEqual(req.url, '/prd');
    assert.ok(req.headers['user-agent'].length > 0);
    res.setHeader('content-type', 'text/html');
    res.end(
        '<html><head><title>需求 &amp; 设计</title>' +
        '<style>.a{color:red}</style></head><body>' +
        '<script>var x = 1;</script>' +
        '<article><p>这是正文内容，需要足够长才不会被判定为无效正文。</p></article>' +
        '</body></html>');
  });
  const result = await fetchPrdFallback(url);
  assert.strictEqual(result.title, '需求 & 设计');
  assert.ok(result.text.includes('这是正文内容'));
  assert.ok(!result.text.includes('var x'));
  assert.ok(!result.text.includes('color:red'));
  assert.ok(!result.text.includes('<p>'));
});

test('fetchPrdFallback HTTP 错误与正文过短时抛错', async (t) => {
  let status = 403;
  const url = await serve(t, (_req, res) => { res.writeHead(status, { 'content-type': 'text/html' }); res.end('<p>太短</p>'); });
  await assert.rejects(
    () => fetchPrdFallback(url),
    /HTTP 403/,
  );

  status = 200;
  await assert.rejects(
    () => fetchPrdFallback(url),
    /未能从网页提取到有效正文/,
  );
});

test('PRD fallback 拒绝非文本类型和超限正文', async (t) => {
  let mime = 'image/png';
  const url = await serve(t, (_req, res) => {
    res.setHeader('content-type', mime);
    res.end(mime === 'image/png' ? 'image' : 'x'.repeat(5 * 1024 * 1024 + 1));
  });
  await assert.rejects(fetchPrdFallback(url), /内容类型不支持/);
  mime = 'text/plain';
  await assert.rejects(fetchPrdFallback(url), /大小限制/);
});

test('设计稿直链要求 image 类型并限制为 20 MiB', async (t) => {
  let mime = 'image/png', oversized = false;
  const url = await serve(t, (_req, res) => {
    res.setHeader('content-type', mime);
    if (oversized) res.setHeader('content-length', String(20 * 1024 * 1024 + 1));
    res.end('png');
  });
  const result = await urlFetch.fetchDesignFromUrl(url.href);
  assert.strictEqual(result.base64, Buffer.from('png').toString('base64'));
  oversized = true;
  await assert.rejects(urlFetch.fetchDesignFromUrl(url.href), /大小限制/);
  oversized = false; mime = 'application/json';
  await assert.rejects(urlFetch.fetchDesignFromUrl(url.href), /内容类型不支持/);
});

test('链接总超时覆盖 DNS 或正文挂起', async (t) => {
  t.mock.timers.enable(['setTimeout']);
  const { withFetchTimeout } = require('../../main/urlSafety');
  let signal;
  const pending = withFetchTimeout(async (value) => { signal = value; return new Promise(() => {}); });
  t.mock.timers.tick(30000);
  await assert.rejects(pending, /链接请求超时（30 秒）/);
  assert.strictEqual(signal.aborted, true);
});

test('URL 安全：公网跳内网被拦截，用户直输内网仍允许', async (t) => {
  const dns = require('dns').promises;
  const { assertSafeHop, isPrivateAddress, fetchWithRedirects, readBoundedBody } = require('../../main/urlSafety');
  t.mock.method(dns, 'lookup', async (host) => [{ address: host === 'public.test' ? '8.8.8.8' : '127.0.0.1', family: 4 }]);
  for (const ip of ['0.0.0.0', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', '100.64.0.1', '224.0.0.1', '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1']) assert.ok(isPrivateAddress(ip), ip);
  assert.strictEqual(isPrivateAddress('8.8.8.8'), false);
  await assert.rejects(assertSafeHop(false, new URL('http://internal.test')), /已阻止/);
  const url = await serve(t, (_req, res) => res.end('内网正常正文'));
  const response = await fetchWithRedirects(url, AbortSignal.timeout(1000), 'test');
  assert.strictEqual(await response.text(), '内网正常正文');
  await assert.rejects(readBoundedBody(new Response('x', { headers: { 'content-length': '100' } }), 10), /大小限制/);
});

test('公网初始分类不因来源 DNS 重绑定而改变，所有跳转目标重新解析', async (t) => {
  const dns = require('dns').promises;
  const { fetchWithRedirects } = require('../../main/urlSafety');
  let sourceLookups = 0;
  t.mock.method(dns, 'lookup', async (host) => [{ address: host === 'rebind.test' && ++sourceLookups === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }]);
  let requests = 0, connections = 0;
  const server = http.createServer((_req, res) => { requests++; res.end('不得访问'); });
  server.on('connection', () => { connections++; });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = new URL(`http://127.0.0.1:${server.address().port}`);
  await assert.rejects(fetchWithRedirects(new URL(`http://rebind.test:${url.port}/start`), new AbortController().signal, 'test'), /已阻止/);
  assert.strictEqual(sourceLookups, 2);
  assert.strictEqual(requests, 0);
  assert.strictEqual(connections, 0);
});

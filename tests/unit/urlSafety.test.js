const { test } = require('node:test');
const assert = require('node:assert/strict');
const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const { guardedLookup, assertConnectedAddress, assertSafeResource, isPrivateAddress, fetchWithRedirects, readBoundedBody } = require('../../main/urlSafety');

test('连接 lookup 检查所有候选地址，兼容单地址和 all 回调并保留内网入口', async (t) => {
  let addresses = [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }];
  t.mock.method(dns, 'lookup', async () => addresses);
  const lookup = (initialPrivate, all) => new Promise((resolve, reject) => {
    guardedLookup(initialPrivate)('target.test', { all }, (error, address, family) => error ? reject(error) : resolve({ address, family }));
  });
  await assert.rejects(lookup(false, true), /已阻止/);
  await assert.rejects(lookup(false, false), /已阻止/);
  assert.deepEqual((await lookup(true, true)).address, addresses);
  addresses = [{ address: '8.8.8.8', family: 4 }];
  assert.deepEqual(await lookup(false, false), { address: '8.8.8.8', family: 4 });
  addresses = [];
  await assert.rejects(lookup(false, true), /无法解析/);
});

test('所有资源目的策略与实际 IP 策略阻断私网及特殊地址，内网入口不受限', async (t) => {
  t.mock.method(dns, 'lookup', async (host) => [{ address: host === 'public.test' ? '8.8.8.8' : '127.0.0.1', family: 4 }]);
  for (const protocol of ['http:', 'https:', 'ws:', 'wss:']) {
    await assert.rejects(assertSafeResource(false, `${protocol}//private.test/resource`), /已阻止/);
    await assertSafeResource(true, `${protocol}//private.test/resource`);
    await assertSafeResource(false, `${protocol}//public.test/resource`);
  }
  for (const url of ['data:image/png;base64,a', 'blob:https://public.test/id', 'about:blank']) await assertSafeResource(false, url);
  await assert.rejects(assertSafeResource(false, 'file:///etc/passwd'), /已阻止/);
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '192.0.2.1', '198.18.0.1', '240.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1']) {
    assert.equal(isPrivateAddress(ip), true, ip);
    assert.throws(() => assertConnectedAddress(false, { ip }), /已阻止/);
    assert.doesNotThrow(() => assertConnectedAddress(true, { ip }));
  }
  assert.doesNotThrow(() => assertConnectedAddress(false, { ip: '8.8.8.8' }));
  for (const ip of [undefined, '', 'not-an-ip']) {
    for (const protocol of ['http:', 'https:']) {
      assert.throws(() => assertConnectedAddress(false, { url: `${protocol}//public.test`, ip }), /已阻止/);
      assert.doesNotThrow(() => assertConnectedAddress(true, { url: `${protocol}//private.test`, ip }));
    }
  }
  for (const url of ['data:text/plain,a', 'blob:https://public.test/id', 'about:blank']) {
    assert.doesNotThrow(() => assertConnectedAddress(false, { url }));
  }
  assert.throws(() => assertConnectedAddress(false, { url: 'chrome-extension://id/page' }), /已阻止/);
});

test('HTTP 600 正常拒绝而非在响应回调抛出未捕获异常', { timeout: 2000 }, async (t) => {
  const server = http.createServer((_req, res) => { res.writeHead(600); res.end('invalid'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  await assert.rejects(fetchWithRedirects(new URL(`http://127.0.0.1:${server.address().port}`), AbortSignal.timeout(1000), 'test'), /HTTP 状态码无效.*600/);
});

test('响应头构造异常销毁输入流并正常拒绝', async (t) => {
  let incoming;
  t.mock.method(http, 'request', (_url, _options, respond) => {
    const request = new EventEmitter();
    request.end = () => {
      incoming = Readable.from([]);
      incoming.statusCode = 200;
      incoming.headers = { 'invalid header': 'value' };
      respond(incoming);
    };
    return request;
  });
  await assert.rejects(fetchWithRedirects(new URL('http://127.0.0.1'), new AbortController().signal, 'test', true));
  assert.equal(incoming.destroyed, true);
});

test('Node 请求保持 hostname/SNI、自定义 lookup 和手动跳转，最多五次且拒绝非法目标', async (t) => {
  t.mock.method(dns, 'lookup', async (host) => [{ address: host === 'private.test' ? '127.0.0.1' : '8.8.8.8', family: 4 }]);
  let calls = 0, location = '/next';
  t.mock.method(https, 'request', (url, options, respond) => {
    calls++;
    assert.equal(url.hostname, 'public.test');
    assert.equal(options.servername, 'public.test');
    assert.equal(options.agent, false);
    assert.equal(typeof options.lookup, 'function');
    const request = new EventEmitter();
    request.end = () => {
      const incoming = Readable.from([]);
      incoming.statusCode = 302;
      incoming.headers = location === null ? {} : { location };
      respond(incoming);
    };
    return request;
  });
  const fetch = () => fetchWithRedirects(new URL('https://public.test/start'), new AbortController().signal, 'test');
  await assert.rejects(fetch(), /重定向次数超过限制（5 次）/);
  assert.equal(calls, 6);
  location = 'http://private.test';
  const before = calls;
  await assert.rejects(fetch(), /已阻止/);
  assert.equal(calls, before + 1);
  location = 'file:///etc/passwd';
  await assert.rejects(fetch(), /重定向仅支持 http\/https/);
  location = null;
  await assert.rejects(fetch(), /重定向缺少目标地址/);
});

test('内网入口 Node 请求保留相对重定向和无 content-length 的流式字节限制', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/start') { res.writeHead(302, { location: '/body' }); res.end(); }
    else { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('12345'); res.end('67890'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = new URL(`http://127.0.0.1:${server.address().port}/start`);
  const response = await fetchWithRedirects(url, AbortSignal.timeout(1000), 'test');
  assert.equal((await readBoundedBody(response, 10)).toString(), '1234567890');
  const oversized = await fetchWithRedirects(url, AbortSignal.timeout(1000), 'test');
  await assert.rejects(readBoundedBody(oversized, 9), /大小限制/);
});

test('Node 请求与正文都响应 abort', async (t) => {
  const server = http.createServer((_req, res) => { res.writeHead(200); res.write('pending'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const controller = new AbortController();
  const response = await fetchWithRedirects(new URL(`http://127.0.0.1:${server.address().port}`), controller.signal, 'test');
  const reading = readBoundedBody(response, 100);
  controller.abort();
  await assert.rejects(reading, /abort/i);
});

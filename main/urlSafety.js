const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');

const blocked = new net.BlockList();
const ipv4Ranges = /** @type {[string, number][]} */ ([['0.0.0.0', 8], ['10.0.0.0', 8], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['100.64.0.0', 10], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]);
const ipv6Ranges = /** @type {[string, number][]} */ ([['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]);
for (const [address, prefix] of ipv4Ranges) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of ipv6Ranges) blocked.addSubnet(address, prefix, 'ipv6');

/** @param {string} address */
function isPrivateAddress(address) {
  const host = address.replace(/^\[|\]$/g, '');
  if (!net.isIP(host)) return true;
  return blocked.check(host, net.isIP(host) === 6 ? 'ipv6' : 'ipv4');
}

function destinationError() {
  return Object.assign(new Error('已阻止公网链接重定向到内网或特殊地址'), { code: 'ERR_UNSAFE_URL_DESTINATION' });
}

/** @param {boolean} initialPrivate @param {{ip?:string,url?:string}} details */
function assertConnectedAddress(initialPrivate, details) {
  if (details.url) {
    const { protocol } = new URL(details.url);
    if (['data:', 'blob:', 'about:'].includes(protocol)) return;
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(protocol)) throw destinationError();
  }
  if (!initialPrivate && (!details.ip || !net.isIP(details.ip) || isPrivateAddress(details.ip))) throw destinationError();
}

/** @param {boolean} initialPrivate @param {string} resourceUrl */
async function assertSafeResource(initialPrivate, resourceUrl) {
  const url = new URL(resourceUrl);
  if (['data:', 'blob:', 'about:'].includes(url.protocol)) return;
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw destinationError();
  await assertSafeHop(initialPrivate, url);
}

/** @param {URL} url */
async function privateHost(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await dns.lookup(host, { all: true });
  if (!addresses.length) throw new Error('链接域名无法解析');
  return addresses.some(({ address }) => isPrivateAddress(address));
}

/** 用户直输内网合法；初始分类在整条链上保持不变。 @param {boolean} initialPrivate @param {URL} to */
async function assertSafeHop(initialPrivate, to) {
  const targetPrivate = await privateHost(to);
  if (!initialPrivate && targetPrivate) throw destinationError();
}

/** @param {boolean} initialPrivate @returns {import('net').LookupFunction} */
function guardedLookup(initialPrivate) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { all: true, family: options.family }).then((addresses) => {
      if (!addresses.length) throw new Error('链接域名无法解析');
      if (!initialPrivate && addresses.some(({ address }) => isPrivateAddress(address))) throw destinationError();
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    }).catch((error) => callback(error, '', 4));
  };
}

/** @param {URL} url @param {AbortSignal} signal @param {string} userAgent @param {boolean} initialPrivate @returns {Promise<Response>} */
function requestOnce(url, signal, userAgent, initialPrivate) {
  return new Promise((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (!initialPrivate && net.isIP(hostname) && isPrivateAddress(hostname)) return reject(destinationError());
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      signal, agent: false, lookup: guardedLookup(initialPrivate), servername: hostname,
      headers: { 'user-agent': userAgent },
    }, (incoming) => {
      try {
        const status = incoming.statusCode;
        if (typeof status !== 'number' || !Number.isInteger(status) || status < 200 || status > 599) throw new Error(`HTTP 状态码无效：${status}`);
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        if ([204, 205, 304].includes(status)) {
          incoming.destroy();
          resolve(new Response(null, { status, headers }));
          return;
        }
        const iterator = incoming[Symbol.asyncIterator]();
        const body = new ReadableStream({
          async pull(controller) {
            try {
              const { done, value } = await iterator.next();
              if (done) controller.close(); else controller.enqueue(value);
            } catch (error) { controller.error(error); }
          },
          cancel() { incoming.destroy(); },
        });
        resolve(new Response(body, { status, headers }));
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    request.on('error', reject);
    request.end();
  });
}

/** @param {Response} response @param {number} cap */
async function readBoundedBody(response, cap) {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > cap)) {
    await response.body?.cancel();
    throw new Error('链接内容超过大小限制');
  }
  if (!response.body) throw new Error('链接内容为空');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) throw new Error('链接内容超过大小限制');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** @param {URL} initial @param {AbortSignal} signal @param {string} userAgent @param {boolean} [initialPrivate] */
async function fetchWithRedirects(initial, signal, userAgent, initialPrivate = undefined) {
  let current = initial;
  const startedPrivate = initialPrivate ?? await privateHost(initial);
  for (let hops = 0; ; hops += 1) {
    const response = await requestOnce(current, signal, userAgent, startedPrivate);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    if (hops >= 5) throw new Error('链接重定向次数超过限制（5 次）');
    const location = response.headers.get('location');
    if (!location) throw new Error('链接重定向缺少目标地址');
    const next = new URL(location, current);
    if (!['http:', 'https:'].includes(next.protocol)) throw new Error('重定向仅支持 http/https 链接');
    await assertSafeHop(startedPrivate, next);
    current = next;
  }
}

/** @template T @param {(signal: AbortSignal) => Promise<T>} operation */
async function withFetchTimeout(operation) {
  const controller = new AbortController();
  let timer;
  /** @type {Promise<never>} */
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('链接请求超时（30 秒）'));
    }, 30000);
  });
  try { return await Promise.race([operation(controller.signal), timeout]); }
  finally { clearTimeout(timer); }
}

module.exports = { isPrivateAddress, privateHost, assertSafeHop, assertSafeResource, assertConnectedAddress, guardedLookup, readBoundedBody, fetchWithRedirects, withFetchTimeout };

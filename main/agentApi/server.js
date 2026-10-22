// 本机 HTTP 接口：只监听 127.0.0.1，必须带 Bearer 令牌；
// 拒绝带 Origin 的请求并校验 Host，防止网页借浏览器跨站或 DNS 重绑定调用。
const http = require('http');
const crypto = require('crypto');
const { readGuide } = require('./guide');

const MAX_BODY_BYTES = 50 * 1024 * 1024;

/**
 * @param {string} expected
 * @param {string | undefined} header
 */
function tokenMatches(expected, header) {
  const match = /^Bearer\s+(\S+)$/i.exec(String(header || ''));
  if (!expected || !match) return false;
  const a = Buffer.from(match[1]);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** @param {string} token @param {string} challenge */
function challengeProof(token, challenge) {
  return crypto.createHmac('sha256', token).update(`reviewflow-agent:${challenge}`).digest('hex');
}

/** @param {http.IncomingMessage} req */
function readBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体超过 50 MB'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {{
 *   getToken: () => string,
 *   listTools: () => unknown[],
 *   callTool: (name: string, input: unknown) => Promise<unknown>,
 *   health: () => Record<string, unknown>,
 * }} deps
 */
function createAgentServer({ getToken, listTools, callTool, health }) {
  const server = http.createServer(async (req, res) => {
    /** @param {number} status @param {unknown} body */
    const send = (status, body) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.headers.origin) return send(403, { ok: false, error: '不接受浏览器跨源请求' });
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(String(req.headers.host || ''))) return send(403, { ok: false, error: 'Host 无效' });
      const challenge = new URL(String(req.url || '/'), 'http://127.0.0.1').searchParams.get('challenge');
      // 免令牌的身份挑战：客户端先确认对端持有令牌，再发送令牌，防止端口被别的进程顶替后令牌外泄
      if (req.method === 'GET' && challenge !== null && /^\/v1\/health(\?|$)/.test(String(req.url))) {
        if (!/^[0-9a-f]{32,128}$/.test(challenge)) return send(400, { ok: false, error: 'challenge 无效' });
        return send(200, { ok: true, proof: challengeProof(getToken(), challenge) });
      }
      if (!tokenMatches(getToken(), req.headers.authorization)) return send(401, { ok: false, error: '缺少或错误的令牌（Authorization: Bearer <token>）' });
      const url = new URL(String(req.url || '/'), 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/v1/health') return send(200, { ok: true, ...health() });
      if (req.method === 'GET' && url.pathname === '/v1/tools') return send(200, { ok: true, tools: listTools() });
      if (req.method === 'GET' && url.pathname === '/v1/guide') {
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(readGuide());
        return;
      }
      const match = /^\/v1\/tools\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
      if (!match) return send(404, { ok: false, error: '未知路径；可用：GET /v1/health、GET /v1/tools、GET /v1/guide、POST /v1/tools/<name>' });
      if (req.method !== 'POST') return send(405, { ok: false, error: '调用工具请使用 POST' });
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return send(415, { ok: false, error: 'Content-Type 必须是 application/json' });
      const text = await readBody(req);
      let input;
      try {
        input = text.trim() ? JSON.parse(text) : {};
      } catch {
        return send(400, { ok: false, error: '请求体不是有效 JSON' });
      }
      const result = await callTool(match[1], input);
      return send(200, { ok: true, result: result === undefined ? null : result });
    } catch (error) {
      const status = Number.isInteger(error && error.status) ? error.status : 500;
      return send(status, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
  // 长任务最多等待 600 秒，关闭 Node 默认的请求超时
  server.requestTimeout = 0;
  server.timeout = 0;

  /** @param {number} port @returns {Promise<number>} */
  function listenOn(port) {
    return new Promise((resolve, reject) => {
      const onError = (/** @type {Error} */ error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => {
        server.off('error', onError);
        const address = server.address();
        resolve(address && typeof address === 'object' ? address.port : port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
  }

  /** 首选端口被占用时退回随机端口 @param {number} preferred */
  async function listen(preferred) {
    try {
      return await listenOn(preferred);
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || preferred === 0) throw error;
      return listenOn(0);
    }
  }

  function close() {
    return new Promise((resolve) => { server.close(() => resolve(undefined)); server.closeAllConnections(); });
  }

  return { listen, close, server };
}

module.exports = { createAgentServer, tokenMatches, challengeProof };

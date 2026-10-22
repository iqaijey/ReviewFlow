const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { TOOLS, listTools } = require('../../main/agentApi/catalog');
const { createDispatcher, buildArgs } = require('../../main/agentApi/dispatcher');
const { createAgentServer } = require('../../main/agentApi/server');
const { readConfig, writeConfig, newToken } = require('../../main/agentApi/config');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-agent-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('目录覆盖 main.js 注册的全部 IPC 通道，名称合法且唯一，必填字段都有定义', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../main/main.js'), 'utf8');
  const registered = [...source.matchAll(/(?<![.\w])handle\('([^']+)'/g)].map((m) => m[1]).sort();
  const cataloged = TOOLS.filter((t) => t.channel).map((t) => t.channel).sort();
  assert.deepEqual(cataloged, registered);
  const names = TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const tool of listTools()) {
    assert.match(tool.name, /^[A-Za-z0-9_-]{1,64}$/);
    assert.ok(tool.description.length > 0, tool.name);
    for (const key of tool.inputSchema.required || []) assert.ok(Object.hasOwn(tool.inputSchema.properties, key), `${tool.name}.${key}`);
  }
});

test('参数映射：payload 原样传入，位置参数与分组对象按目录拼装', () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  assert.deepEqual(buildArgs(byName.checklist_setStatus, { folder: '/a', id: 'x', status: 'fixed' }), [{ folder: '/a', id: 'x', status: 'fixed' }]);
  assert.deepEqual(buildArgs(byName.git_getChanges, { folder: '/a', mode: 'staged' }), ['/a', { mode: 'staged' }]);
  assert.deepEqual(buildArgs(byName.git_getChanges, { folder: '/a' }), ['/a', undefined]);
  assert.deepEqual(buildArgs(byName.plan_detail, { folder: '/a', planId: 'p' }), ['/a', 'p']);
  assert.deepEqual(buildArgs(byName.recent_list, { anything: 1 }), []);
});

/** @param {Partial<Parameters<typeof createDispatcher>[0]>} [overrides] */
function dispatcher(overrides = {}) {
  const calls = [];
  const changes = [];
  const d = createDispatcher({
    invoke: async (channel, args) => { calls.push([channel, args]); return { channel }; },
    composites: {},
    notify: (change) => changes.push(change),
    ...overrides,
  });
  return { ...d, calls, changes };
}

test('普通工具调用后按 scopes 通知界面，只读工具不通知，未知工具与非对象参数报错', async () => {
  const d = dispatcher();
  assert.deepEqual(await d.callTool('checklist_list', { folder: '/repo' }), { channel: 'checklist:list' });
  assert.equal(d.changes.length, 0);
  await d.callTool('checklist_clear', { folder: '/repo', confirmed: true });
  assert.deepEqual(d.changes, [{ tool: 'checklist_clear', folder: '/repo', scopes: ['findings'] }]);
  await assert.rejects(d.callTool('nope', {}), (e) => e.status === 404);
  await assert.rejects(d.callTool('checklist_list', [1]), (e) => e.status === 400);
});

test('长任务自动生成 runId，等待超时返回 jobId，之后可继续等待拿到结果', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const d = dispatcher({ invoke: async (channel, args) => { await gate; return { channel, payload: args[0] }; } });
  const first = await d.callTool('fix_verifyFinding', { folder: '/repo', findingId: 'f1', waitSec: 0 });
  assert.equal(first.state, 'running');
  assert.match(first.jobId, /^agent-/);
  assert.equal(first.runId, first.jobId);
  release();
  const done = await d.callTool('agent_waitJob', { jobId: first.jobId, waitSec: 5 });
  assert.equal(done.payload.runId, first.runId);
  assert.equal(Object.hasOwn(done.payload, 'waitSec'), false);
  assert.deepEqual(d.changes.map((c) => c.tool), ['fix_verifyFinding']);
  const jobs = await d.callTool('agent_listJobs', {});
  assert.equal(jobs[0].state, 'done');
});

test('长任务失败时等待返回错误，组合工具通过 composites 执行', async () => {
  const d = dispatcher({ invoke: async () => { throw new Error('后端不支持'); },
    composites: { changes_summary: async (input) => ({ files: [], folder: input.folder }) } });
  await assert.rejects(d.callTool('fix_generatePatch', { folder: '/r', findingId: 'f' }), /后端不支持/);
  assert.deepEqual(await d.callTool('changes_summary', { folder: '/r' }), { files: [], folder: '/r' });
  await assert.rejects(d.callTool('agent_waitJob', { jobId: 'missing' }), /不存在/);
});

/**
 * @param {{ method?: string, path: string, headers?: Record<string, string>, body?: string, port: number }} opts
 * @returns {Promise<{ status: number, json: any }>}
 */
function send({ method = 'GET', path: route, headers = {}, body, port }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode || 0, json: JSON.parse(text) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('HTTP 接口：校验令牌、拒绝浏览器 Origin 与非本机 Host、要求 JSON，并返回工具结果', async () => {
  const token = newToken();
  const received = [];
  const server = createAgentServer({ getToken: () => token, listTools, health: () => ({ app: 'ReviewFlow' }),
    callTool: async (name, input) => { received.push([name, input]); if (name === 'bad') throw Object.assign(new Error('坏了'), { status: 404 }); return { ok: name }; } });
  const port = await server.listen(0);
  try {
    const auth = { Authorization: `Bearer ${token}` };
    assert.equal((await send({ port, path: '/v1/health' })).status, 401);
    assert.equal((await send({ port, path: '/v1/health', headers: { Authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await send({ port, path: '/v1/health', headers: { ...auth, Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await send({ port, path: '/v1/health', headers: { ...auth, Host: 'evil.example' } })).status, 403);
    assert.equal((await send({ port, path: '/v1/health', headers: auth })).json.app, 'ReviewFlow');
    assert.ok((await send({ port, path: '/v1/tools', headers: auth })).json.tools.length > 70);
    assert.equal((await send({ port, method: 'POST', path: '/v1/tools/checklist_list', headers: { ...auth, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    const ok = await send({ port, method: 'POST', path: '/v1/tools/checklist_list', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{"folder":"/r"}' });
    assert.deepEqual(ok.json, { ok: true, result: { ok: 'checklist_list' } });
    assert.deepEqual(received.at(-1), ['checklist_list', { folder: '/r' }]);
    const bad = await send({ port, method: 'POST', path: '/v1/tools/bad', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(bad.status, 404);
    assert.equal(bad.json.error, '坏了');
  } finally {
    await server.close();
  }
});

test('配置文件权限 600，损坏或缺字段时回退默认值', () => {
  const dir = fs.mkdtempSync(path.join(root, 'cfg-'));
  assert.equal(readConfig(dir).enabled, true);
  assert.equal(readConfig(dir).token, '');
  const token = newToken();
  writeConfig(dir, { enabled: false, port: 1234, token, pid: 1, url: 'http://127.0.0.1:1234', appPath: null });
  assert.equal(fs.statSync(path.join(dir, 'agent-api.json')).mode & 0o777, 0o600);
  assert.deepEqual(readConfig(dir), { enabled: false, port: 1234, token, pid: 1, url: 'http://127.0.0.1:1234', appPath: null });
  fs.writeFileSync(path.join(dir, 'agent-api.json'), '{bad');
  assert.equal(readConfig(dir).enabled, true);
});

/**
 * @param {string} dir
 * @param {any[]} messages
 * @param {number} expected
 */
function runBridge(dir, messages, expected) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '../../main/agentApi/mcpBridge.js')], {
      env: { ...process.env, REVIEWFLOW_USER_DATA_DIR: dir }, stdio: ['pipe', 'pipe', 'pipe'] });
    const replies = [];
    let buffer = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`桥接超时：${buffer}`)); }, 10_000);
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        replies.push(JSON.parse(buffer.slice(0, index)));
        buffer = buffer.slice(index + 1);
      }
      if (replies.length >= expected) { clearTimeout(timer); child.stdin.end(); resolve(replies); }
    });
    for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
  });
}

test('MCP 桥：握手、列工具，并把 tools/call 转发到运行中的应用', async () => {
  const dir = fs.mkdtempSync(path.join(root, 'bridge-'));
  const token = newToken();
  const server = createAgentServer({ getToken: () => token, listTools, health: () => ({ app: 'ReviewFlow' }),
    callTool: async (name, input) => { if (name === 'checklist_clear') throw new Error('需要确认'); return { name, input }; } });
  const port = await server.listen(0);
  writeConfig(dir, { enabled: true, port, token, pid: process.pid, url: `http://127.0.0.1:${port}`, appPath: null });
  try {
    const replies = await runBridge(dir, [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'checklist_list', arguments: { folder: '/r' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'checklist_clear', arguments: { folder: '/r' } } },
      { jsonrpc: '2.0', id: 5, method: 'unknown/method' },
    ], 5);
    const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
    assert.equal(byId[1].result.protocolVersion, '2025-03-26');
    assert.ok(byId[2].result.tools.some((t) => t.name === 'review_start'));
    assert.deepEqual(JSON.parse(byId[3].result.content[0].text), { name: 'checklist_list', input: { folder: '/r' } });
    assert.equal(byId[4].result.isError, true);
    assert.match(byId[4].result.content[0].text, /需要确认/);
    assert.equal(byId[5].error.code, -32601);
  } finally {
    await server.close();
  }
});

test('MCP 桥：接口被关闭时调用直接报错，不尝试启动应用', async () => {
  const dir = fs.mkdtempSync(path.join(root, 'off-'));
  writeConfig(dir, { enabled: false, port: 1, token: newToken(), pid: null, url: null, appPath: '/nonexistent/ReviewFlow.app' });
  const [reply] = await runBridge(dir, [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recent_list', arguments: {} } }], 1);
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /已在「AI 设置」中关闭/);
});

test('健康检查挑战：无需令牌即可证明对端持有令牌，挑战格式非法时拒绝', async () => {
  const { challengeProof } = require('../../main/agentApi/server');
  const token = newToken();
  const server = createAgentServer({ getToken: () => token, listTools, health: () => ({}), callTool: async () => null });
  const port = await server.listen(0);
  try {
    const challenge = 'ab'.repeat(16);
    const res = await send({ port, path: `/v1/health?challenge=${challenge}` });
    assert.equal(res.json.proof, challengeProof(token, challenge));
    assert.equal((await send({ port, path: '/v1/health?challenge=xyz' })).status, 400);
    assert.equal((await send({ port, path: '/v1/tools?challenge=' + challenge })).status, 401);
  } finally {
    await server.close();
  }
});

test('MCP 桥：端口被冒名进程占用时不发送令牌；无效消息返回 -32600 且桥继续工作', async () => {
  const dir = fs.mkdtempSync(path.join(root, 'impostor-'));
  const seenAuth = [];
  const impostor = http.createServer((req, res) => {
    seenAuth.push(req.headers.authorization || '');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, proof: 'forged', result: 'forged' }));
  });
  await new Promise((resolve) => impostor.listen(0, '127.0.0.1', resolve));
  const port = /** @type {import('net').AddressInfo} */ (impostor.address()).port;
  writeConfig(dir, { enabled: true, port, token: newToken(), pid: process.pid, url: `http://127.0.0.1:${port}`, appPath: null });
  try {
    const replies = await runBridge(dir, [
      null,
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'recent_list', arguments: {} } },
    ], 2);
    const byId = Object.fromEntries(replies.map((r) => [r.id, r]));
    assert.equal(byId.null.error.code, -32600);
    assert.equal(byId[7].result.isError, true);
    assert.ok(seenAuth.length > 0);
    assert.ok(seenAuth.every((h) => h === ''), '令牌不应发送给未通过挑战的进程');
  } finally {
    await new Promise((resolve) => impostor.close(resolve));
  }
});

test('同一 runId 的长任务仍在运行时拒绝重复发起，结束后允许复用', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const d = dispatcher({ invoke: async () => { await gate; return 'first'; } });
  await d.callTool('fix_verifyFinding', { folder: '/r', findingId: 'f', runId: 'r1', waitSec: 0 });
  await assert.rejects(d.callTool('fix_verifyFinding', { folder: '/r', findingId: 'f', runId: 'r1', waitSec: 0 }), (e) => e.status === 409);
  release();
  assert.equal(await d.callTool('agent_waitJob', { jobId: 'r1', waitSec: 5 }), 'first');
  assert.equal(await d.callTool('fix_verifyFinding', { folder: '/r', findingId: 'f', runId: 'r1', waitSec: 5 }), 'first');
});

test('review_start 使用预设时与界面一致写回后端/模型/思考强度，并带上预设提示词与维度', async () => {
  const vm = require('vm');
  const { createRequire } = require('module');
  const filename = require.resolve('../../main/agentApi/composite');
  const local = createRequire(filename);
  const saved = [];
  const preset = { id: 'p1', name: '安全', backend: 'codex', model: 'gpt-x', effort: 'high', customPrompt: '只看安全', dimensions: ['安全性', ' '] };
  const overrides = {
    '../git': { getChanges: async () => ({ files: [{ path: 'a.js', hunks: [{ lines: [{ type: 'add' }, { type: 'del' }] }] }], snapshotId: 's1' }) },
    '../store': { listReviews: () => [] },
    '../planStore': { getActivePlan: () => null },
    '../settings': { getSettings: async () => ({ backend: 'api', presets: [preset] }), saveSettings: async (patch) => { saved.push(patch); } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: (spec) => overrides[spec] || local(spec), module, Date }, { filename });
  const calls = [];
  const composites = module.exports.createComposites({ invoke: async (channel, args) => { calls.push([channel, args[0]]); return { markdown: 'ok', reviewId: 'rv' }; },
    openProject: async () => undefined });
  const result = await composites.review_start({ folder: '/r', presetId: 'p1', runId: 'run-1' });
  assert.equal(JSON.stringify(saved), JSON.stringify([{ backend: 'codex', codexModel: 'gpt-x', reasoningEffort: 'high' }]));
  assert.equal(calls[0][0], 'ai:analyzeOverview');
  assert.equal(calls[0][1].customPromptOverride, '只看安全');
  assert.equal(calls[0][1].customDimensionsOverride, '安全性');
  assert.equal(calls[0][1].snapshotId, 's1');
  assert.match(calls[0][1].title, /1 文件 \+1 -1$/);
  assert.equal(result.reviewId, 'rv');
  await assert.rejects(composites.review_start({ folder: '/r', presetId: 'missing' }), /预设不存在/);
});

test('启停串行：listen 期间关闭接口，最终不在监听且配置无运行地址；重复启动不重复 listen', async () => {
  const vm = require('vm');
  const { createRequire } = require('module');
  const filename = require.resolve('../../main/agentApi/index');
  const local = createRequire(filename);
  const dir = fs.mkdtempSync(path.join(root, 'life-'));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const events = [];
  const overrides = {
    electron: { app: { getPath: () => dir, getVersion: () => '0', isPackaged: false }, BrowserWindow: { getAllWindows: () => [] } },
    './server': { createAgentServer: () => ({
      listen: async () => { events.push('listen'); await gate; return 4567; },
      close: async () => { events.push('close'); },
    }) },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: (spec) => overrides[spec] || local(spec), module, process, __dirname: path.dirname(filename) }, { filename });
  const agent = module.exports.createAgentApi(new Map());
  const started = agent.start();
  const again = agent.start();
  const disabled = agent.setEnabled(false);
  release();
  await Promise.all([started, again]);
  const info = await disabled;
  assert.deepEqual(events, ['listen', 'close']);
  assert.equal(info.running, false);
  assert.equal(info.enabled, false);
  const stored = readConfig(dir);
  assert.equal(stored.enabled, false);
  assert.equal(stored.url, null);
  assert.equal(stored.pid, null);
});

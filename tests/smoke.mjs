// 冒烟测试：临时 git 仓库 + 真实 Electron + CDP 黑盒断言
// AI 调用全部打到本地 mock SSE 服务（127.0.0.1 随机端口），不访问真实模型服务
// 运行：npm run smoke（需要本机完整 node_modules，不适合 CI）
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CDP_PORT = 9333;
const OVERALL_TIMEOUT_MS = 180_000;

const EXPECTED_TABS = ['改动总览', '多角度 Review', '逐句解析', '完整讲解', 'AI 设置', '需求方案'];
const EXPECTED_FILES = ['ViewController.m', 'featureFlags.js', 'userService.js'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, extra = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !extra ? '' : ` — ${extra}`}`);
}

// ---------- 临时 git 仓库 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewflow-smoke-'));
const repo = path.join(tmp, 'demo-repo');
const prdPath = path.join(tmp, 'smoke-prd.md');

function gitRepo(...args) {
  execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
}

function createTestRepo() {
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'ios'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'userService.js'), `export class UserService {
  constructor(store) {
    this.store = store;
  }

  async getUser(id) {
    return this.store.find(id);
  }
}
`);
  fs.writeFileSync(path.join(repo, 'ios', 'ViewController.m'), `@implementation ViewController

- (void)viewDidLoad {
  [super viewDidLoad];
}

@end
`);
  fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
  gitRepo('init', '-b', 'main');
  gitRepo('config', 'user.email', 'smoke@test.local');
  gitRepo('config', 'user.name', 'smoke');
  gitRepo('add', '-A');
  gitRepo('-c', 'commit.gpgsign=false', 'commit', '-m', 'init');

  // 未提交改动：改 Service 类内部方法、改 .m 文件、新增未跟踪文件
  fs.writeFileSync(path.join(repo, 'src', 'userService.js'), `export class UserService {
  constructor(store) {
    this.store = store;
    this.cache = new Map();
  }

  async getUser(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const user = await this.store.find(id);
    this.cache.set(id, user);
    return user;
  }
}
`);
  fs.writeFileSync(path.join(repo, 'ios', 'ViewController.m'), `@implementation ViewController

- (void)viewDidLoad {
  [super viewDidLoad];
  [self setupCache];
}

- (void)setupCache {
}

@end
`);
  fs.writeFileSync(path.join(repo, 'src', 'featureFlags.js'), `export function isEnabled(flag) {
  return Boolean(flag);
}
`);
  fs.writeFileSync(prdPath, '# 演示 PRD\n\n## 需求\n支持用户缓存，提升读取性能。\n');
}

// 测试方案数据写入共享 userData（开发版/打包版同目录），跑完必须清掉
const userData = path.join(os.homedir(), 'Library', 'Application Support', 'auto-review');
const folderHash = crypto.createHash('sha1').update(repo).digest('hex').slice(0, 16);
const plansHashDir = path.join(userData, 'plans', folderHash);

// 用户真实设置文件：冒烟会临时写入（customPrompt 往返 + 切 mock 后端），启动前快照原始字节，结束恢复
const settingsFile = path.join(userData, 'settings.json');
const origSettingsRaw = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null;

// ---------- CDP 客户端 ----------
class Cdp {
  constructor(wsUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
    this.ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg.id || !this.pending.has(msg.id)) return;
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP ${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    });
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      const desc = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
      throw new Error(`页面内执行失败：${desc || r.exceptionDetails.text}`);
    }
    return r.result ? r.result.value : undefined;
  }

  close() {
    try {
      this.ws.close();
    } catch { /* 忽略 */ }
  }
}

let cdp = null;
let child = null;
let childExited = false;
let childLog = '';
let origPlanReviewEnabled = null;
let origSettings = null;
let settingsTouched = false;
let mockServer = null;
const mockSockets = new Set();

// mock SSE 行为：每批吐 sseCfg.chunks 段、间隔 sseCfg.delayMs 毫秒（暂停用慢速，导出用快速）
const sseCfg = { chunks: 30, delayMs: 150 };

// OpenAI 兼容 SSE mock：慢慢吐 data: 行，客户端中断（cancelRun abort）时停止发送
function startMockServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || !String(req.url).includes('/chat/completions')) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      let sent = 0;
      const timer = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          clearInterval(timer);
          return;
        }
        sent += 1;
        try {
          const chunk = { choices: [{ delta: { content: `mock 第 ${sent} 段评审输出。\n` } }] };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          if (sent >= sseCfg.chunks) {
            clearInterval(timer);
            res.write('data: [DONE]\n\n');
            res.end();
          }
        } catch {
          clearInterval(timer);
        }
      }, sseCfg.delayMs);
      const stop = () => clearInterval(timer);
      req.on('close', stop);
      res.on('close', stop);
    });
    server.on('connection', (socket) => {
      mockSockets.add(socket);
      socket.on('close', () => mockSockets.delete(socket));
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function waitFor(expr, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await cdp.eval(expr)) return true;
    } catch { /* 页面尚未就绪时继续轮询 */ }
    if (Date.now() > deadline) return false;
    await sleep(300);
  }
}

async function waitForCdpPage(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (childExited) throw new Error(`Electron 提前退出\n${childLog.slice(-2000)}`);
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      if (res.ok) {
        const targets = await res.json();
        const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
        if (page && page.webSocketDebuggerUrl) return page;
      }
    } catch { /* 端口未就绪 */ }
    if (Date.now() > deadline) throw new Error(`等待 CDP 端口 ${CDP_PORT} 超时\n${childLog.slice(-2000)}`);
    await sleep(500);
  }
}

function killApp() {
  if (!child || childExited) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch { /* 忽略 */ }
  }
}

async function cleanup() {
  // 还原本机 localStorage 里的方案参照开关（与本应用默认值等价，但保持原样）
  if (cdp) {
    try {
      if (origPlanReviewEnabled === null) {
        await cdp.eval(`localStorage.removeItem('planReviewEnabled')`);
      } else {
        await cdp.eval(`localStorage.setItem('planReviewEnabled', ${JSON.stringify(origPlanReviewEnabled)})`);
      }
    } catch { /* 忽略 */ }
    cdp.close();
  }
  killApp();
  await sleep(1500);
  if (child && !childExited) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch { /* 忽略 */ }
  }
  // 恢复用户真实设置文件（冒烟期间写入过标志性 customPrompt 并切到 mock 后端）
  if (settingsTouched) {
    try {
      if (origSettingsRaw === null) fs.rmSync(settingsFile, { force: true });
      else fs.writeFileSync(settingsFile, origSettingsRaw, 'utf8');
    } catch { /* 忽略 */ }
  }
  // 清掉本次运行写入的评审历史（按临时仓库路径）
  try {
    const histFile = path.join(userData, 'review-history.json');
    const all = JSON.parse(fs.readFileSync(histFile, 'utf8'));
    if (all && typeof all === 'object' && Object.prototype.hasOwnProperty.call(all, repo)) {
      delete all[repo];
      fs.writeFileSync(histFile, JSON.stringify(all, null, 2), 'utf8');
    }
  } catch { /* 忽略 */ }
  // 关闭 mock SSE 服务（先销毁 keep-alive 连接）
  if (mockServer) {
    try {
      for (const socket of mockSockets) socket.destroy();
      mockServer.close();
    } catch { /* 忽略 */ }
  }
  try {
    fs.rmSync(plansHashDir, { recursive: true, force: true });
  } catch { /* 忽略 */ }
  // 清掉本次运行写入「最近项目」的临时仓库路径
  try {
    const recentsFile = path.join(userData, 'recent-projects.json');
    const recents = JSON.parse(fs.readFileSync(recentsFile, 'utf8'));
    if (Array.isArray(recents) && recents.includes(repo)) {
      fs.writeFileSync(recentsFile, JSON.stringify(recents.filter((p) => p !== repo), null, 2));
    }
  } catch { /* 忽略 */ }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch { /* 忽略 */ }
}

async function main() {
  // ① 临时 git 仓库：提交后再制造未提交改动（含 Service 类改动）
  createTestRepo();
  check('准备临时 git 测试仓库（含类/Service 改动）', fs.existsSync(path.join(repo, '.git')));

  // 防止上次失败残留
  fs.rmSync(plansHashDir, { recursive: true, force: true });

  // ② 启动 Electron（detached 成独立进程组，便于整体 kill）
  child = spawn(
    'npx',
    ['--no-install', 'electron', '.', `--remote-debugging-port=${CDP_PORT}`, repo],
    { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.on('exit', () => {
    childExited = true;
  });
  child.stdout.on('data', (d) => {
    childLog += d.toString();
  });
  child.stderr.on('data', (d) => {
    childLog += d.toString();
  });

  const page = await waitForCdpPage(60_000);
  check('Electron 启动并暴露 CDP 端口', true);

  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');

  const booted = await waitFor(
    `document.readyState === 'complete' && !!window.autoReview && ` +
    `document.querySelectorAll('#tab-bar .tab-btn').length === 6`,
    30_000,
  );
  check('渲染进程就绪（autoReview 桥接可用）', booted);
  if (!booted) throw new Error('渲染进程未就绪，终止后续断言');

  // 固定开启「评审时参照方案」，避免本机 localStorage 残留状态影响断言（结束时还原）
  origPlanReviewEnabled = await cdp.eval(`localStorage.getItem('planReviewEnabled')`);
  await cdp.eval(`localStorage.setItem('planReviewEnabled', '1')`);

  // ③ 黑盒断言：6 个 tab 按钮
  const titles = await cdp.eval(
    `[...document.querySelectorAll('#tab-bar .tab-btn')].map((b) => b.textContent.trim()).join('|')`,
  );
  check('6 个 tab 按钮渲染（改动总览/多角度 Review/逐句解析/完整讲解/AI 设置/需求方案）',
    titles === EXPECTED_TABS.join('|'), `实际：${titles}`);

  const folderShown = await waitFor(
    `document.getElementById('project-path').textContent === ${JSON.stringify(repo)}`,
  );
  check('按命令行参数自动加载项目', folderShown);

  // 改动总览列出改动文件（含类识别）
  const filesListed = await waitFor(
    `document.querySelectorAll('.tab-panel[data-tab-id="overview"] .file-item').length >= 3`,
  );
  const fileNames = filesListed
    ? await cdp.eval(
        `[...document.querySelectorAll('.tab-panel[data-tab-id="overview"] .file-item .file-name')]` +
        `.map((n) => n.textContent).sort().join('|')`,
      )
    : '';
  check('改动总览列出全部改动文件',
    fileNames === EXPECTED_FILES.join('|'), `实际：${fileNames || '（无文件项）'}`);
  const hasClassChip = await cdp.eval(
    `[...document.querySelectorAll('.tab-panel[data-tab-id="overview"] .class-chip')]` +
    `.some((c) => c.textContent.includes('UserService'))`,
  );
  check('改动总览识别受影响的类（UserService）', !!hasClassChip);

  // 需求方案 tab：DOM.setFileInputFiles 上传 PRD 创建方案
  await cdp.eval(`document.querySelector('#tab-bar .tab-btn[data-tab-id="plan"]').click()`);
  const planMounted = await waitFor(
    `!!document.querySelector('.tab-panel[data-tab-id="plan"] input[accept=".md,.markdown,.txt"]')`,
  );
  check('需求方案 tab 渲染', planMounted);

  const doc = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await cdp.send('DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: '.tab-panel[data-tab-id="plan"] input[accept=".md,.markdown,.txt"]',
  });
  await cdp.send('DOM.setFileInputFiles', { nodeId, files: [prdPath] });

  const created = await waitFor(
    `window.autoReview.listPlans(${JSON.stringify(repo)}).then((l) => l.length === 1)`,
    15_000,
  );
  const plans = created ? await cdp.eval(`window.autoReview.listPlans(${JSON.stringify(repo)})`) : [];
  check('上传 PRD 创建方案（listPlans 返回 1 条）', created && plans.length === 1);
  const cardOk = await waitFor(
    `[...document.querySelectorAll('.tab-panel[data-tab-id="plan"] .plan-card-title')]` +
    `.some((t) => t.textContent.includes('smoke-prd'))`,
  );
  check('需求方案列表展示新方案', cardOk);
  if (!plans.length) throw new Error('方案创建失败，终止后续断言');

  // 往 userData plans 目录直接写入带 plan.md 的方案并设为当前方案
  const planId = plans[0].id;
  const pdir = path.join(plansHashDir, planId);
  fs.writeFileSync(path.join(pdir, 'plan.md'), '# 演示技术方案\n\n- 使用内存缓存用户数据\n', 'utf8');
  const metaPath = path.join(pdir, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  meta.hasPlan = true;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  fs.writeFileSync(path.join(plansHashDir, 'active.json'), JSON.stringify({ planId }), 'utf8');
  const active = await cdp.eval(`window.autoReview.getActivePlan(${JSON.stringify(repo)})`);
  check('磁盘写入带 plan.md 的方案并 setActivePlan',
    !!(active && active.planMarkdown && active.planMarkdown.includes('演示技术方案')));

  // 多角度 Review tab：参照方案提示条 + 需求符合度 chip
  await cdp.eval(`document.querySelector('#tab-bar .tab-btn[data-tab-id="review"]').click()`);
  const hintOk = await waitFor(
    `document.querySelector('.tab-panel[data-tab-id="review"]').innerText.includes('参照方案')`,
    15_000,
  );
  check('多角度 Review 显示「参照方案」提示条', hintOk);
  const chipOk = await waitFor(
    `[...document.querySelectorAll('.tab-panel[data-tab-id="review"] .review-chip')]` +
    `.some((c) => c.textContent.trim() === '需求符合度')`,
  );
  check('多角度 Review 出现「需求符合度」chip', chipOk);

  // ---------- 扩面①：设置保存往返（操作用户真实设置文件，cleanup 里按原始字节恢复） ----------
  origSettings = await cdp.eval('window.autoReview.getSettings()');
  check('读取当前设置（getSettings 返回对象）', !!(origSettings && typeof origSettings === 'object'));
  const marker = `smoke-marker-${Date.now()}`;
  await cdp.eval(`window.autoReview.saveSettings(${JSON.stringify({ customPrompt: marker })})`);
  settingsTouched = true;
  const reread = await cdp.eval('window.autoReview.getSettings()');
  check('设置保存往返：saveSettings 写入标志性 customPrompt 后读回一致',
    !!(reread && reread.customPrompt === marker), `实际：${reread && reread.customPrompt}`);
  const origPrompt = (origSettings && origSettings.customPrompt) || '';
  await cdp.eval(`window.autoReview.saveSettings(${JSON.stringify({ customPrompt: origPrompt })})`);
  const restored = await cdp.eval('window.autoReview.getSettings()');
  check('设置保存往返：恢复原始 customPrompt',
    !!(restored && restored.customPrompt === origPrompt), `实际：${restored && restored.customPrompt}`);

  // ---------- 扩面②：暂停/继续/终止（本地 mock SSE + 临时切 api 后端） ----------
  mockServer = await startMockServer();
  const mockPort = mockServer.address().port;
  check('本地 mock SSE 服务启动（127.0.0.1 随机端口）', mockPort > 0);
  const mockSettings = {
    backend: 'api',
    baseUrl: `http://127.0.0.1:${mockPort}/v1`,
    apiKey: 'smoke-fake-key',
    model: 'smoke-model',
    reasoningEffort: '',
  };
  await cdp.eval(`window.autoReview.saveSettings(${JSON.stringify(mockSettings)})`);

  // 追加一个大文件改动并重新扫描，使整体分析分成多批（暂停只在批间生效）
  const bigLines = [];
  for (let i = 0; i < 260; i += 1) {
    bigLines.push(`export const bigConst${i} = 'smoke-padding-value-${i}-aaaaaaaaaaaaaaaaaaaa';`);
  }
  fs.writeFileSync(path.join(repo, 'src', 'bigModule.js'), `${bigLines.join('\n')}\n`);
  await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', metaKey: true }))`);
  const rescanned = await waitFor(
    `document.querySelectorAll('.tab-panel[data-tab-id="overview"] .file-item').length >= 4`,
    15_000,
  );
  check('新增大文件后重新扫描（改动 ≥4 个文件，整体分析将分批）', rescanned);
  if (!rescanned) throw new Error('重新扫描失败，终止后续断言');

  // 自建 chunk 计数器：渲染进程自己的监听在每次分析结束后会注销，续跑 chunk 只能靠它观察
  await cdp.eval(`window.__smokeChunks = { count: 0, text: '' };
window.__smokeUnsub = window.autoReview.onAiChunk(({ text }) => {
  if (typeof text === 'string' && text.length) {
    window.__smokeChunks.count += 1;
    window.__smokeChunks.text = text;
  }
});
'ok'`);
  await cdp.eval(`document.querySelector('.tab-panel[data-tab-id="review"] .btn.btn-primary').click()`);

  const firstChunk = await waitFor('window.__smokeChunks && window.__smokeChunks.count > 0', 20_000);
  check('mock SSE 流式输出到达（第一批文本出现）', firstChunk);
  if (!firstChunk) throw new Error('流式输出未到达，终止后续断言');
  const curRun = await cdp.eval('window.autoReview.getCurrentRun()');
  check('getCurrentRun 显示运行中（整体分析批次）',
    !!(curRun && !curRun.paused && curRun.kind === '整体分析'), `实际：${JSON.stringify(curRun)}`);

  const pauseAccepted = await cdp.eval('window.autoReview.pauseRun()');
  const pausedRun = await waitFor(
    'window.autoReview.getCurrentRun().then((r) => !!(r && r.paused))', 20_000);
  check('pauseRun 后进入暂停态（getCurrentRun.paused）', !!(pauseAccepted && pausedRun),
    `pauseAccepted=${pauseAccepted} paused=${pausedRun}`);
  if (!pausedRun) throw new Error('暂停未生效，终止后续断言');
  const pausedHint = await cdp.eval(
    `document.querySelector('.tab-panel[data-tab-id="review"]').innerText.includes('已暂停')`);
  check('暂停后界面提示「已暂停」', !!pausedHint);
  const countAtPause = await cdp.eval('window.__smokeChunks.count');
  await sleep(1500);
  const countAfterWait = await cdp.eval('window.__smokeChunks.count');
  check('暂停后流式文本停止增长', countAtPause === countAfterWait,
    `chunk 数 ${countAtPause} → ${countAfterWait}`);

  await cdp.eval(`window.__smokeResume = window.autoReview.resumeRun()
  .then(() => ({ ok: true }), (err) => ({ ok: false, msg: String((err && err.message) || err) }));
'ok'`);
  const grewAfterResume = await waitFor(`window.__smokeChunks.count > ${countAfterWait}`, 20_000);
  check('resumeRun 后文本继续增长', grewAfterResume);
  if (!grewAfterResume) throw new Error('继续运行无输出，终止后续断言');
  const cancelAccepted = await cdp.eval('window.autoReview.cancelRun()');
  const resumeResult = await cdp.eval('window.__smokeResume');
  check('cancelRun 终止运行并报「已被用户终止」',
    !!(cancelAccepted && resumeResult && resumeResult.ok === false
      && resumeResult.msg.includes('已被用户终止')),
    `cancelAccepted=${cancelAccepted} 结果：${JSON.stringify(resumeResult)}`);
  let alive = false;
  try {
    alive = (await cdp.eval('document.readyState')) === 'complete';
  } catch { /* 渲染进程崩溃 */ }
  check('终止后渲染进程未崩溃', alive);
  await cdp.eval(`window.__smokeUnsub && window.__smokeUnsub(); 'ok'`);

  // ---------- 扩面③：导出 HTML（原生保存对话框自动化够不到，验证结果渲染与导出按钮可用） ----------
  sseCfg.chunks = 8;
  sseCfg.delayMs = 25;
  await cdp.eval(`document.querySelector('.tab-panel[data-tab-id="review"] .btn.btn-primary').click()`);
  const exportReady = await waitFor(
    `document.querySelectorAll('.tab-panel[data-tab-id="review"] .export-group').length >= 1`,
    30_000,
  );
  const exportBtns = exportReady
    ? await cdp.eval(
        `[...document.querySelectorAll('.tab-panel[data-tab-id="review"] .export-group button')]` +
        `.map((b) => b.textContent.trim() + (b.disabled ? ':disabled' : '')).join('|')`,
      )
    : '';
  check('分析完成后导出按钮齐全且可点击（导出 Markdown/复制/导出 HTML）',
    exportBtns === '导出 Markdown|复制|导出 HTML', `实际：${exportBtns || '（无导出按钮）'}`);
  const resultHtml = await cdp.eval(
    `(document.querySelector('.tab-panel[data-tab-id="review"] .review-result') || {}).innerHTML`);
  check('评审结果已渲染为 HTML（导出内容来源非空）', !!(resultHtml && resultHtml.length > 0));
}

const watchdog = setTimeout(() => {
  console.error('FAIL  全局超时（180s）');
  cleanup().finally(() => process.exit(1));
}, OVERALL_TIMEOUT_MS);

process.on('SIGINT', () => {
  cleanup().finally(() => process.exit(130));
});

main()
  .catch((err) => {
    console.error(`FAIL  执行异常：${err.message}`);
    results.push(false);
  })
  .finally(async () => {
    clearTimeout(watchdog);
    await cleanup();
    const failedCount = results.filter((r) => !r).length;
    console.log(`\n${results.length - failedCount}/${results.length} 项通过`);
    process.exit(failedCount ? 1 : 0);
  });

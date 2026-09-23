// 冒烟测试：临时 git 仓库 + 真实 Electron + CDP 黑盒断言，全程不触发 AI 调用
// 运行：npm run smoke（需要本机完整 node_modules，不适合 CI）
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
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

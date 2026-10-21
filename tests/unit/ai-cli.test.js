const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const cp = require('child_process');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const state = require('../../main/ai/state');
const control = require('../../main/ai/runControl');
const cli = require('../../main/ai/cli');

test('CLI 临时文件准备期间取消不会启动子进程', async (t) => {
  t.mock.method(fs, 'existsSync', () => true);
  let finishWrite;
  t.mock.method(fs, 'writeFile', (_file, _text, _options, callback) => { finishWrite = callback; });
  t.mock.method(fs, 'unlink', (_file, callback) => callback(null));
  const pending = cli.chatViaCli('codex', {}, [{ role: 'user', content: 'test' }], null, 'cancel-before-spawn');
  assert.equal(control.cancelRun('cancel-before-spawn'), true);
  finishWrite(null);
  await assert.rejects(pending, /已被用户终止/);
  assert.equal(cli.activeChildren.size, 0);
  state.lanes.clear();
});

test('CLI 参数上限按 macOS ARG_MAX 计算：整批中文不误拒，超限才拒绝', async (t) => {
  // 4 万字中文（约 120 KB）是一个整批评审的量级，此前 96 KiB 的阈值会误拒
  assert.equal(cli.exceedsArgLimit('字'.repeat(40_000), 'cmd', { HOME: '/Users/test' }), false);
  assert.equal(cli.exceedsArgLimit('字'.repeat(400_000), 'cmd', {}), true);
  // 环境变量与参数共享 ARG_MAX，环境越大可用于 prompt 的空间越小
  assert.equal(cli.exceedsArgLimit('a'.repeat(600_000), 'cmd', { BIG: 'x'.repeat(400_000) }), true);
  t.mock.method(fs, 'existsSync', () => true);
  await assert.rejects(cli.chatViaCli('opencode', {}, [{ content: '字'.repeat(400_000) }], null, 'large'), /改用 API 后端/);
  state.lanes.clear();
});

test('Codex stdin 文件重定向，增量预览剥离 ANSI，最终结果不变', async (t) => {
  const child = new EventEmitter();
  child.pid = 99999999;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  t.mock.method(cp, 'spawn', (file, args, options) => {
    assert.equal(file, '/bin/bash');
    assert.equal(options.detached, true);
    assert.match(args[1], / - < '/);
    assert.ok(!args[1].includes('$(cat'));
    assert.equal(options.env.HOME, process.env.HOME);
    return child;
  });
  delete require.cache[require.resolve('../../main/ai/cli')];
  const fakeCli = require('../../main/ai/cli');
  const previews = [];
  state.chunkSender = (id, text) => previews.push([id, text]);
  t.mock.method(fs, 'existsSync', () => true);
  t.mock.method(fs, 'writeFile', (_file, _text, _options, callback) => setImmediate(() => callback(null)));
  t.mock.method(fs, 'unlink', (_file, callback) => callback(null));
  const pending = fakeCli.chatViaCli('codex', {}, [{ content: 'private prompt' }], null, 'preview');
  await new Promise(setImmediate);
  child.stdout.write('\x1b[31mfirst');
  child.stdout.write(' second\x1b[0m\n');
  await new Promise(setImmediate);
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  assert.equal(await pending, '\x1b[31mfirst second\x1b[0m');
  assert.deepEqual(previews.at(-1), ['preview', 'first second\n']);
  assert.equal(fakeCli.activeChildren.size, 0);
  state.lanes.clear(); state.chunkSender = null;
  delete require.cache[require.resolve('../../main/ai/cli')];
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (check, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return check();
};

// 复现卡死：后台孙进程继承输出管道并长时间运行，旧实现取消/超时后永远等不到结束
const HOLDER = 'sleep 300 & echo "grandchild=$!"; echo "partial output"; sleep 300';

test('runBash 取消时整组终止，孙进程占着管道也立即返回', async () => {
  const run = cli.runBash(HOLDER, { maxBuffer: 1024 * 1024, timeoutMs: 60_000 });
  let out = '';
  run.child.stdout.on('data', (c) => { out += c; });
  assert.ok(await waitFor(() => /grandchild=\d+/.test(out)));
  const grandchild = Number(out.match(/grandchild=(\d+)/)[1]);
  const bashPid = run.child.pid;
  const pgid = Number(cp.execFileSync('ps', ['-o', 'pgid=', '-p', String(bashPid)], { encoding: 'utf8' }).trim());
  assert.equal(pgid, bashPid, 'bash 必须自成进程组，否则无法整组终止');
  const started = Date.now();
  run.cancel();
  await assert.rejects(run.promise, (err) => err.kind === 'cancelled' && err.stdout.includes('partial output'));
  assert.ok(Date.now() - started < 1000, '取消后应立即结束等待');
  assert.ok(await waitFor(() => !alive(grandchild) && !alive(bashPid)), '孙进程与 bash 都应被终止');
});

test('runBash 超时时整组终止并以 timeout 结束', async () => {
  const run = cli.runBash(HOLDER, { maxBuffer: 1024 * 1024, timeoutMs: 300 });
  let out = '';
  run.child.stdout.on('data', (c) => { out += c; });
  await assert.rejects(run.promise, (err) => err.kind === 'timeout');
  const grandchild = Number((out.match(/grandchild=(\d+)/) || [])[1]);
  assert.ok(await waitFor(() => !alive(run.child.pid) && (!grandchild || !alive(grandchild))));
});

test('runBash 正常退出后残留后台进程占管道，也能收尾并清掉残留', async () => {
  const run = cli.runBash('sleep 300 & echo "bg=$!"; echo done', { maxBuffer: 1024 * 1024, timeoutMs: 60_000 });
  const { stdout } = await run.promise;
  assert.match(stdout, /done/);
  const bg = Number(stdout.match(/bg=(\d+)/)[1]);
  assert.ok(await waitFor(() => !alive(bg)), '残留后台进程应被清理');
});

test('runBash 非零退出码与输出超限', async () => {
  await assert.rejects(cli.runBash('echo oops >&2; exit 3', { maxBuffer: 1024, timeoutMs: 60_000 }).promise,
    (err) => err.kind === 'exit' && err.code === 3 && err.stderr.includes('oops'));
  await assert.rejects(cli.runBash('head -c 5000 /dev/zero; sleep 300', { maxBuffer: 1024, timeoutMs: 60_000 }).promise,
    (err) => err.kind === 'maxBuffer');
  assert.deepEqual((await cli.runBash('printf ok', { maxBuffer: 1024, timeoutMs: 60_000 }).promise).stdout, 'ok');
});

test('退出清理注册进程组，TERM 后 3 秒 KILL', async (t) => {
  t.mock.timers.enable(['setTimeout']);
  const signals = [];
  t.mock.method(process, 'kill', (pid, signal) => { signals.push([pid, signal]); return true; });
  const child = new EventEmitter(); child.pid = 123456;
  cli.registerChild(child);
  const cleanup = cli.terminateActiveChildren();
  assert.deepEqual(signals, [[-123456, 'SIGTERM']]);
  t.mock.timers.tick(3000);
  await cleanup;
  assert.deepEqual(signals.at(-1), [-123456, 'SIGKILL']);
  assert.equal(cli.activeChildren.size, 0);
});

test('chatViaCli 运行中点「终止运行」：立即报已终止，CLI 及其孙进程全部退出', async (t) => {
  const realSpawn = cp.spawn;
  t.mock.method(cp, 'spawn', (file, args, options) => realSpawn(file, ['-c', HOLDER], options));
  delete require.cache[require.resolve('../../main/ai/cli')];
  const fakeCli = require('../../main/ai/cli');
  t.mock.method(fs, 'existsSync', () => true);
  const pending = fakeCli.chatViaCli('opencode', {}, [{ content: 'prompt' }], null, 'stop-me');
  assert.ok(await waitFor(() => fakeCli.activeChildren.size === 1));
  const [child] = [...fakeCli.activeChildren];
  await waitFor(() => false, 300);
  const started = Date.now();
  assert.equal(control.cancelRun('stop-me'), true);
  await assert.rejects(pending, /已被用户终止/);
  assert.ok(Date.now() - started < 1000);
  const groupAlive = () => { try { process.kill(-child.pid, 0); return true; } catch { return false; } };
  assert.ok(await waitFor(() => !groupAlive()), '整个进程组都应退出');
  state.lanes.clear();
  delete require.cache[require.resolve('../../main/ai/cli')];
});

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
  const original = cp.execFile;
  const child = new EventEmitter();
  child.pid = 99999999;
  child.stdout = new PassThrough();
  child.kill = () => true;
  let done;
  t.mock.method(cp, 'execFile', (cmd, options, callback) => {
    assert.match(cmd, / - < '/);
    assert.ok(!cmd.includes('$(cat'));
    assert.equal(options.env.HOME, process.env.HOME);
    done = callback;
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
  child.stdout.write(' second\x1b[0m');
  done(null, '\x1b[31mfirst second\x1b[0m\n', '');
  child.emit('close');
  assert.equal(await pending, '\x1b[31mfirst second\x1b[0m');
  assert.deepEqual(previews.at(-1), ['preview', 'first second']);
  assert.equal(fakeCli.activeChildren.size, 0);
  state.lanes.clear(); state.chunkSender = null;
  cp.execFile = original;
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

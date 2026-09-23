const state = require('./state');

// 当前正在进行的 AI 调用（供渲染进程「运行详情」轮询预览）
function getCurrentRun() {
  if (state.currentRun) return state.currentRun;
  if (state.pausedState) {
    return {
      paused: true,
      kind: state.pausedState.kind,
      batch: `已暂停，第 ${state.pausedState.nextIndex}/${state.pausedState.batches.length} 批`,
      batchIndex: state.pausedState.nextIndex,
      batchTotal: state.pausedState.batches.length,
      startedAt: state.pausedState.pausedAt,
    };
  }
  return null;
}

// 暂停/继续：分批循环每批开始前检查 pauseRequested，暂停时把续跑状态存进 pausedState
function pauseRun() {
  state.pauseRequested = true;
  return state.batchRunActive;
}

// 终止当前运行：API 中断 fetch，CLI 杀进程组；同时清掉暂停状态
function cancelRun() {
  state.pausedState = null;
  state.pauseRequested = false;
  if (state.currentCancel) {
    state.currentCancel();
    state.currentCancel = null;
    return true;
  }
  return false;
}

// 流式输出的推送方：main.js 注册，fn(runId, 累计文本) 转发给渲染进程
function setChunkSender(fn) {
  state.chunkSender = typeof fn === 'function' ? fn : null;
}

function cancelledError() {
  const err = new Error('已被用户终止');
  err.cancelled = true;
  return err;
}

function killProcessGroup(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
  }
}

// 请求超时（分钟），默认 10，可在设置里调大；慢模型/大批量评审需要更久
function timeoutMs(cfg) {
  const min = Number(cfg && cfg.timeoutMin);
  return (min > 0 ? min : 10) * 60_000;
}

module.exports = { getCurrentRun, pauseRun, cancelRun, setChunkSender, cancelledError, killProcessGroup, timeoutMs };

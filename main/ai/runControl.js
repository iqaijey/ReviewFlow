const state = require('./state');

// runId 规范化：渲染进程传入的非空 runId 直接沿用（其 chunk 过滤依赖该 id），
// 未传或与活跃跑道冲突时由主进程生成唯一 id
let runSeq = 0;
function ensureRunId(runId) {
  if (typeof runId === 'string' && runId && !state.lanes.has(runId)) return runId;
  let id;
  do {
    runSeq += 1;
    id = `${typeof runId === 'string' && runId ? runId : 'run'}-${Date.now()}-${runSeq}`;
  } while (state.lanes.has(id));
  return id;
}

// 取或建跑道（登记运行用）
function ensureLane(runId) {
  let lane = state.lanes.get(runId);
  if (!lane) {
    lane = {
      currentRun: null,
      currentCancel: null,
      pauseRequested: false,
      pausedState: null,
      batchRunActive: false,
      lastActive: Date.now(),
    };
    state.lanes.set(runId, lane);
  }
  return lane;
}

// 控制操作定位跑道：带 runId 精确命中；缺省时回退到最近活跃的跑道（兼容无参调用）
function resolveLane(runId) {
  if (typeof runId === 'string' && runId) return state.lanes.get(runId) || null;
  let latest = /** @type {import('./state').RunLane | null} */ (null);
  for (const lane of state.lanes.values()) {
    if (!latest || lane.lastActive > latest.lastActive) latest = lane;
  }
  return latest;
}

// 跑道完全空闲（无运行/无取消句柄/无暂停态/非分批）时回收，避免 Map 泄漏
function maybeCleanupLane(runId) {
  const lane = state.lanes.get(runId);
  if (lane && !lane.currentRun && !lane.currentCancel && !lane.pausedState && !lane.batchRunActive) {
    state.lanes.delete(runId);
  }
}

// 单条跑道的对外展示态：运行中 > 已暂停 > 批间占位（与旧单跑道 getCurrentRun 分支顺序一致）
function runInfoFor(lane, runId) {
  if (lane.currentRun) return { ...lane.currentRun, runId };
  if (lane.pausedState) {
    return {
      paused: true,
      runId,
      kind: lane.pausedState.kind,
      batch: `已暂停，第 ${lane.pausedState.nextIndex}/${lane.pausedState.batches.length} 批`,
      batchIndex: lane.pausedState.nextIndex,
      batchTotal: lane.pausedState.batches.length,
      startedAt: lane.pausedState.pausedAt,
    };
  }
  // 分批循环的批间微间隙：上一批 currentRun 已清空、下一批尚未登记。
  // 返回占位运行态，避免「运行详情」轮询在这一瞬落入「无运行」分支并停掉刷新。
  if (lane.batchRunActive) {
    return {
      kind: '分批运行',
      batch: '批间切换中，自动连续执行，无需操作…',
      backend: '',
      model: '',
      effort: '',
      command: '',
      promptChars: 0,
      promptText: '',
      startedAt: Date.now(),
      batchIndex: null,
      batchTotal: null,
      runId,
    };
  }
  return null;
}

// 全部跑道的展示态（最近活跃在前）
function getRuns() {
  const out = [];
  for (const [runId, lane] of state.lanes) {
    const info = runInfoFor(lane, runId);
    if (info) out.push({ lastActive: lane.lastActive, info });
  }
  out.sort((a, b) => b.lastActive - a.lastActive);
  return out.map((x) => x.info);
}

// 兼容旧接口：返回最近活跃的一条运行（或 null）
function getCurrentRun() {
  const runs = getRuns();
  return runs.length ? runs[0] : null;
}

// 暂停/继续：分批循环每批开始前检查 pauseRequested，暂停时把续跑状态存进 pausedState
function pauseRun(runId) {
  const lane = resolveLane(runId);
  if (!lane) return false;
  lane.pauseRequested = true;
  return lane.batchRunActive;
}

// 终止指定运行：API 中断 fetch，CLI 杀进程组；同时清掉该跑道的暂停状态
function cancelRun(runId) {
  const lane = resolveLane(runId);
  if (!lane) return false;
  lane.pausedState = null;
  lane.pauseRequested = false;
  if (lane.currentCancel) {
    lane.currentCancel();
    lane.currentCancel = null;
    return true;
  }
  if (typeof runId === 'string' && runId) maybeCleanupLane(runId);
  return false;
}

// 流式输出的推送方：main.js 注册，fn(runId, 累计文本) 转发给渲染进程
function setChunkSender(fn) {
  state.chunkSender = typeof fn === 'function' ? fn : null;
}

function cancelledError() {
  const err = /** @type {Error & { cancelled: boolean }} */ (new Error('已被用户终止'));
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

// 跑道活跃时间戳更新点：登记运行详情、进入暂停、分批激活时调用
function touchLane(lane) {
  lane.lastActive = Date.now();
}

module.exports = {
  ensureRunId,
  ensureLane,
  resolveLane,
  maybeCleanupLane,
  touchLane,
  getRuns,
  getCurrentRun,
  pauseRun,
  cancelRun,
  setChunkSender,
  cancelledError,
  killProcessGroup,
  timeoutMs,
};

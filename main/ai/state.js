// AI 调用共享状态：按 runId 的多跑道（Map），每条跑道独立维护
// currentRun（运行详情）/ 取消句柄 / 暂停请求 / 续跑状态 / 分批激活标记，
// 支持多个 AI 分析并发运行、互不干扰。chunkSender 全局唯一（单窗口，渲染进程按 runId 过滤）。

/**
 * 暂停时保存的分批续跑状态（runOverviewBatches / runFullBatches 的循环上下文）
 * @typedef {object} PausedBatchState
 * @property {string} kind
 * @property {number} nextIndex
 * @property {any[][]} batches
 * @property {number} [pausedAt]
 * @property {string} [folder]
 * @property {string} [system]
 * @property {string|null} [runId]
 * @property {string} [planContext]
 * @property {string} [pendingText]
 * @property {string[]} [batchResults]
 * @property {string[]} [parts]
 * @property {any[]} [statsList]
 */

/**
 * 单条跑道（一个 runId 一次完整运行，可能跨多个分批调用）
 * @typedef {object} RunLane
 * @property {any} currentRun
 * @property {null | (() => void)} currentCancel
 * @property {boolean} pauseRequested
 * @property {PausedBatchState | null} pausedState
 * @property {boolean} batchRunActive
 * @property {number} lastActive
 */

/** @type {{
 *   lanes: Map<string, RunLane>,
 *   chunkSender: null | ((runId: any, text: string) => void),
 * }}
 */
module.exports = {
  lanes: new Map(),
  chunkSender: null,
};

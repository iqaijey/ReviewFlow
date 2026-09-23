// AI 调用共享状态：currentRun（运行详情）、暂停/续跑、取消句柄、流式推送方。
// 单一可变对象，runControl / cli / backends / ai 编排层共同读写，避免循环依赖。

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

/** @type {{
 *   currentRun: any,
 *   pauseRequested: boolean,
 *   pausedState: PausedBatchState | null,
 *   batchRunActive: boolean,
 *   currentCancel: null | (() => void),
 *   chunkSender: null | ((runId: any, text: string) => void),
 * }}
 */
module.exports = {
  currentRun: null,
  pauseRequested: false,
  pausedState: null,
  batchRunActive: false,
  currentCancel: null,
  chunkSender: null,
};

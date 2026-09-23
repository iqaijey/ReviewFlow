// AI 调用共享状态：currentRun（运行详情）、暂停/续跑、取消句柄、流式推送方。
// 单一可变对象，runControl / cli / backends / ai 编排层共同读写，避免循环依赖。
module.exports = {
  currentRun: null,
  pauseRequested: false,
  pausedState: null,
  batchRunActive: false,
  currentCancel: null,
  chunkSender: null,
};

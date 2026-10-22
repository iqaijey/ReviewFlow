// 外部 Agent 调用分发：参数映射、长任务登记与等待、改动后通知界面刷新
const { randomUUID } = require('crypto');
const { TOOL_MAP } = require('./catalog');

const DEFAULT_WAIT_SEC = 50;
const MAX_WAIT_SEC = 600;
const MAX_JOBS = 100;
const JOB_RETENTION_MS = 60 * 60 * 1000;

/** @typedef {import('./catalog').ToolDef} ToolDef */
/** @typedef {{ jobId: string, tool: string, runId: string | null, state: 'running' | 'done' | 'error', startedAt: number, finishedAt: number | null, result: unknown, error: string | null, promise: Promise<void> }} Job */

class ToolError extends Error {
  /** @param {string} message @param {number} status */
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {ToolDef} tool
 * @param {Record<string, any>} input
 */
function buildArgs(tool, input) {
  if (tool.args === undefined || tool.args === 'payload') return [input];
  return tool.args.map((arg) => {
    if (!Array.isArray(arg)) return input[arg];
    const picked = Object.fromEntries(arg.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
    return Object.keys(picked).length ? picked : undefined;
  });
}

/** @param {unknown} value */
function clampWait(value) {
  const sec = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_WAIT_SEC;
  return Math.min(Math.max(sec, 0), MAX_WAIT_SEC);
}

/**
 * @param {{
 *   invoke: (channel: string, args: unknown[]) => Promise<unknown>,
 *   composites: Record<string, (input: Record<string, any>) => Promise<unknown> | unknown>,
 *   notify: (change: { tool: string, folder: string | null, scopes: string[] }) => void,
 * }} deps
 */
function createDispatcher({ invoke, composites, notify }) {
  /** @type {Map<string, Job>} */
  const jobs = new Map();

  function pruneJobs() {
    const now = Date.now();
    for (const [jobId, job] of jobs) {
      if (job.finishedAt !== null && now - job.finishedAt > JOB_RETENTION_MS) jobs.delete(jobId);
    }
    const finished = [...jobs.values()].filter((job) => job.finishedAt !== null).sort((a, b) => Number(a.finishedAt) - Number(b.finishedAt));
    while (jobs.size > MAX_JOBS && finished.length) jobs.delete(/** @type {Job} */ (finished.shift()).jobId);
  }

  /** @param {Job} job */
  function describe(job) {
    if (job.state === 'error') throw new ToolError(job.error || '任务失败', 400);
    if (job.state === 'done') return job.result === undefined ? null : job.result;
    return { state: 'running', jobId: job.jobId, runId: job.runId, tool: job.tool, elapsedSec: Math.round((Date.now() - job.startedAt) / 1000),
      hint: '任务仍在运行：调用 agent_waitJob 继续等待，或用 ai_cancel 终止' };
  }

  /** @param {Job} job @param {number} sec */
  async function waitFor(job, sec) {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    await Promise.race([job.promise, new Promise((resolve) => { timer = setTimeout(resolve, sec * 1000); })]);
    clearTimeout(timer);
    return describe(job);
  }

  /** @param {ToolDef} tool @param {Record<string, any>} input */
  function changed(tool, input) {
    if (!tool.scopes || !tool.scopes.length) return;
    notify({ tool: tool.name, folder: typeof input.folder === 'string' ? input.folder : null, scopes: tool.scopes });
  }

  const builtins = {
    /** @param {Record<string, any>} input */
    agent_waitJob: (input) => {
      const job = jobs.get(String(input.jobId || ''));
      if (!job) throw new ToolError('任务不存在或已过期（任务只在应用本次运行期间保留）', 404);
      return waitFor(job, clampWait(input.waitSec));
    },
    agent_listJobs: () => [...jobs.values()].map((job) => ({ jobId: job.jobId, runId: job.runId, tool: job.tool, state: job.state,
      startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error })),
  };

  /**
   * @param {string} name
   * @param {unknown} rawInput
   */
  async function callTool(name, rawInput) {
    const tool = TOOL_MAP.get(name);
    if (!tool) throw new ToolError(`未知工具：${name}`, 404);
    if (rawInput !== undefined && rawInput !== null && (typeof rawInput !== 'object' || Array.isArray(rawInput))) {
      throw new ToolError('参数必须是 JSON 对象', 400);
    }
    if (Object.hasOwn(builtins, name)) return builtins[/** @type {keyof typeof builtins} */ (name)](/** @type {Record<string, any>} */ (rawInput || {}));
    const { waitSec, ...rest } = /** @type {Record<string, any>} */ (rawInput || {});
    /** @type {Record<string, any>} */
    let input = { ...rest };
    for (const key of tool.autoIds || []) {
      if (typeof input[key] !== 'string' || !input[key]) input[key] = `agent-${randomUUID()}`;
    }
    if (tool.prepare) input = tool.prepare(input);
    const run = async () => {
      if (tool.channel) return invoke(tool.channel, buildArgs(tool, input));
      const handler = composites[tool.name];
      if (!handler) throw new ToolError(`工具未实现：${name}`, 501);
      return handler(input);
    };
    if (!tool.long) {
      const result = await run();
      changed(tool, input);
      return result === undefined ? null : result;
    }
    const runId = typeof input.runId === 'string' ? input.runId : null;
    const jobId = runId || `job-${randomUUID()}`;
    if (jobs.get(jobId)?.state === 'running') throw new ToolError(`runId ${jobId} 的任务仍在运行，请用 agent_waitJob 等待`, 409);
    /** @type {Job} */
    const job = { jobId, tool: name, runId, state: 'running', startedAt: Date.now(), finishedAt: null, result: undefined, error: null,
      promise: Promise.resolve() };
    job.promise = run().then((result) => {
      job.state = 'done';
      job.result = result;
      changed(tool, input);
    }, (error) => {
      job.state = 'error';
      job.error = error instanceof Error ? error.message : String(error);
    }).finally(() => { job.finishedAt = Date.now(); });
    jobs.set(jobId, job);
    pruneJobs();
    return waitFor(job, clampWait(waitSec));
  }

  return { callTool };
}

module.exports = { createDispatcher, buildArgs, ToolError };

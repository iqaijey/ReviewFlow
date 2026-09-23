const state = require('./state');
const { timeoutMs, cancelledError } = require('./runControl');

// 解析 OpenAI 兼容的 SSE 流式响应：逐行读取 data: 事件，累加 delta.content，
// 每收到一段就把累计全文推给渲染进程；usage 取流末尾带 usage 的 chunk（stream_options.include_usage）
async function readSseStream(resp, runId) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage = {};
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (chunk && chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage;
      const delta = chunk && chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      const piece = delta && typeof delta.content === 'string' ? delta.content : '';
      if (piece) {
        content += piece;
        if (state.chunkSender && runId) state.chunkSender(runId, content);
      }
    }
  }
  if (!content) throw new Error('AI 返回格式异常，无法解析响应内容');
  return { content, usage };
}

// OpenAI 兼容 API 后端：reasoning_effort / temperature 不被支持（400）时去掉对应参数重试；
// stream 时走 SSE 逐段推送。返回最终生效的 appliedEffort 供 stats/运行详情使用。
async function chatViaApi(cfg, messages, { maxTokens, temperature, stream, runId }) {
  const url = `${String(cfg.baseUrl || '').replace(/\/+$/, '')}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  };
  let appliedEffort = cfg.reasoningEffort || '';
  const body = {
    model: cfg.model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (appliedEffort) body.reasoning_effort = appliedEffort;
  // 仅 API 分支支持流式；CLI 分支忽略该选项
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  const controller = new AbortController();
  state.currentCancel = () => controller.abort();
  const send = () => fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs(cfg)), controller.signal]),
  });
  try {
    let resp = await send();
    if (!resp.ok) {
      let detail = (await resp.text()).slice(0, 300);
      // 服务商不支持 reasoning_effort 时去掉重试
      if (resp.status === 400 && /reasoning/i.test(detail) && body.reasoning_effort) {
        delete body.reasoning_effort;
        appliedEffort = '';
        resp = await send();
        if (!resp.ok) detail = (await resp.text()).slice(0, 300);
      }
      // 部分模型（如 Kimi 思考模型）只允许 temperature=1，去掉该参数用服务商默认值重试
      if (resp.status === 400 && /temperature/i.test(detail) && 'temperature' in body) {
        delete body.temperature;
        resp = await send();
        if (!resp.ok) detail = (await resp.text()).slice(0, 300);
      }
      if (!resp.ok) {
        throw new Error(`AI 请求失败 (${resp.status}): ${detail || resp.statusText}`);
      }
    }
    if (stream) {
      const { content, usage } = await readSseStream(resp, runId);
      return { content, usage, appliedEffort };
    }
    const data = await resp.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : null;
    if (typeof content !== 'string') throw new Error('AI 返回格式异常，无法解析响应内容');
    const usage = data && data.usage ? data.usage : {};
    return { content, usage, appliedEffort };
  } catch (err) {
    if (controller.signal.aborted) throw cancelledError();
    throw err;
  }
}

module.exports = { readSseStream, chatViaApi };

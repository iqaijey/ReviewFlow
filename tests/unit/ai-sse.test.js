const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readSseStream } = require('../../main/ai/backends');
const event = (text) => JSON.stringify({ choices: [{ delta: { content: text } }] });

test('SSE 按事件分帧，多行 data、注释、其他字段和尾部事件', async () => {
  const data = `: comment\r\nevent: message\r\ndata: {"choices":\r\ndata: [{"delta":{"content":"你"}}]}\r\n\r\nid: 2\ndata: ${event('好')}\n\ndata: {"usage":{"prompt_tokens":7}}`;
  const bytes = Buffer.from(data);
  const body = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  assert.deepEqual(await readSseStream(new Response(body), 'sse'), { content: '你好', usage: { prompt_tokens: 7 } });
});
test('SSE DONE 忽略后续数据；无内容的损坏事件报明确错误', async () => {
  const response = new Response(`data: bad\n\ndata: ${event('ok')}\n\ndata: [DONE]\n\ndata: ${event('ignored')}\n\n`);
  assert.equal((await readSseStream(response, null)).content, 'ok');
  await assert.rejects(readSseStream(new Response('data: broken'), null), /1 个无效 JSON 事件/);
  await assert.rejects(readSseStream(new Response(': comment\n\n'), null), /无法解析/);
});

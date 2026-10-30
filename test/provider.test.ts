import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AnthropicProvider, parseSSE } from '../src/index.js';

test('SSE parser handles bytewise UTF-8, CRLF, comments and multiple frames', async () => {
  const bytes = new TextEncoder().encode(': ping\r\n\r\ndata: {"text":"中文"}\r\n\r\ndata: {"n":2}\n\n');
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const events = [];
  for await (const e of parseSSE(body)) events.push(e);
  assert.deepEqual(events, [{ text: '中文' }, { n: 2 }]);
});

test('Anthropic adapter serializes results and reconstructs fragmented tool input', async t => {
  let payload: Record<string, unknown> = {};
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/v1/messages');
    let body = '';
    for await (const chunk of req) body += chunk;
    payload = JSON.parse(body) as Record<string, unknown>;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'checking' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'new', name: 'read_file', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"README.md"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ];
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const provider = new AnthropicProvider({ apiKey: 'test-key', model: 'test-model', baseUrl: `http://127.0.0.1:${address.port}` });
  const events = [];
  for await (const event of provider.stream({ system: 'system', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: '', toolCalls: [{ id: 'old', name: 'read_file', input: {} }] }, { role: 'tool', callId: 'old', content: 'data', isError: false }], tools: [], signal: new AbortController().signal })) events.push(event);
  assert.deepEqual(events, [{ type: 'text', text: 'checking' }, { type: 'tool_call', call: { id: 'new', name: 'read_file', input: { path: 'README.md' } } }]);
  assert.equal(payload.model, 'test-model');
  assert.match(JSON.stringify(payload.messages), /tool_use_id/);
});

test('SSE parser refuses truncated frames', async () => {
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('data: {}')); c.close(); } });
  await assert.rejects(async () => { for await (const _ of parseSSE(body)) { /* consume */ } }, /Incomplete/);
});

test('HTTP errors expose status/retryability, never auto retry or leak response body', async t => {
  let status = 401;
  let requests = 0;
  const server = createServer((_req, res) => {
    requests++;
    res.writeHead(status);
    res.end('sensitive upstream diagnostic');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const provider = new AnthropicProvider({ apiKey: 'test-key', model: 'test-model', baseUrl: `http://127.0.0.1:${address.port}` });
  for (const [code, retryable] of [[401, false], [429, true], [503, true]] as const) {
    status = code;
    await assert.rejects(async () => {
      for await (const _ of provider.stream({ system: '', messages: [], tools: [], signal: new AbortController().signal })) {}
    }, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /sensitive/);
      assert.equal(Reflect.get(error, 'code'), 'MODEL_HTTP');
      assert.equal(Reflect.get(error, 'status'), code);
      assert.equal(Reflect.get(error, 'retryable'), retryable);
      return true;
    });
  }
  assert.equal(requests, 3);
});

test('broken network streams produce MODEL_NETWORK while malformed JSON is MODEL_PROTOCOL', async () => {
  const network = new ReadableStream<Uint8Array>({ start(c) { c.error(new Error('socket reset')); } });
  await assert.rejects(async () => { for await (const _ of parseSSE(network)) {} }, { code: 'MODEL_NETWORK' });
  const invalid = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('data: {broken}\n\n')); c.close(); } });
  await assert.rejects(async () => { for await (const _ of parseSSE(invalid)) {} }, { code: 'MODEL_PROTOCOL' });
});

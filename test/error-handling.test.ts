import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, mkdir, readdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentRuntime, parseSSE, saveSession, loadSession, validateHistory, type ModelProvider, type Tool } from '../src/index.js';
import { atomicReplace } from '../src/storage.js';

async function events(provider: ModelProvider, requestTimeoutMs = 1000) {
  const runtime = new AgentRuntime({ workspace: '.', provider, requestTimeoutMs });
  const output = [];
  for await (const event of runtime.run('hello')) output.push(event);
  return { output, runtime };
}

test('provider swallowing timeout must not commit a successful response', async () => {
  const { output, runtime } = await events({ async *stream({ signal }) {
    yield { type: 'text', text: 'partial' };
    try { await delay(1000, undefined, { signal }); } catch { /* cooperative provider stops quietly */ }
  } }, 10);
  assert.deepEqual(output.at(-1), { type: 'stop', reason: 'error' });
  assert.equal(runtime.history.length, 1);
  assert.equal(output.find(e => e.type === 'error')?.code, 'REQUEST_TIMEOUT');
});

test('empty model response is an error, not successful completion', async () => {
  const { output, runtime } = await events({ async *stream() {} });
  assert.deepEqual(output.at(-1), { type: 'stop', reason: 'error' });
  assert.equal(runtime.history.length, 1);
});

test('runtime rejects malformed provider events before corrupting history', async () => {
  const provider: ModelProvider = { async *stream() { yield JSON.parse('{"type":"tool_call","call":{"id":12,"input":{}}}'); } };
  const { output, runtime } = await events(provider);
  assert.deepEqual(output.at(-1), { type: 'stop', reason: 'error' });
  assert.equal(runtime.history.length, 1);
});

test('SSE rejects a complete oversized frame, not just incomplete buffers', async () => {
  const body = new ReadableStream<Uint8Array>({ start(c) {
    c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ text: 'x'.repeat(2_000_001) })}\n\n`));
    c.close();
  } });
  await assert.rejects(async () => { for await (const _ of parseSSE(body)) {} }, /too large/);
});

test('failed session rename cleans temporary files without replacing the target', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sato-error-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'session.json');
  await mkdir(target);
  await assert.rejects(saveSession(target, root, []));
  assert.deepEqual(await readdir(root), ['session.json']);
});

test('tool timeout and malformed return are classified without losing batch results', async () => {
  const tools: Tool[] = [
    { name: 'slow', description: '', inputSchema: {}, readOnly: true, parse: x => x, execute: async (_, { signal }) => { await delay(1000, undefined, { signal }); return 'unexpected'; } },
    { name: 'bad', description: '', inputSchema: {}, readOnly: true, parse: x => x, execute: async () => JSON.parse('null') },
  ];
  const provider: ModelProvider = { async *stream() {
    for (const name of ['slow', 'bad', 'missing']) yield { type: 'tool_call', call: { id: name, name, input: {} } };
  } };
  const runtime = new AgentRuntime({ workspace: '.', provider, tools, toolTimeoutMs: 10, maxTurns: 1 });
  for await (const _ of runtime.run('hello')) {}
  validateHistory(runtime.history);
  assert.deepEqual(runtime.history.filter(m => m.role === 'tool').map(m => m.error?.code), ['TOOL_TIMEOUT', 'TOOL_EXECUTION', 'TOOL_NOT_FOUND']);
});

test('cancelled replacement preserves original bytes and removes temporary data', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sato-atomic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'original');
  await writeFile(target, 'original data');
  await assert.rejects(atomicReplace(target, 'new data', { signal: AbortSignal.abort() }));
  assert.equal(await readFile(target, 'utf8'), 'original data');
  assert.deepEqual(await readdir(root), ['original']);
});

test('corrupt and missing session files expose SESSION_READ with original cause', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sato-load-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'session.json');
  await assert.rejects(loadSession(target, root), { code: 'SESSION_READ' });
  await writeFile(target, '{broken');
  await assert.rejects(loadSession(target, root), { code: 'SESSION_READ' });
});

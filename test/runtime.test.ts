import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime, fitContext, validateHistory, type Message, type ModelProvider, type Tool } from '../src/index.js';

const tool: Tool = { name: 'sample', description: '', inputSchema: {}, readOnly: true, parse: x => x, execute: async () => 'ok' };
function scripted(...batches: Array<Array<{ id: string; name: string; input: unknown }>>): ModelProvider {
  let index = 0;
  return { async *stream(request) {
    validateHistory(request.messages);
    const calls = batches[index++] ?? [];
    for (const call of calls) yield { type: 'tool_call', call };
    if (!calls.length) yield { type: 'text', text: 'done' };
  } };
}
const call = (id: string, name = 'sample') => ({ id, name, input: {} });
async function collect(runtime: AgentRuntime, signal?: AbortSignal) {
  const events = [];
  for await (const event of runtime.run('hello', signal)) events.push(event);
  return events;
}

test('tool success, unknown tool and thrown errors are paired and fed back', async () => {
  const runtime = new AgentRuntime({ workspace: '.', provider: scripted([call('1'), call('2', 'missing'), call('3', 'broken')]), tools: [tool, { ...tool, name: 'broken', execute: async () => { throw new Error('broken'); } }] });
  const events = await collect(runtime);
  assert.deepEqual(events.at(-1), { type: 'stop', reason: 'complete' });
  const results = runtime.history.filter(m => m.role === 'tool');
  assert.deepEqual(results.map(r => r.isError), [false, true, true]);
  validateHistory(runtime.history);
});

test('read-only and non-interactive ask both block writes before execution/hooks', async () => {
  for (const mode of ['read-only', 'ask'] as const) {
    let executed = false;
    let hooked = false;
    const runtime = new AgentRuntime({ workspace: '.', mode, provider: scripted([call('1')]), tools: [{ ...tool, readOnly: false, execute: async () => { executed = true; return ''; } }], hooks: { beforeTool: async () => { hooked = true; } } });
    await collect(runtime);
    assert.equal(executed, false);
    assert.equal(hooked, false);
    assert.equal(runtime.history[2]?.role, 'tool');
  }
});

test('approved write and hook blocking; after hook errors do not lose results', async () => {
  let count = 0;
  const runtime = new AgentRuntime({ workspace: '.', provider: scripted([call('1'), call('2')]), tools: [{ ...tool, readOnly: false, execute: async () => { count++; return 'ok'; } }], confirm: async () => true,
    hooks: { beforeTool: async c => c.id === '2' ? 'blocked' : undefined, afterTool: async () => { throw new Error('observer'); } } });
  await collect(runtime);
  assert.equal(count, 1);
  validateHistory(runtime.history);
  assert.match(runtime.history[2]!.content, /observer/);
});

test('cancellation during first tool prevents following tool and preserves pairing', async () => {
  const controller = new AbortController();
  let count = 0;
  const runtime = new AgentRuntime({ workspace: '.', provider: scripted([call('1'), call('2')]), tools: [{ ...tool, execute: async () => { count++; controller.abort(); return 'ok'; } }] });
  const events = await collect(runtime, controller.signal);
  assert.equal(count, 1);
  assert.deepEqual(events.at(-1), { type: 'stop', reason: 'cancelled' });
  validateHistory(runtime.history);
});

test('consumer break after tool_start fills pending results without running tools', async () => {
  let count = 0;
  const runtime = new AgentRuntime({ workspace: '.', provider: scripted([call('1'), call('2')]), tools: [{ ...tool, execute: async () => { count++; return ''; } }] });
  for await (const event of runtime.run('hello')) if (event.type === 'tool_start') break;
  assert.equal(count, 0);
  validateHistory(runtime.history);
  assert.equal(runtime.history.filter(m => m.role === 'tool').length, 2);
});

test('partial provider failure commits no tool calls and allows next run', async () => {
  const provider: ModelProvider = { async *stream() { yield { type: 'tool_call', call: call('1') }; throw new Error('network'); } };
  const runtime = new AgentRuntime({ workspace: '.', provider, tools: [tool] });
  assert.deepEqual((await collect(runtime)).at(-1), { type: 'stop', reason: 'error' });
  validateHistory(runtime.history);
  assert.equal(runtime.history.length, 1);
  await collect(runtime);
});

test('max turns and output budget bound runaway tool loops', async () => {
  const runtime = new AgentRuntime({ workspace: '.', provider: scripted([call('1')], [call('2')]), maxTurns: 1, maxToolOutputChars: 2, tools: [{ ...tool, execute: async () => 'long output' }] });
  assert.deepEqual((await collect(runtime)).at(-1), { type: 'stop', reason: 'max_turns' });
  assert.match(runtime.history[2]!.content, /^lo\n\[output truncated\]/);
});

test('duplicate IDs rejected without poisoning history', async () => {
  const runtime = new AgentRuntime({ workspace: '.', provider: scripted([call('1'), call('1')]), tools: [tool] });
  assert.deepEqual((await collect(runtime)).at(-1), { type: 'stop', reason: 'error' });
  validateHistory(runtime.history);
});

test('context trims whole old turns but refuses oversized current turn', () => {
  const history: Message[] = [{ role: 'user', content: 'x'.repeat(200) }, { role: 'assistant', content: '', toolCalls: [call('1')] }, { role: 'tool', callId: '1', content: 'ok', isError: false }, { role: 'user', content: 'latest' }];
  assert.deepEqual(fitContext(history, 100), [history[3]]);
  assert.throws(() => fitContext(history, 5), /budget/);
});

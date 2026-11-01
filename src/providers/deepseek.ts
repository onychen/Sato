import type { ModelProvider, ToolCall } from '../types.js';
import { SatoError } from '../errors.js';
import { parseSSE } from './anthropic.js';

type PendingToolCall = { id: string; name: string; json: string };

/** DeepSeek Chat Completions 流式 API 适配器。 */
export class DeepSeekProvider implements ModelProvider {
  constructor(private readonly config: { apiKey: string; model: string; baseUrl?: string; maxTokens?: number }) {
    if (!config.apiKey || !config.model) throw new Error('API key and model are required');
  }

  async *stream(request: Parameters<ModelProvider['stream']>[0]) {
    const messages = [
      { role: 'system', content: request.system },
      ...request.messages.map(message => {
        if (message.role === 'tool') return { role: 'tool', tool_call_id: message.callId, content: message.content };
        if (message.role === 'assistant') return {
          role: 'assistant',
          content: message.content || null,
          ...(message.toolCalls.length ? { tool_calls: message.toolCalls.map(call => ({
            id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) },
          })) } : {}),
        };
        return { role: 'user', content: message.content };
      }),
    ];
    const response = await fetch(`${(this.config.baseUrl ?? 'https://api.deepseek.com').replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal: request.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify({
        model: this.config.model,
        ...(this.config.maxTokens ? { max_tokens: this.config.maxTokens } : {}),
        stream: true,
        messages,
        ...(request.tools.length ? { thinking: { type: 'disabled' } } : {}),
        ...(request.tools.length ? { tools: request.tools.map(tool => ({
          type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
        })) } : {}),
      }),
    }).catch(error => {
      if (request.signal.aborted) throw error;
      throw new SatoError('MODEL_NETWORK', 'Model connection failed; check endpoint and network', true, { cause: error });
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const hint = response.status === 401 || response.status === 403 ? 'Check API credentials and model access'
        : response.status === 429 ? 'Rate limited; retry later' : response.status >= 500 ? 'Model service unavailable; retry later' : 'Check model and request configuration';
      throw new SatoError('MODEL_HTTP', `Model HTTP ${response.status}: ${hint}`, response.status === 429 || response.status >= 500, undefined, response.status);
    }
    if (!response.body) throw new Error('Missing model response body');

    const calls = new Map<number, PendingToolCall>();
    let finished = false;
    try {
      for await (const raw of parseSSE(response.body)) {
        request.signal.throwIfAborted();
        const event = raw as {
          choices?: Array<{
            delta?: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> };
            finish_reason?: string | null;
          }>;
        };
        const choice = event.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) yield { type: 'text' as const, text: choice.delta.content };
        for (const delta of choice.delta?.tool_calls ?? []) {
          let pending = calls.get(delta.index);
          if (!pending) {
            pending = { id: '', name: '', json: '' };
            calls.set(delta.index, pending);
          }
          if (delta.id) pending.id += delta.id;
          if (delta.function?.name) pending.name += delta.function.name;
          if (delta.function?.arguments) {
            pending.json += delta.function.arguments;
            if (pending.json.length > 1_048_576) throw new Error('Tool input too large');
          }
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (!['stop', 'tool_calls'].includes(choice.finish_reason)) throw new Error(`Model stopped before completion: ${choice.finish_reason}`);
          finished = true;
          break;
        }
      }
      if (!finished) throw new Error('Incomplete model response');
      for (const [, pending] of [...calls.entries()].sort(([a], [b]) => a - b)) {
        if (!pending.id || !pending.name || !pending.json) throw new Error('Incomplete tool call');
        const call: ToolCall = { id: pending.id, name: pending.name, input: JSON.parse(pending.json) as unknown };
        yield { type: 'tool_call' as const, call };
      }
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      if (error instanceof SatoError) throw error;
      throw new SatoError('MODEL_PROTOCOL', 'Invalid or incomplete model stream', false, { cause: error });
    }
  }
}

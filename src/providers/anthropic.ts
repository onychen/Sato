import type { ModelProvider, ToolCall } from '../types.js';
import { SatoError } from '../errors.js';

/** 只负责 SSE 帧边界；网络 chunk 不等于一帧，也不等于一个 UTF-8 字符。 */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read().catch(error => {
        throw new SatoError('MODEL_NETWORK', 'Model stream connection interrupted', true, { cause: error });
      });
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index);
        if (frame.length > 2_000_000) throw new SatoError('MODEL_PROTOCOL', 'SSE frame too large');
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (data && data !== '[DONE]') {
          let event: unknown;
          try { event = JSON.parse(data) as unknown; }
          catch (error) { throw new SatoError('MODEL_PROTOCOL', 'Invalid SSE JSON', false, { cause: error }); }
          yield event;
        }
      }
      if (buffer.length > 2_000_000) throw new SatoError('MODEL_PROTOCOL', 'SSE frame too large');
      if (done) break;
    }
    if (buffer.trim()) throw new SatoError('MODEL_PROTOCOL', 'Incomplete SSE frame');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export class AnthropicProvider implements ModelProvider {
  constructor(private readonly config: { apiKey: string; model: string; baseUrl?: string; maxTokens?: number }) {
    if (!config.apiKey || !config.model) throw new Error('API key and model are required');
  }

  async *stream(request: Parameters<ModelProvider['stream']>[0]) {
    const messages = request.messages.map(message => {
      if (message.role === 'user') return { role: 'user', content: message.content };
      if (message.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: message.callId, content: message.content, is_error: message.isError }] };
      return { role: 'assistant', content: [
        ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ...message.toolCalls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input })),
      ] };
    });
    const response = await fetch(`${(this.config.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`, {
      method: 'POST', signal: request.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': this.config.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: this.config.model, max_tokens: this.config.maxTokens ?? 4096, stream: true, system: request.system, messages,
        ...(request.tools.length ? { tools: request.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })) } : {}),
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
    const calls = new Map<number, { call: ToolCall; json: string }>();
    let stopped = false;
    let stopReason = '';
    // 厂商协议留在适配器；完整 tool block 结束后才向 runtime 暴露。
    try {
      for await (const raw of parseSSE(response.body)) {
        request.signal.throwIfAborted();
        const event = raw as { type: string; index: number; content_block?: { type: string; id: string; name: string; input: unknown }; delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string } };
        if (event.type === 'error') throw new Error('Model stream error');
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          const block = event.content_block;
          calls.set(event.index, { call: { id: block.id, name: block.name, input: block.input }, json: '' });
        }
        if (event.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta' && event.delta.text) yield { type: 'text' as const, text: event.delta.text };
          const pending = calls.get(event.index);
          if (pending && event.delta?.partial_json) {
            pending.json += event.delta.partial_json;
            if (pending.json.length > 1_048_576) throw new Error('Tool input too large');
          }
        }
        if (event.type === 'content_block_stop') {
          const pending = calls.get(event.index);
          if (pending) {
            if (pending.json) pending.call.input = JSON.parse(pending.json) as unknown;
            yield { type: 'tool_call' as const, call: pending.call };
            calls.delete(event.index);
          }
        }
        if (event.type === 'message_delta') stopReason = event.delta?.stop_reason ?? '';
        if (event.type === 'message_stop') { stopped = true; break; }
      }
      if (!stopped || calls.size) throw new Error('Incomplete model response');
      if (!['end_turn', 'tool_use', 'stop_sequence'].includes(stopReason)) throw new Error(`Model stopped before completion: ${stopReason || 'unknown'}`);
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason;
      if (error instanceof SatoError) throw error;
      throw new SatoError('MODEL_PROTOCOL', 'Invalid or incomplete model stream', false, { cause: error });
    }
  }
}

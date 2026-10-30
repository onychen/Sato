import type { Message, ToolCall } from './types.js';
import { SatoError } from './errors.js';

export class ContextBudgetError extends SatoError {
  constructor(message: string) { super('CONTEXT_BUDGET', message); }
}

export function validateToolCall(call: unknown): asserts call is ToolCall {
  if (!call || typeof call !== 'object') throw new SatoError('MODEL_PROTOCOL', 'Invalid tool call');
  const c = call as Partial<ToolCall>;
  if (typeof c.id !== 'string' || !c.id.trim() || typeof c.name !== 'string' || !c.name.trim() || !('input' in c)) {
    throw new SatoError('MODEL_PROTOCOL', 'Tool call requires string id, name and input');
  }
}

/** 按完整 user 回合裁剪，永不留下孤立的 tool_result。字符数是估算，不是 token 数。 */
export function fitContext(messages: Message[], maxChars: number): Message[] {
  const copy = structuredClone(messages);
  while (JSON.stringify(copy).length > maxChars) {
    const nextUser = copy.findIndex((m, i) => i > 0 && m.role === 'user');
    if (nextUser < 0) throw new ContextBudgetError('Current turn exceeds context budget; start a new session or raise maxContextChars');
    copy.splice(0, nextUser);
  }
  return copy;
}

/** 同时用于 provider 边界与磁盘会话恢复，拒绝悬空或重复的工具结果。 */
export function validateHistory(messages: unknown): asserts messages is Message[] {
  if (!Array.isArray(messages)) throw new Error('Invalid history');
  const pending = new Set<string>();
  const seen = new Set<string>();
  for (const message of messages) {
    if (!message || typeof message.content !== 'string') throw new Error('Invalid message');
    if (message.role === 'tool') {
      if (typeof message.callId !== 'string' || typeof message.isError !== 'boolean') throw new Error('Invalid tool result');
      if (!pending.delete(message.callId)) throw new Error('Orphan tool result');
    } else {
      if (pending.size) throw new Error('Missing tool results');
      if (message.role === 'assistant') {
        if (!Array.isArray(message.toolCalls)) throw new Error('Invalid tool calls');
        for (const call of message.toolCalls) {
          validateToolCall(call);
          if (!call.id || seen.has(call.id)) throw new Error('Duplicate or empty tool call ID');
          seen.add(call.id);
          pending.add(call.id);
        }
      } else if (message.role !== 'user') throw new Error('Invalid role');
    }
  }
  if (pending.size) throw new Error('Missing tool results');
}

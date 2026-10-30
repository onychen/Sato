import type { Message } from './types.js';

export class ContextBudgetError extends Error {}

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
export function validateHistory(messages: Message[]): void {
  const pending = new Set<string>();
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool') {
      if (!pending.delete(message.callId)) throw new Error('Orphan tool result');
    } else {
      if (pending.size) throw new Error('Missing tool results');
      if (message.role === 'assistant') {
        for (const call of message.toolCalls) {
          if (!call.id || seen.has(call.id)) throw new Error('Duplicate or empty tool call ID');
          seen.add(call.id);
          pending.add(call.id);
        }
      }
    }
  }
  if (pending.size) throw new Error('Missing tool results');
}

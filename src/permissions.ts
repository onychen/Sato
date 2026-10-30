import type { Tool, ToolCall } from './types.js';

export type PermissionMode = 'ask' | 'read-only' | 'allow-write';
export type Confirm = (call: ToolCall, signal: AbortSignal) => Promise<boolean>;

export async function authorize(tool: Tool, call: ToolCall, mode: PermissionMode, signal: AbortSignal, confirm?: Confirm): Promise<void> {
  signal.throwIfAborted();
  if (tool.readOnly) return;
  if (mode === 'read-only') throw new Error('Permission denied: read-only mode');
  if (mode === 'allow-write') return;
  if (!confirm || !await confirm(structuredClone(call), signal)) throw new Error('Permission denied: write requires approval');
  signal.throwIfAborted();
}

import type { Tool, ToolCall } from './types.js';
import { SatoError } from './errors.js';

export type PermissionMode = 'ask' | 'read-only' | 'allow-write';
export type Confirm = (call: ToolCall, signal: AbortSignal) => Promise<boolean>;

export async function authorize(tool: Tool, call: ToolCall, mode: PermissionMode, signal: AbortSignal, confirm?: Confirm): Promise<void> {
  signal.throwIfAborted();
  if (tool.readOnly) return;
  if (mode === 'read-only') throw new SatoError('PERMISSION_DENIED', 'Permission denied: read-only mode');
  if (mode === 'allow-write') return;
  if (!confirm || !await confirm(structuredClone(call), signal)) throw new SatoError('PERMISSION_DENIED', 'Permission denied: write requires approval');
  signal.throwIfAborted();
}

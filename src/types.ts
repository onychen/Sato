import type { ErrorInfo } from './errors.js';
/** Runtime 内部协议与厂商 API 无关；只有 provider 负责转换。 */
export type ToolCall = { id: string; name: string; input: unknown };
export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls: ToolCall[] }
  | { role: 'tool'; callId: string; content: string; isError: boolean; error?: ErrorInfo };
export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ModelEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCall };
export interface ModelProvider {
  stream(request: {
    system: string; messages: Message[]; tools: ToolSpec[]; signal: AbortSignal;
  }): AsyncIterable<ModelEvent>;
}
export type ToolContext = { workspace: string; signal: AbortSignal };
export interface Tool extends ToolSpec {
  readOnly: boolean;
  /** 不依赖模型或 JSON Schema 自动保证参数正确；运行时仍需验证。 */
  parse(input: unknown): unknown;
  execute(input: unknown, context: ToolContext): Promise<string>;
}
export type ToolResult = Extract<Message, { role: 'tool' }>;
export type StopReason = 'complete' | 'cancelled' | 'max_turns' | 'error';
export type RuntimeEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'text'; text: string }
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'tool_result'; result: ToolResult }
  | { type: 'context_trimmed'; removed: number }
  | ({ type: 'error' } & ErrorInfo)
  | { type: 'stop'; reason: StopReason };
export interface Hooks {
  /** 返回字符串可阻断工具；扩展代码应视为可信程序。 */
  beforeTool?(call: ToolCall, signal: AbortSignal): Promise<string | void>;
  afterTool?(call: ToolCall, result: ToolResult): Promise<void>;
}

import { randomUUID } from 'node:crypto';
import type { ModelProvider } from '../types.js';

/** 确定性的离线模型：同样经过主循环、权限、工具和历史回填。 */
export class DemoProvider implements ModelProvider {
  async *stream({ messages, signal }: Parameters<ModelProvider['stream']>[0]) {
    signal.throwIfAborted();
    if (messages.at(-1)?.role === 'user') {
      yield { type: 'text' as const, text: '先查看工作区文件。\n' };
      yield { type: 'tool_call' as const, call: { id: randomUUID(), name: 'list_files', input: { path: '.' } } };
    } else {
      const result = messages.at(-1);
      yield { type: 'text' as const, text: `工具结果已回填：\n${result?.content ?? ''}\n\nSato 已完成一次“模型 → 工具 → 模型”循环。\n` };
    }
  }
}

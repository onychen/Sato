import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { validateHistory } from './context.js';
import type { Message } from './types.js';

type Session = { version: 1; workspace: string; messages: Message[] };

export async function saveSession(file: string, workspace: string, messages: Message[]): Promise<void> {
  validateHistory(messages);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, workspace: path.resolve(workspace), messages } satisfies Session, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}

export async function loadSession(file: string, workspace: string): Promise<Message[]> {
  const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
  if (!raw || typeof raw !== 'object') throw new Error('Invalid session');
  const session = raw as Session;
  if (session.version !== 1 || session.workspace !== path.resolve(workspace) || !Array.isArray(session.messages)) throw new Error('Session version or workspace mismatch');
  for (const m of session.messages) {
    if (!m || typeof m.content !== 'string') throw new Error('Invalid message');
    if (m.role === 'assistant') {
      if (!Array.isArray(m.toolCalls) || m.toolCalls.some(c => !c || typeof c.id !== 'string' || typeof c.name !== 'string' || !('input' in c))) throw new Error('Invalid tool calls');
    } else if (m.role === 'tool') {
      if (typeof m.callId !== 'string' || typeof m.isError !== 'boolean') throw new Error('Invalid tool result');
    } else if (m.role !== 'user') throw new Error('Invalid role');
  }
  validateHistory(session.messages);
  return session.messages;
}

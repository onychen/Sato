import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateHistory } from './context.js';
import type { Message } from './types.js';
import { atomicReplace } from './storage.js';
import { SatoError, errorMessage } from './errors.js';

type Session = { version: 1; workspace: string; messages: Message[] };

export async function saveSession(file: string, workspace: string, messages: Message[]): Promise<void> {
  try {
    validateHistory(messages);
    await mkdir(path.dirname(file), { recursive: true });
    await atomicReplace(file, JSON.stringify({ version: 1, workspace: path.resolve(workspace), messages } satisfies Session, null, 2));
  } catch (error) {
    throw new SatoError('SESSION_WRITE', `Could not save session ${file}: ${errorMessage(error)}`, false, { cause: error });
  }
}

export async function loadSession(file: string, workspace: string): Promise<Message[]> {
  try {
    const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!raw || typeof raw !== 'object') throw new Error('Invalid session');
    const session = raw as Session;
    if (session.version !== 1 || session.workspace !== path.resolve(workspace) || !Array.isArray(session.messages)) throw new Error('Session version or workspace mismatch');
    validateHistory(session.messages);
    return session.messages;
  } catch (error) {
    throw new SatoError('SESSION_READ', `Could not load session ${file}: ${errorMessage(error)}`, false, { cause: error });
  }
}

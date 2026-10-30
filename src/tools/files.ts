import { lstat, open, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Tool, ToolContext } from '../types.js';

const MAX_BYTES = 1_048_576;
const protectedName = (name: string) => ['.git', '.sato', 'node_modules'].includes(name.toLowerCase()) || name.toLowerCase().startsWith('.env');
const inside = (root: string, target: string) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};

/** 拒绝越界、链接和 Windows alternate data stream。父目录必须已存在。 */
export async function resolveWorkspacePath(workspace: string, name: string): Promise<string> {
  if (!name || path.isAbsolute(name) || name.includes('\0') || name.includes(':')) throw new Error('Invalid workspace-relative path');
  const root = await realpath(workspace);
  const target = path.resolve(root, name);
  if (!inside(root, target)) throw new Error('Path escapes workspace');
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  for (const [i, part] of parts.entries()) {
    if (protectedName(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw new Error('Protected path');
    current = path.join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are not allowed');
      if (!inside(root, await realpath(current))) throw new Error('Path escapes workspace');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && i === parts.length - 1) break;
      throw error;
    }
  }
  return target;
}

function fields(input: unknown, keys: string[]): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected an object');
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some(key => !keys.includes(key))) throw new Error('Unexpected input field');
  const parsed: Record<string, string> = {};
  for (const key of keys) {
    if (typeof record[key] !== 'string') throw new Error(`Expected string: ${key}`);
    parsed[key] = record[key];
  }
  return parsed;
}

function fileTool(name: string, description: string, readOnly: boolean, keys: string[], run: (input: Record<string, string>, ctx: ToolContext) => Promise<string>): Tool {
  return {
    name, description, readOnly,
    inputSchema: { type: 'object', properties: Object.fromEntries(keys.map(key => [key, { type: 'string' }])), required: keys, additionalProperties: false },
    parse: input => fields(input, keys),
    execute: (input, ctx) => run(input as Record<string, string>, ctx),
  };
}

async function readSmall(target: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const handle = await open(target, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Expected a regular file of at most 1 MiB');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    signal.throwIfAborted();
    if (bytesRead > MAX_BYTES) throw new Error('File too large');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await handle.close(); }
}

export function createFileTools(): Tool[] {
  return [
    fileTool('list_files', 'List immediate directory entries. Use path "." for workspace root.', true, ['path'], async (input, ctx) => {
      const target = await resolveWorkspacePath(ctx.workspace, input.path!);
      ctx.signal.throwIfAborted();
      const entries = await readdir(target, { withFileTypes: true });
      return entries.filter(e => !protectedName(e.name) && !e.isSymbolicLink()).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 500).map(e => e.name + (e.isDirectory() ? '/' : '')).join('\n');
    }),
    fileTool('read_file', 'Read a UTF-8 file (maximum 1 MiB).', true, ['path'], async (input, ctx) => readSmall(await resolveWorkspacePath(ctx.workspace, input.path!), ctx.signal)),
    fileTool('write_file', 'Create a new UTF-8 file. Existing files cannot be overwritten; use edit_file. Parent must exist.', false, ['path', 'content'], async (input, ctx) => {
      const target = await resolveWorkspacePath(ctx.workspace, input.path!);
      if (Buffer.byteLength(input.content!) > MAX_BYTES) throw new Error('Content too large');
      ctx.signal.throwIfAborted();
      await writeFile(target, input.content!, { encoding: 'utf8', flag: 'wx', signal: ctx.signal });
      return 'File created';
    }),
    fileTool('edit_file', 'Replace exactly one occurrence of old_text with new_text in a UTF-8 file.', false, ['path', 'old_text', 'new_text'], async (input, ctx) => {
      const target = await resolveWorkspacePath(ctx.workspace, input.path!);
      const original = await readSmall(target, ctx.signal);
      if (!input.old_text || original.split(input.old_text).length !== 2) throw new Error('old_text must match exactly once');
      const updated = original.replace(input.old_text, () => input.new_text!);
      if (Buffer.byteLength(updated) > MAX_BYTES) throw new Error('Content too large');
      ctx.signal.throwIfAborted();
      await writeFile(target, updated, { encoding: 'utf8', signal: ctx.signal });
      return 'File edited';
    }),
  ];
}

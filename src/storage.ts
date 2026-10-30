import { randomUUID } from 'node:crypto';
import { unlink, rename, writeFile } from 'node:fs/promises';

/** 同目录写完再提交；失败时保留原文件，清理失败也不能掩盖最初的错误。 */
export async function atomicReplace(file: string, content: string, options: { signal?: AbortSignal; mode?: number } = {}): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: options.mode ?? 0o600, ...(options.signal ? { signal: options.signal } : {}) });
    options.signal?.throwIfAborted();
    await rename(temporary, file);
  } catch (error) {
    try { await unlink(temporary); }
    catch (cleanup) {
      if ((cleanup as NodeJS.ErrnoException).code !== 'ENOENT') throw new AggregateError([error, cleanup], 'Write failed and temporary file cleanup also failed');
    }
    throw error;
  }
}

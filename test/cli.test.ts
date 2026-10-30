import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execute = promisify(execFile);
const cli = (...args: string[]) => execute(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { timeout: 10_000 });

test('CLI fails explicitly on save error and cleans temporary files', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sato-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'session.json');
  await mkdir(target);
  await assert.rejects(cli('--demo', '--prompt', 'demo', '--workspace', root, '--session', target), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(Reflect.get(error, 'code'), 1);
    assert.match(String(Reflect.get(error, 'stderr')), /SESSION_WRITE/);
    return true;
  });
  assert.deepEqual(await readdir(root), ['session.json']);
});

test('CLI rejects invalid configuration before creating session data', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sato-cli-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(cli('--demo', '--prompt', 'demo', '--workspace', root, '--max-turns', 'NaN'));
  await assert.rejects(cli('--demo', '--prompt', 'demo', '--workspace', path.join(root, 'missing')));
  assert.deepEqual(await readdir(root), []);
});

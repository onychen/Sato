import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFileTools, resolveWorkspacePath, saveSession, loadSession } from '../src/index.js';

test('file tools enforce boundaries, unique edits and exclusive creation', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sato-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ctx = { workspace: root, signal: new AbortController().signal };
  const tools = createFileTools();
  const run = async (name: string, input: unknown) => {
    const tool = tools.find(t => t.name === name)!;
    return tool.execute(tool.parse(input), ctx);
  };
  for (const name of ['../outside', '.git/config', '.env', '.sato/session.json', 'file:secret', 'file.']) await assert.rejects(resolveWorkspacePath(root, name));
  await assert.rejects(run('read_file', { path: '.', extra: 'bad' }));
  await run('write_file', { path: 'hello.txt', content: 'one one' });
  await assert.rejects(run('write_file', { path: 'hello.txt', content: 'overwrite' }));
  await assert.rejects(run('edit_file', { path: 'hello.txt', old_text: 'one', new_text: 'two' }));
  await run('edit_file', { path: 'hello.txt', old_text: 'one one', new_text: '$& two' });
  assert.equal(await run('read_file', { path: 'hello.txt' }), '$& two');
  assert.equal(await readFile(path.join(root, 'hello.txt'), 'utf8'), '$& two');
  await writeFile(path.join(root, '.env.secret'), 'secret');
  assert.doesNotMatch(await run('list_files', { path: '.' }), /secret/);
});

test('directory links cannot escape workspace', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sato-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = path.join(root, 'outside');
  const workspace = path.join(root, 'workspace');
  await mkdir(outside);
  await mkdir(workspace);
  await symlink(outside, path.join(workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(resolveWorkspacePath(workspace, 'link/secret'), /links/);
});

test('sessions round-trip, replace atomically, reject mismatched workspace and invalid pairs', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'sato-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, '.sato/session.json');
  await saveSession(file, root, [{ role: 'user', content: 'hello' }]);
  assert.deepEqual(await loadSession(file, root), [{ role: 'user', content: 'hello' }]);
  await saveSession(file, root, []);
  assert.deepEqual(await loadSession(file, root), []);
  await assert.rejects(loadSession(file, path.join(root, 'other')));
  await writeFile(file, JSON.stringify({ version: 1, workspace: root, messages: [{ role: 'tool', callId: 'missing', content: 'oops', isError: false }] }));
  await assert.rejects(loadSession(file, root), /Orphan/);
});

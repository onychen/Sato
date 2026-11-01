#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import path from 'node:path';
import { AgentRuntime } from './runtime.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { DeepSeekProvider } from './providers/deepseek.js';
import { DemoProvider } from './providers/demo.js';
import { createFileTools } from './tools/files.js';
import { loadSession, saveSession } from './session.js';
import type { PermissionMode } from './permissions.js';
import { stat } from 'node:fs/promises';
import { errorInfo } from './errors.js';

async function main() {
  const { values } = parseArgs({ options: {
    demo: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    prompt: { type: 'string', short: 'p' }, workspace: { type: 'string', short: 'w' },
    mode: { type: 'string' }, session: { type: 'string' }, resume: { type: 'boolean' },
    model: { type: 'string' }, provider: { type: 'string' }, 'max-turns': { type: 'string' },
  } });
  if (values.help) {
    console.log(`Sato — TypeScript 教学 Agent Runtime
  npm run demo                           无密钥演示（只列文件）
  npm run dev -- -p "解释这个项目"         单次提问
  npm run dev -- --demo                   交互演示
  --workspace, -w <dir>                   工作区，默认当前目录
  --mode ask|read-only|allow-write        默认 ask；非交互时拒绝未获批准的写入
  --session <file> --resume               保存/恢复会话（默认 .sato/session.json）
  --provider anthropic|deepseek            模型服务商，默认 anthropic
  --model <id> --max-turns <n>              模型 ID / 最大模型请求次数
环境变量：SATO_PROVIDER、ANTHROPIC_API_KEY、DEEPSEEK_API_KEY、SATO_MODEL、SATO_BASE_URL
交互命令：/exit。Ctrl+C 取消当前回合；空闲时退出。`);
    return;
  }
  const mode = values.mode ?? 'ask';
  if (!['ask', 'read-only', 'allow-write'].includes(mode)) throw new Error('Invalid --mode');
  const workspace = path.resolve(values.workspace ?? '.');
  if (!(await stat(workspace)).isDirectory()) throw new Error('Workspace must be a directory');
  const sessionFile = path.resolve(values.session ?? path.join(workspace, '.sato/session.json'));
  const providerName = values.provider ?? process.env.SATO_PROVIDER ?? 'anthropic';
  if (!['anthropic', 'deepseek'].includes(providerName)) throw new Error('Invalid --provider; use anthropic or deepseek');
  const provider = values.demo ? new DemoProvider() : providerName === 'deepseek'
    ? new DeepSeekProvider({
      apiKey: process.env.DEEPSEEK_API_KEY ?? '',
      model: values.model ?? process.env.SATO_MODEL ?? 'deepseek-flash',
      ...(process.env.SATO_BASE_URL ? { baseUrl: process.env.SATO_BASE_URL } : {}),
    })
    : new AnthropicProvider({
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      model: values.model ?? process.env.SATO_MODEL ?? 'claude-sonnet-4-5',
      ...(process.env.SATO_BASE_URL ? { baseUrl: process.env.SATO_BASE_URL } : {}),
    });
  const history = values.resume ? await loadSession(sessionFile, workspace) : [];
  const maxTurns = values['max-turns'] ? Number(values['max-turns']) : 12;
  if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) throw new Error('Invalid --max-turns');
  const terminal = stdin.isTTY ? createInterface({ input: stdin, output: stdout }) : undefined;
  let closed = false;
  terminal?.on('close', () => { closed = true; });
  let active: AbortController | undefined;
  const idle = new AbortController();
  terminal?.on('close', () => { idle.abort(); active?.abort(); });
  const interrupt = () => { if (active) active.abort(); else { process.exitCode = 130; idle.abort(); terminal?.close(); } };
  process.on('SIGINT', interrupt);
  terminal?.on('SIGINT', interrupt);
  const runtime = new AgentRuntime({
    provider, tools: createFileTools(), workspace, mode: mode as PermissionMode,
    history, maxTurns,
    confirm: async (call, signal) => {
      if (!terminal) return false;
      console.log(`\n请求写入：${call.name} ${JSON.stringify(call.input)}`);
      try { return (await terminal.question('批准本次操作？[y/N] ', { signal })).trim().toLowerCase() === 'y'; }
      catch { return false; }
    },
  });
  async function run(prompt: string) {
    active = new AbortController();
    try {
      for await (const event of runtime.run(prompt, active.signal)) {
        switch (event.type) {
          case 'text': stdout.write(event.text); break;
          case 'tool_start': console.error(`\n[tool] ${event.call.name}`); break;
          case 'tool_result': console.error(event.result.isError ? `[tool error] ${event.result.content}` : '[tool done]'); break;
          case 'context_trimmed': console.error(`[context] 请求视图移除 ${event.removed} 条旧消息`); break;
          case 'error': console.error(`\n[${event.code}] ${event.message}`); break;
          case 'stop':
            console.error(`\n[stop] ${event.reason}`);
            if (values.prompt !== undefined && event.reason !== 'complete') process.exitCode = event.reason === 'cancelled' ? 130 : 1;
        }
      }
    } finally {
      active = undefined;
      await saveSession(sessionFile, workspace, runtime.history);
    }
  }
  try {
    if (values.prompt !== undefined) await run(values.prompt);
    else {
      if (!terminal) throw new Error('Non-interactive input requires --prompt');
      console.log('Sato · 输入 /exit 退出，Ctrl+C 取消当前回合');
      while (!closed) {
        let prompt: string;
        try { prompt = await terminal.question('\nsato> ', { signal: idle.signal }); }
        catch (error) { if (idle.signal.aborted) break; throw error; }
        if (prompt.trim() === '/exit') break;
        if (prompt.trim()) await run(prompt);
      }
    }
  } finally { terminal?.close(); process.off('SIGINT', interrupt); }
}

main().catch(error => { const info = errorInfo(error); console.error(`[${info.code}] ${info.message}`); process.exitCode = 1; });

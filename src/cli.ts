#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import path from 'node:path';
import { AgentRuntime } from './runtime.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { DemoProvider } from './providers/demo.js';
import { createFileTools } from './tools/files.js';
import { loadSession, saveSession } from './session.js';
import type { PermissionMode } from './permissions.js';

async function main() {
  const { values } = parseArgs({ options: {
    demo: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    prompt: { type: 'string', short: 'p' }, workspace: { type: 'string', short: 'w' },
    mode: { type: 'string' }, session: { type: 'string' }, resume: { type: 'boolean' },
    model: { type: 'string' }, 'max-turns': { type: 'string' },
  } });
  if (values.help) {
    console.log(`Sato — TypeScript 教学 Agent Runtime
  npm run demo                           无密钥演示（只列文件）
  npm run dev -- -p "解释这个项目"         单次提问
  npm run dev -- --demo                   交互演示
  --workspace, -w <dir>                   工作区，默认当前目录
  --mode ask|read-only|allow-write        默认 ask；非交互时拒绝未获批准的写入
  --session <file> --resume               保存/恢复会话（默认 .sato/session.json）
  --model <id> --max-turns <n>            模型 ID / 最大模型请求次数
环境变量：ANTHROPIC_API_KEY、SATO_MODEL、SATO_BASE_URL
交互命令：/exit。Ctrl+C 取消当前回合；空闲时退出。`);
    return;
  }
  const mode = values.mode ?? 'ask';
  if (!['ask', 'read-only', 'allow-write'].includes(mode)) throw new Error('Invalid --mode');
  const workspace = path.resolve(values.workspace ?? '.');
  const sessionFile = path.resolve(values.session ?? path.join(workspace, '.sato/session.json'));
  const provider = values.demo ? new DemoProvider() : new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY ?? '',
    model: values.model ?? process.env.SATO_MODEL ?? 'claude-sonnet-4-5',
    ...(process.env.SATO_BASE_URL ? { baseUrl: process.env.SATO_BASE_URL } : {}),
  });
  const terminal = stdin.isTTY ? createInterface({ input: stdin, output: stdout }) : undefined;
  let closed = false;
  terminal?.on('close', () => { closed = true; });
  let active: AbortController | undefined;
  const interrupt = () => { if (active) active.abort(); else { terminal?.close(); process.exitCode = 130; } };
  process.on('SIGINT', interrupt);
  terminal?.on('SIGINT', interrupt);
  const runtime = new AgentRuntime({
    provider, tools: createFileTools(), workspace, mode: mode as PermissionMode,
    ...(values.resume ? { history: await loadSession(sessionFile, workspace) } : {}),
    ...(values['max-turns'] ? { maxTurns: Number(values['max-turns']) } : {}),
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
          case 'error': console.error(`\n[error] ${event.message}`); break;
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
        const prompt = await terminal.question('\nsato> ');
        if (prompt.trim() === '/exit') break;
        if (prompt.trim()) await run(prompt);
      }
    }
  } finally { terminal?.close(); process.off('SIGINT', interrupt); }
}

main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });

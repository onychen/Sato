# Sato

一个用 TypeScript 编写的教学版 Agent Runtime。沿着一条能读懂的链路，理解 AI 编程助手如何调用工具、检查权限、接收结果并继续推理。

```text
用户输入 → 模型流式响应 → 工具调用 → 参数验证 → 权限 → Hook → 执行
                         ↑                              ↓
                         └──────── 工具结果回填 ─────────┘
```

参考 Claude Code 的运行机制与 ThoughtCoding 的教学分层，独立实现。**运行时零第三方依赖**，使用 Node.js 内置的 fetch、文件系统、事件和 AbortSignal。

## 五分钟运行

需要 Node.js 22+、npm。

```sh
npm ci
npm run demo
```

离线演示不需要 API Key，会列出当前目录，再把工具结果交回演示模型输出。它是固定脚本，不能回答任意问题；真实模型才负责推理。演示也会在 `.sato/session.json` 保存会话。

```sh
npm run check                  # 类型检查、测试、构建
node dist/src/cli.js --help    # 构建后的命令行
npx tsx examples/basic.ts      # 在代码中使用 runtime
```

## 使用真实模型

内置 Anthropic Messages API 与 DeepSeek Chat Completions 流式适配器。准备对应 API Key 和模型 ID；示例 ID 可通过参数覆盖。

PowerShell：

```powershell
$env:ANTHROPIC_API_KEY = '你的密钥'
$env:SATO_MODEL = '你账号可用的模型ID'
npm run dev -- --prompt '阅读 README，解释这个项目的结构' --mode read-only
npm run dev                   # 交互会话
```

使用 DeepSeek 时，将服务商设为 `deepseek`，并配置 `DEEPSEEK_API_KEY`。PowerShell 示例：

```powershell
$env:SATO_PROVIDER = 'deepseek'
$env:DEEPSEEK_API_KEY = '你的密钥'
$env:SATO_MODEL = 'deepseek-flash'
npm run dev -- --prompt '阅读 README，解释这个项目的结构' --mode read-only
```

macOS / Linux：

```sh
export ANTHROPIC_API_KEY='你的密钥'
export SATO_MODEL='你账号可用的模型ID'
npm run dev -- --prompt '阅读 README，解释这个项目的结构' --mode read-only
```

也可复制 `.env.example` 为 `.env`，设置 `SATO_PROVIDER=deepseek`、`DEEPSEEK_API_KEY` 和 `SATO_MODEL=deepseek-flash`，构建后通过 `node --env-file=.env dist/src/cli.js` 启动。Sato 不自动读取 `.env`。`SATO_BASE_URL` 可指定 API 基础地址：Anthropic 适配器追加 `/v1/messages`，DeepSeek 适配器追加 `/chat/completions`。密钥会发送给该地址，请只使用你信任的服务。

```sh
npm run dev -- --workspace ./my-project --mode ask
npm run dev -- --resume --prompt '继续解释'
npm run dev -- --session ./private-session.json --demo --prompt demo
```

CLI 每次用户回合结束后保存会话；`--resume` 显式加载，且必须匹配原工作区。未指定 `--resume` 会开启新会话，并在回合后替换默认会话文件。非交互环境必须提供 `--prompt`。Ctrl+C 取消当前回合，`/exit` 退出交互。单次运行失败、取消或达到轮次限制时返回非零退出码。

## 保留的关键机制

| 能力 | 教学实现 |
| --- | --- |
| Agent loop | `AsyncGenerator<RuntimeEvent>`；无工具调用时结束 |
| 模型解耦 | `ModelProvider.stream()`；内置离线模型、Anthropic SSE 与 DeepSeek SSE |
| 工具系统 | 显式注册、JSON Schema 描述、运行时参数验证 |
| 权限 | `ask`、`read-only`、`allow-write`；默认拒绝未确认写入 |
| 扩展点 | `beforeTool` 阻断、`afterTool` 观察 |
| 取消 | AbortSignal 传递到模型、确认和工具 |
| 协议完整性 | 工具调用和结果按 ID 配对；中断后补齐未执行结果 |
| 有限执行 | 模型轮次、上下文字符数、工具输出大小、请求/工具超时 |
| 会话 | 带版本与工作区的 JSON、临时文件写入后重命名 |
| 上下文 | 按完整用户回合生成裁剪视图；保留磁盘完整历史 |

工具顺序执行，方便学习与调试。暂不实现 shell、MCP、子 Agent、任务调度、长期记忆、自动摘要或复杂 TUI。

## 文件工具和权限

| 工具 | 用途 | 权限 |
| --- | --- | --- |
| `list_files` | 列出一层目录，最多 500 项 | 只读 |
| `read_file` | 读取最大 1 MiB 的 UTF-8 文件 | 只读 |
| `write_file` | 创建新文件，父目录需存在，拒绝覆盖 | 写入 |
| `edit_file` | 精确替换唯一匹配文本 | 写入 |

所有文件工具只接受工作区内的相对路径，拒绝目录穿越、符号链接/junction、`.git`、`.sato`、`.env*`、`node_modules` 及 Windows 数据流路径。`ask` 在交互终端逐次确认写入；没有终端则拒绝。`read-only` 始终拒绝写工具；`allow-write` 是用户显式选择的免确认模式，路径约束依然生效。

文件检查是教学级防护，无法隔离恶意本地进程造成的路径检查/操作竞争，也不保护所有可能存放秘密的文件名。建议在专用练习目录中使用。工具与 Hooks 是可信程序扩展，超时依赖它们协作响应 `signal`；Sato 不会强制终止不响应取消的自定义代码。写入若已开始，取消不能保证撤销副作用；`edit_file` 通过同目录临时文件写完后替换，提交前失败保留原文件，提交后无自动回滚或跨进程冲突检测。

会话包含提示词与工具输出，请自行保管。`.gitignore` 已排除默认会话目录和密钥文件。

## 源码阅读顺序

```text
src/
  types.ts              内部消息、工具、模型和事件协议
  runtime.ts            主循环与工具执行管线
  permissions.ts        权限决策
  context.ts            上下文视图与工具配对验证
  tools/files.ts        文件工具与路径边界
  providers/demo.ts     无密钥演示
  providers/anthropic.ts 厂商协议转换与 SSE 解析
  providers/deepseek.ts  DeepSeek Chat Completions 转换与 SSE
  session.ts            会话持久化
  cli.ts                交互、输出、取消与确认
  index.ts              公共导出
test/                   循环、权限、取消、文件、会话、流式协议测试
examples/basic.ts       最小嵌入示例
docs/                   架构、参考映射和练习
```

继续阅读 [架构与执行契约](docs/architecture.md)、[参考实现映射](docs/references.md) 和 [练习](docs/exercises.md)。

本地验证包含真实 HTTP 流模拟，不需要真实密钥；真实 Anthropic 或 DeepSeek 账户端到端调用需自行配置密钥后运行。CI 配置覆盖 Windows/Linux 和 Node.js 22/24。

## 错误处理

模型请求超时、网络失败、HTTP 错误、协议损坏及空响应会产生带 `code`、`message`、`retryable` 的 `error` 事件，随后 `stop: error`。未完成或格式错误的响应不会提交工具调用。工具参数、权限、Hook、执行和超时错误则写入配对的失败结果，通过可选 `error` 字段提供分类，模型可继续纠正。用户取消仍通过 `stop: cancelled` 表达。

HTTP 429/5xx 与网络故障标记为可能可重试，但不会自动重试，以免重放已执行的工具或重复计费。会话读写失败使用 `SESSION_READ` / `SESSION_WRITE`，保存失败会清理临时文件，并令 CLI 返回非零退出码。错误保留原始 `cause` 供程序调试；事件不输出堆栈、请求头和上游完整响应体。完整契约见 [架构文档](docs/architecture.md)。

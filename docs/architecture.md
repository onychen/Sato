# 从一轮请求理解 Sato

先读 `src/types.ts`，再沿 `src/runtime.ts` 跟踪一轮离线演示。

## 三个边界

1. 模型边界：runtime 只理解文本片段和完整 `ToolCall`，不理解厂商 SSE 字段。Provider 接收消息快照，不能直接改内部历史。
2. 工具边界：模型传来的参数是 `unknown`。JSON Schema 帮助模型生成参数，`parse()` 才负责程序端验证。
3. 展示边界：CLI 只消费事件。换成网页或编辑器界面，可以复用同一个 runtime。

```mermaid
sequenceDiagram
  participant UI as CLI / 应用
  participant R as AgentRuntime
  participant P as ModelProvider
  participant T as Tool
  UI->>R: run(prompt, signal)
  R->>P: system + messages + tool specs
  P-->>R: text / tool_call
  R-->>UI: text
  Note over R: 完整响应后提交 assistant
  R->>R: parse → authorize → beforeTool
  R->>T: execute(input, context)
  T-->>R: string / exception
  R->>R: 限长 → afterTool → 写入 tool result
  R-->>UI: tool_result
  R->>P: 历史 + 工具结果
  P-->>R: 最终文本（无工具）
  R-->>UI: stop: complete
```

## 消息完整性

用户回合中可能有多次模型请求。每个 assistant 可包含多个工具调用，每个调用必须对应一个工具结果。

模型流还没有完整结束时，只向 UI 输出文本，不把半截 assistant 提交到历史。中途网络失败，下一次请求不会携带损坏的工具参数。UI 已显示的文本只是暂态输出，不能作为已提交历史的证据。

完整响应提交前验证调用 ID：空 ID、历史重复 ID、批内重复 ID 均失败。未知工具、参数错误、权限拒绝、Hook 阻断、执行异常则生成 `isError: true` 的结果，供模型理解并修正。

工具批次由 `try/finally` 包围。调用者在 `tool_start` 后 `break`，或取消剩余操作时，`finally` 为尚未完成的调用补齐失败结果。调用者应使用 `for await`，或显式调用迭代器的 `return()`；仅仅丢弃一个仍暂停的迭代器不会触发清理。

## 权限和 Hooks

执行顺序固定为：参数验证 → 权限 → beforeTool → signal 检查 → execute → 结果限长 → afterTool。

权限不会交给 Hooks 决定。传给确认函数与 Hooks 的调用、结果都是副本，避免观察代码改写即将执行的参数。`afterTool` 异常追加诊断信息，不抹掉工具的原始执行结果。自定义工具声明的 `readOnly` 必须真实可靠；内置权限系统不能验证扩展程序的实际行为。

`read-only` 优先于确认函数，防止确认意外放开写入。所有工具仍执行文件路径边界检查，`allow-write` 只免除确认。

## 预算与终止

| 参数 | 默认值 | 语义 |
| --- | --- | --- |
| `maxTurns` | 12 | 每次 run 的最大模型请求次数 |
| `maxContextChars` | 100000 | 序列化 messages 的字符预算 |
| `maxToolOutputChars` | 12000 | 单个工具输出保留字符数，之后追加截断标记 |
| `toolTimeoutMs` | 30000 | 参数验证之后的执行管线协作取消信号 |
| `requestTimeoutMs` | 120000 | 单个模型请求的取消信号 |

上下文预算是估算，不包含 system/tool schema，也不是模型 tokenizer。裁剪只作用于发给模型的视图：删除最早的完整用户回合，不拆散工具调用/结果，不改变保存的完整历史。当前回合本身过大则报错停止，避免静默丢失本轮证据。无自动摘要。

`stop.reason` 有 `complete`、`cancelled`、`max_turns`、`error`。达到轮次限制时不会伪造最终回答。provider 错误会先产生 `error` 事件，再产生 `stop`；工具错误是回填结果，通常可由模型修复。

一个 runtime 同时只允许一个 run。多会话使用多个实例，磁盘会话文件也应不同。会话只在 CLI 回合结束时保存，没有每条事件的崩溃恢复或多进程文件锁。

## 添加工具

实现 `Tool`：提供名称、描述、JSON Schema、`readOnly`、`parse()`、`execute()`，然后把它放到 `RuntimeOptions.tools` 中。

`execute()` 接收 `{ workspace, signal }`，应在副作用之前检查 signal，并把它传给支持取消的 API。不要用“Promise 超时后返回”假装停止后台副作用。若需要运行不可信工具，应在独立进程或容器中设计强制终止和隔离，这是当前教学版本的扩展课题。

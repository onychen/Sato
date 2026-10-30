# 参考实现与取舍

这份映射来自实际阅读用户提供的本地参考目录。Sato 独立编写实现，没有复制参考项目的源码，也不依赖它们才能运行。以下路径是参考目录内的相对路径，参考源码不随仓库分发。

## Claude Code

参考根目录：`F:\code\Claude Code 源代码`。

| 阅读入口 | 观察到的机制 | Sato 中的对应 |
| --- | --- | --- |
| `src/query.ts` 的 `query` / `queryLoop` | 异步生成器产出消息，模型响应与工具执行交替 | `AgentRuntime.run()` 产出小型事件联合类型 |
| `src/query.ts` 的 `yieldMissingToolResultBlocks` | 中断时补齐 tool result，保证协议完整 | 批次 `finally` 补齐未执行调用 |
| `src/services/tools/toolOrchestration.ts` | 根据工具并发安全性分组，只读工具可并行，有副作用工具顺序执行 | 所有工具顺序执行，减少教学中的并发状态 |
| `src/query.ts` 的 compact、token budget、tool result budget 接入 | 在请求与结果边界控制上下文规模 | 完整用户回合裁剪视图、单工具输出限长 |

## ThoughtCoding

参考根目录：`F:\code\ThoughtCoding-main\ThoughtCoding-main`（本地目录有一层嵌套）。

| 阅读入口 | 观察到的机制 | Sato 中的对应 |
| --- | --- | --- |
| `src/main/java/com/thoughtcoding/core/AgentLoop.java` | 缓存一轮工具调用，结果按 ID 回填，再继续模型请求 | 厂商无关的 ToolCall / Message 与主循环 |
| 同文件 `runNativeToolLoop` | 最大迭代次数、取消补齐、无工具时自然完成 | maxTurns、AbortSignal、stop reason |
| `core/ToolExecutionPipeline.java` | PreToolUse → dispatcher → PostToolUse 的共享管线 | runtime 的 execute、beforeTool / afterTool |
| `security/PermissionGate.java` | 区分只读与写入，计划模式禁止修改 | read-only / ask / allow-write 三种实例级模式 |

这些类名的公共 Java 包前缀均为 `src/main/java/com/thoughtcoding/`。

## 教学版刻意保留与省略

保留工具配对、明确权限、可取消信号、有限循环和模型适配边界，因为这些直接影响 agent 能否可靠运行。省略复杂 UI、记忆服务、子 Agent、MCP、worktree、遥测、自动摘要和自动重试，便于读者跟踪一条完整执行链。

文件工具比参考项目更小：创建不覆盖文件，编辑要求文本唯一匹配，没有 shell。Sato 的安全边界是专用练习目录、可信扩展与协作取消，不应理解为操作系统隔离。

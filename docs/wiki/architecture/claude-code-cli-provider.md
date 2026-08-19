# Claude Code CLI 文本模型适配边界

## 背景

部分用户手上只有 Claude 订阅和本机 `claude` 登录态，没有独立的 Anthropic API Key。这与 Codex 的情况相同：登录态不是一个可以填进厂商设置的 HTTP Key，工作台也不能把它当成普通 `anthropic` 厂商配置。

Claude Code CLI 与 Codex CLI 的差别在于会话模型。Codex `app-server` 是一个常驻进程，可以并发承载多个 thread；Claude Code 的 `--print --input-format stream-json` 一个进程只驱动一条会话，后续输入会追加到同一段上下文里。因此适配不能直接照抄 Codex 的"常驻进程 + 多 thread"结构。

## 决策

Claude Code 作为内置文本厂商接入，复用与 Codex 相同的本地桥接层：服务端在进程内启动一个只监听 `127.0.0.1` 随机端口的 OpenAI Chat Completions 兼容服务，业务侧继续走统一的 LangChain 工厂，不为这个厂商改写任何业务调用链。

桥接层本身抽到 `server/src/platform/llm/cliBridge/`，由 Codex 与 Claude Code 共用。两个厂商各自只提供一个实现 `CliTextGenerator` 的客户端，以及用于错误文案和 `owned_by` 的身份描述。新增同类 CLI 厂商时只需要实现这个接口，不应再复制一份 HTTP 桥接。

生成侧选择**每次请求一个独立 CLI 进程**，而不是复用常驻进程。理由不是启动成本，而是正确性：同一个进程内的第二次请求会看到第一次请求的全部小说提示词，既污染上下文又持续放大 token 成本。独立进程同时让取消变得确定——进程结束等于 turn 结束，不存在 Codex 那种"孤儿 turn 继续运行"的竞态。

## 当前规则

- 内置 provider id 固定为 `claudeCode`，只用于文本生成，不参与图片生成或 Embedding/RAG 厂商列表。
- 默认模型为 `opus`，默认推理强度为 `max`（与 Codex 侧的决策保持一致）。`CLAUDE_CODE_CLI_EFFORT` 支持 `low`、`medium`、`high`、`xhigh`、`max`；Codex 的 `ultra` 在 Claude Code 中不存在，填入必须报错而不是静默降级。
- effort 对输出 token 的影响是数量级的，调整默认值前先算成本：同样是一句十来字的中文描写，Sonnet 配 `low` 约 34 个输出 token，Haiku 配 `max` 约 4700 个。整本书的生产链上每章都要跑多次模型调用，`max` 会把思考 token 成倍放大。正文续写这类"文笔重于推理"的任务适合调低，卷战略、章节任务拆解这类结构化规划任务才值得留在高档位。
- `CLAUDE_CODE_CLI_PATH` 只接受规范化绝对路径。未设置时通过无 shell 的进程调用执行 `claude`，禁止把用户输入拼进命令字符串。
- 本地 OpenAI 兼容端点只绑定回环地址，并使用每次服务启动随机生成的内存令牌。令牌不写入数据库、日志、env 或前端。
- 每个 CLI 进程都以隔离参数启动：`--safe-mode` 关闭用户的 CLAUDE.md、hooks、skills、plugins 与 MCP，同时保留登录态；`--tools ""` 关闭全部内置工具；`--permission-mode dontAsk` 保证没有任何审批可以阻塞无头请求；`--strict-mcp-config`、`--disable-slash-commands`、`--no-session-persistence` 分别阻断 MCP、技能与会话落盘。cwd 指向临时目录，CLI 看不到用户仓库。
- 实测 `system/init` 帧在该参数组合下返回 `tools: []`、`mcp_servers: []`、`skills: []`、`plugins: []`、`slash_commands: 0`，且不再触发 SessionStart 之类的 hook 事件。**但 `agents` 列表不会被清空**，内置 agent 定义仍然会列出。这不构成越权：`Task` 工具本身不在 `tools` 里，模型没有可用的派生入口。判断隔离是否生效应该看 `tools`，不要看 `agents`。
- 以上隔离依赖参数组合，不依赖模型自觉。修改这组参数前应重新用一次带诱饵文件的调用验证：模型必须回答"做不到"，且整条流里不能出现任何 `tool_use` 内容块。
- 不使用 `--bare`。它会强制只接受 `ANTHROPIC_API_KEY` 并跳过 OAuth 与 keychain，正好破坏"复用本机登录"这个前提。
- `--system-prompt` 整体替换 Claude Code 的编码代理系统提示，只保留"文本生成后端"这一角色；应用层的 system/developer 消息通过 `--append-system-prompt` 传入。
- 普通响应通过 `--include-partial-messages` 的 `stream_event` 增量转换为 OpenAI SSE，只转发 `text_delta`；`thinking_delta` 不进入正文。
- 结构化请求把 `response_format.json_schema.schema` 映射到 `--json-schema`，最终内容取 `result.structured_output`（CLI 已经校验过的结果），而不是原始文本。
- 结构化请求**不开启** `--include-partial-messages`。Claude Code 的结构化输出是本地校验加重试，如果同时转发增量，多次尝试的文本会在流里首尾相接，拼出一段不合法的 JSON。
- Claude Code 的 `json_schema` 不需要 Codex 那种严格兼容检查（对象必须关闭额外字段、所有属性必须进入 `required`）。它按 schema 校验并重试，因此 `claude_code_cli` profile 不走 `codex_cli` 的严格降级分支。
- 重试上限用尽时（`error_max_structured_output_retries`）返回的错误信息必须包含 `json_schema`，让结构化输出分类器判定为 `unsupported_native_json`，从而降级到 `prompt_json`，而不是直接判成 `transport_error` 中止整条链路。
- 模型目录来自 `list_models` 控制请求动态读取；代码中的模型清单只是首次显示和离线兜底，不是长期事实源。该控制请求不触发模型调用，因此刷新模型不消耗额度。
- Claude Code 默认并发为 1；用户可以在厂商高级设置中提高并发，但每个并发都是一个独立 CLI 进程，应自行承担订阅限额与本机资源开销。

## 调用监督与超时

文本模型调用统一使用平台级超时策略，未显式指定超时的请求默认允许运行 20 分钟。

Claude Code 没有 `thread/read` 这类带外状态查询，watchdog 因此只有两个阈值，不做探活：

- stdout 上任何一帧（`stream_event`、`assistant`、`system`、`result` 等）都算作协议活动。
- 连续 10 分钟没有任何协议活动时，视为疑似停滞，发出 interrupt 控制请求并结束进程。
- 任何单次调用的默认绝对上限为 20 分钟，防止 CLI 异常时永久占用调用槽位。

相关阈值通过 `LLM_REQUEST_TIMEOUT_MS`、`CLAUDE_CODE_CLI_STALL_TIMEOUT_MS`、`CLAUDE_CODE_CLI_WATCHDOG_HARD_TIMEOUT_MS` 和 `CLAUDE_CODE_CLI_WATCHDOG_INTERVAL_MS` 配置。阈值调整应优先修改平台配置，不要在业务服务中复制常量。

进程收尾必须按"先协议、后信号"的顺序，且中间要留出等待窗口：写入 interrupt 控制请求 → 关闭 stdin → 等待自然退出 → SIGTERM → SIGKILL。**不能在写入 interrupt 之后立即发信号**：stdin 里排队的那一行还没被 CLI 读到，默认 SIGTERM 会直接终止进程，interrupt 等于没发。

## 安全边界

- 不读取、复制、输出或持久化 Claude Code 的认证文件或订阅登录令牌。
- 不把模型请求发送到局域网监听地址；本地桥接不接受无随机令牌的请求。
- 不允许 Chat Completions 请求携带模型工具调用。小说业务提示只作为编码后的会话与应用指令传入。
- CLI stderr 只保留短诊断尾部，并对常见凭证形态做脱敏后才允许进入错误信息。

## 失败模式

- **设置页显示 Claude Code，但连接测试失败**：先运行 `claude --version` 与 `claude auth status`（或在交互会话里 `/status`），确认本机登录仍然有效；OAuth 会话过期时 CLI 会返回 `authentication_failed`，需要重新登录。再检查 `CLAUDE_CODE_CLI_PATH`。
- **模型不存在**：在厂商卡片刷新模型目录，选择 `list_models` 当前返回的别名或完整模型名。别名带上下文后缀时形如 `opus[1m]`，方括号是合法字符。
- **推理强度不生效**：检查 `CLAUDE_CODE_CLI_EFFORT`。注意 `list_models` 里缺少 `supportedEffortLevels`（例如 Haiku）**不等于 `--effort` 被忽略**：实测 Haiku 配 `max` 时，一个十来字的回答仍然产生了约 4700 个输出 token。不要用这个字段判断 effort 是否起作用。
- **每次调用都比其他厂商慢一截**：这是每请求一个 CLI 进程的固有启动成本。不要通过复用进程来优化，那会把上一次请求的小说上下文带进下一次。
- **结构化结果偶发不合法**：确认结构化请求没有意外开启 `--include-partial-messages`；同时确认失败信息里带 `json_schema`，否则不会降级到 `prompt_json`。
- **公司 Proxy 在 CLI 可用、工作台不可用**：确认启动服务的 shell 或桌面进程能获得 Proxy 所需环境变量；项目不会从其他文件复制密钥。
- **取消后仍有 CLI 进程残留**：检查收尾顺序里的等待窗口是否被缩短或删除。进程应在 interrupt 宽限期内自然退出，只有无响应时才升级到信号。
- **日志出现固定短超时**：确认业务模块没有覆盖平台默认超时，并检查 `LLM_REQUEST_TIMEOUT_MS` 是否仍保留旧值。
- **长期没有输出但也不报错**：查看 `claudeCode.watchdog` 日志中的最近活动与静默时长；达到停滞阈值后应收到 interrupt，而不是无限等待。

## 相关模块

- `server/src/platform/llm/claudeCode/`
- `server/src/platform/llm/cliBridge/`
- `server/src/llm/factory.ts`
- `server/src/llm/modelCatalog.ts`
- `server/src/llm/structuredOutput.ts`
- `server/src/llm/providers.ts`
- `client/src/pages/settings/components/ProviderConfigDialog.tsx`

## 来源文档

- [Codex CLI 文本模型适配边界](./codex-cli-provider.md)
- [当前模型选择与厂商默认模型边界](./model-selection.md)
- [配置项归属与可见性规范](./configuration-conventions.md)
- [项目协作规则](../../../AGENTS.md)

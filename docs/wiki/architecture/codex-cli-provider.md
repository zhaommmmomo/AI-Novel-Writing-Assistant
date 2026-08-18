# Codex CLI 文本模型适配边界

## 背景

完整创作工作台的 AI 调用统一建立在 LangChain `ChatOpenAI` 兼容接口之上，而部分用户只有 Codex App 或 Codex CLI 的 ChatGPT 登录，没有独立的模型 API Key。直接把 Codex 当作普通 OpenAI API 配置不可行：Codex 登录态不是一个可填写到厂商设置中的 HTTP Key，Codex App 也不向项目暴露通用聊天补全端点。

工作台同时依赖普通文本流、JSON Schema 结构化输出、连接测试、模型目录和多任务模型路由。适配不能只覆盖单次聊天，否则自动导演、章节规划、审校和修复仍会在不同入口失败。

## 决策

Codex 作为内置文本厂商接入，但不直接改写每条业务调用链。服务端在进程内启动一个只监听 `127.0.0.1` 随机端口的 OpenAI Chat Completions 兼容桥接层；现有 LangChain 调用继续使用统一工厂，桥接层再通过 Codex `app-server` 协议执行 `thread/start` 和 `turn/start`。

选择 `app-server` 而不是为每次请求执行独立的 `codex exec`，原因是长篇生产会连续发起大量模型调用。复用单个 app-server 进程可以保留流式事件和模型目录能力，减少重复进程启动成本，同时每次生成仍创建 `ephemeral` thread，不保存小说提示词会话。

## 当前规则

- 内置 provider id 固定为 `codex`，只用于文本生成，不参与图片生成或 Embedding/RAG 厂商列表。
- 未设置 `CODEX_CLI_MODEL_PROVIDER` 时继承 `~/.codex/config.toml` 中的默认 model provider，不额外覆盖 Codex 用户级配置。需要显式覆盖时必须使用配置文件中的真实 provider id；provider id 区分大小写，例如 `OpenAI` 与内置 `openai` 是不同入口。项目本身不读取或保存 Proxy 密钥。
- 默认模型为 `gpt-5.6-sol`，默认推理强度为 `max`。`ultra` 会额外启用自动任务委派，不作为小说生成默认值。
- `CODEX_CLI_PATH` 只接受规范化绝对路径。未设置时通过无 shell 的进程调用执行 `codex`，禁止把用户输入拼进命令字符串。
- 本地 OpenAI 兼容端点只绑定回环地址，并使用每次服务启动随机生成的内存令牌。令牌不写入数据库、日志、env 或前端。
- Codex thread 使用只读 sandbox、`approvalPolicy=never`、空 workspace roots、空 environments、空 dynamic tools，并通过基础指令禁止工具、命令、文件和网络访问。
- 普通响应通过 `item/agentMessage/delta` 转换为 OpenAI SSE；结构化请求把 `response_format.json_schema.schema` 映射到 `turn/start.outputSchema`。
- Codex 原生 `json_schema` 只用于通过严格兼容检查的 schema：对象必须关闭额外字段、所有属性必须进入 `required`，并且不能包含 `propertyNames` 等不支持关键字。`z.record(...)`、`.passthrough()`、可选对象字段等生成不兼容结构时，必须在本地直接降级到 `prompt_json`，不能先向 Codex 发送一个必然返回 HTTP 400 的请求。
- 每个应用请求使用独立 ephemeral thread。服务端停止时必须同时关闭回环 HTTP 服务和 app-server 子进程。
- Codex 默认并发为 1；用户可以在厂商高级设置中提高并发，但应自行承担订阅限额和并行稳定性风险。
- 模型目录来自 `model/list` 动态读取；代码中的模型清单只是首次显示和离线兜底，不是长期事实源。

## 调用监督与超时

文本模型调用统一使用平台级超时策略。未显式指定超时的请求默认允许运行 20 分钟，业务模块不应再为普通世界生成、规划或正文请求写入更短的局部硬超时。确有独立服务等级要求的任务可以显式覆盖，但必须说明原因并保留可取消信号。

Codex 调用不能只依赖业务任务的 `heartbeatAt` 判断健康。业务心跳只能证明 Node 任务仍在运行，不能证明 app-server 中的模型 turn 仍有进展。Codex 适配器必须使用 app-server 控制面监督每个在途 turn：

- `turn/started`、item 事件、文本增量、token usage 和线程状态变化都算作协议活动。
- 连续 3 分钟没有协议活动时，通过 `thread/read` 查询线程状态；`active` 表示可以继续等待，不额外发送模型提示。
- 连续 10 分钟没有任何协议活动时，即使线程仍报告 `active`，也视为疑似停滞并调用 `turn/interrupt`。
- `thread/read` 连续失败两次，或线程进入 `systemError`，应中断 turn 并交给现有错误、备用模型或任务恢复链处理。
- `activeFlags` 出现 `waitingOnApproval` 或 `waitingOnUserInput` 时不算正常处理；当前适配器禁止工具审批与用户追问，应立即按阻塞状态中断。
- 任何单次 Codex turn 的默认绝对上限为 20 分钟，防止控制面异常时永久占用调用槽位。

取消请求时必须处理 `turn/start` 回包竞态：如果取消发生时尚未获得 `turnId`，在后续收到 `turnId` 后仍要补发 `turn/interrupt`。不能只结束 HTTP 请求而让 app-server 中的孤儿 turn 继续运行。

相关阈值通过 `LLM_REQUEST_TIMEOUT_MS`、`CODEX_CLI_IDLE_PROBE_MS`、`CODEX_CLI_STALL_TIMEOUT_MS`、`CODEX_CLI_WATCHDOG_HARD_TIMEOUT_MS`、`CODEX_CLI_WATCHDOG_INTERVAL_MS` 和 `CODEX_CLI_MAX_PROBE_FAILURES` 配置。阈值调整应优先修改平台配置，不要在业务服务中复制常量。

## 安全边界

- 不读取、复制、输出或持久化 Codex 的认证文件、ChatGPT 登录令牌或 `AM_API_KEY`。
- 不把模型请求发送到局域网监听地址；本地桥接不接受无随机令牌的请求。
- 不允许 Chat Completions 请求携带模型工具调用。小说业务提示只作为编码后的会话与应用指令传入。
- app-server stderr 只保留短诊断尾部，并对常见凭证形态做脱敏后才允许进入错误信息。

## 失败模式

- **设置页显示 Codex，但连接测试失败**：先运行 `codex --version` 与 `codex login status`，再检查 `CODEX_CLI_PATH` 和 `CODEX_CLI_MODEL_PROVIDER`。
- **模型不存在**：在厂商卡片刷新模型目录，选择 `model/list` 当前返回的模型，不要依赖旧的静态候选。
- **推理强度不生效**：检查 `CODEX_CLI_REASONING_EFFORT`；支持值为 `low`、`medium`、`high`、`xhigh`、`max`、`ultra`，小说默认使用 `max`。
- **公司 Proxy 在 CLI 可用、工作台不可用**：确认启动服务的 shell 或桌面进程能获得 Proxy 所需环境变量；项目不会从其他文件复制密钥。
- **工作台报 workspace credits depleted，但 Proxy 仍可用**：检查 `CODEX_CLI_MODEL_PROVIDER` 的大小写。显式覆盖值与 `model_providers.<id>` 不完全一致时，Codex 可能选择另一个内置 provider；优先删除覆盖以继承用户级默认，或填写完全一致的 provider id。
- **JSON 结果不稳定**：确认模型路由使用 `json_schema`，并检查 app-server 版本是否支持 `turn/start.outputSchema`。
- **Codex 报 `invalid_json_schema`**：先检查应用实际生成的 schema；包含 `propertyNames`、开放式 `additionalProperties` 或未列入 `required` 的对象属性时应本地降级。模型路由显式选择 `json_schema` 也不能绕过兼容检查。
- **只看到 `systemError` 看不到原因**：app-server 通常会紧接着发送详细 `error` 通知。适配器应短暂等待并优先返回原始错误，例如 `invalid_json_schema`，只有详细通知缺失时才使用通用 `systemError` 文案。
- **长链路速度较慢**：先确认 Codex 厂商并发限制。提高并发前应观察订阅限流和 app-server 稳定性。
- **日志出现固定短超时**：确认业务模块没有覆盖平台默认超时，并检查 `LLM_REQUEST_TIMEOUT_MS` 是否仍保留旧值。
- **线程长期 active 但没有输出**：查看 `codex.watchdog` 日志中的最近活动、探活结果和静默时长；达到停滞阈值后应收到 `turn/interrupt`，而不是无限等待。
- **取消后仍有 Codex 占用**：检查 `turn/start` 延迟回包后是否补发中断；这是取消与 `turnId` 建立之间的竞态，不应通过重复重启任务掩盖。

## 相关模块

- `server/src/platform/llm/codex/`
- `server/src/llm/factory.ts`
- `server/src/llm/modelCatalog.ts`
- `server/src/llm/structuredOutput.ts`
- `server/src/llm/providers.ts`
- `client/src/pages/settings/components/ProviderConfigDialog.tsx`

## 来源文档

- [当前模型选择与厂商默认模型边界](./model-selection.md)
- [配置项归属与可见性规范](./configuration-conventions.md)
- [项目协作规则](../../../AGENTS.md)

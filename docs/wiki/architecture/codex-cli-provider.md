# Codex CLI 文本模型适配边界

## 背景

完整创作工作台的 AI 调用统一建立在 LangChain `ChatOpenAI` 兼容接口之上，而部分用户只有 Codex App 或 Codex CLI 的 ChatGPT 登录，没有独立的模型 API Key。直接把 Codex 当作普通 OpenAI API 配置不可行：Codex 登录态不是一个可填写到厂商设置中的 HTTP Key，Codex App 也不向项目暴露通用聊天补全端点。

工作台同时依赖普通文本流、JSON Schema 结构化输出、连接测试、模型目录和多任务模型路由。适配不能只覆盖单次聊天，否则自动导演、章节规划、审校和修复仍会在不同入口失败。

## 决策

Codex 作为内置文本厂商接入，但不直接改写每条业务调用链。服务端在进程内启动一个只监听 `127.0.0.1` 随机端口的 OpenAI Chat Completions 兼容桥接层；现有 LangChain 调用继续使用统一工厂，桥接层再通过 Codex `app-server` 协议执行 `thread/start` 和 `turn/start`。

选择 `app-server` 而不是为每次请求执行独立的 `codex exec`，原因是长篇生产会连续发起大量模型调用。复用单个 app-server 进程可以保留流式事件和模型目录能力，减少重复进程启动成本，同时每次生成仍创建 `ephemeral` thread，不保存小说提示词会话。

## 当前规则

- 内置 provider id 固定为 `codex`，只用于文本生成，不参与图片生成或 Embedding/RAG 厂商列表。
- 默认通过 `CODEX_CLI_MODEL_PROVIDER=openai` 强制使用 Codex 的 ChatGPT 登录。需要使用本机已有的公司 Codex Proxy 时，可把该启动参数改为对应的 Codex model provider 名称；项目本身不读取或保存 Proxy 密钥。
- 默认模型为 `gpt-5.6-sol`，默认推理强度为 `max`。`ultra` 会额外启用自动任务委派，不作为小说生成默认值。
- `CODEX_CLI_PATH` 只接受规范化绝对路径。未设置时通过无 shell 的进程调用执行 `codex`，禁止把用户输入拼进命令字符串。
- 本地 OpenAI 兼容端点只绑定回环地址，并使用每次服务启动随机生成的内存令牌。令牌不写入数据库、日志、env 或前端。
- Codex thread 使用只读 sandbox、`approvalPolicy=never`、空 workspace roots、空 environments、空 dynamic tools，并通过基础指令禁止工具、命令、文件和网络访问。
- 普通响应通过 `item/agentMessage/delta` 转换为 OpenAI SSE；结构化请求把 `response_format.json_schema.schema` 映射到 `turn/start.outputSchema`。
- 每个应用请求使用独立 ephemeral thread。服务端停止时必须同时关闭回环 HTTP 服务和 app-server 子进程。
- Codex 默认并发为 1；用户可以在厂商高级设置中提高并发，但应自行承担订阅限额和并行稳定性风险。
- 模型目录来自 `model/list` 动态读取；代码中的模型清单只是首次显示和离线兜底，不是长期事实源。

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
- **JSON 结果不稳定**：确认模型路由使用 `json_schema`，并检查 app-server 版本是否支持 `turn/start.outputSchema`。
- **长链路速度较慢**：先确认 Codex 厂商并发限制。提高并发前应观察订阅限流和 app-server 稳定性。

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

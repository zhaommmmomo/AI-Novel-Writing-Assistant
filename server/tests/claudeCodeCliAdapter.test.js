const test = require("node:test");
const assert = require("node:assert/strict");
const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const {
  buildClaudeCodeGenerationArguments,
  ClaudeCodeCliClient,
  ClaudeCodeCliOpenAIProxy,
  extractStreamEventTextDelta,
  normalizeClaudeCodeTokenUsage,
  resolveClaudeCodeEffort,
} = require("../dist/platform/llm/claudeCode/index.js");

async function waitFor(predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition.");
}

function createFakeClient() {
  const calls = [];
  let closed = false;
  return {
    calls,
    get closed() {
      return closed;
    },
    async listModels() {
      return [
        { model: "opus", displayName: "Opus" },
        { model: "hidden-test", hidden: true },
      ];
    },
    async generate(request) {
      calls.push(request);
      request.onDelta?.("甲");
      request.onDelta?.("乙");
      return {
        content: "甲乙",
        usage: {
          totalTokens: 12,
          inputTokens: 8,
          cachedInputTokens: 0,
          outputTokens: 4,
          reasoningOutputTokens: 0,
        },
      };
    },
    async close() {
      closed = true;
    },
  };
}

/**
 * Writes a stand-in for the `claude` binary that speaks the stream-json protocol.
 * `script` receives the parsed stdin frame and may write frames back.
 */
function writeFakeCli(directory, body) {
  const executable = path.join(directory, "fake-claude");
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const marker = process.env.CLAUDE_CODE_TEST_MARKER;
const argv = process.argv.slice(2);
function send(payload) {
  process.stdout.write(JSON.stringify(payload) + "\\n");
}
function note(text) {
  if (marker) {
    fs.appendFileSync(marker, text + "\\n");
  }
}
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const frame = JSON.parse(line);
${body}
});
`, "utf8");
  chmodSync(executable, 0o755);
  return executable;
}

function withFakeCli(body, run) {
  return async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "novel-claude-code-"));
    const marker = path.join(directory, "events.log");
    const executable = writeFakeCli(directory, body);
    const previousPath = process.env.CLAUDE_CODE_CLI_PATH;
    const previousMarker = process.env.CLAUDE_CODE_TEST_MARKER;
    process.env.CLAUDE_CODE_CLI_PATH = executable;
    process.env.CLAUDE_CODE_TEST_MARKER = marker;
    const client = new ClaudeCodeCliClient();
    try {
      await run({ client, marker });
    } finally {
      await client.close();
      if (previousPath === undefined) {
        delete process.env.CLAUDE_CODE_CLI_PATH;
      } else {
        process.env.CLAUDE_CODE_CLI_PATH = previousPath;
      }
      if (previousMarker === undefined) {
        delete process.env.CLAUDE_CODE_TEST_MARKER;
      } else {
        process.env.CLAUDE_CODE_TEST_MARKER = previousMarker;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test("Claude Code effort resolution rejects unsupported levels", () => {
  assert.equal(resolveClaudeCodeEffort(undefined), "max");
  assert.equal(resolveClaudeCodeEffort("  "), "max");
  assert.equal(resolveClaudeCodeEffort("HIGH"), "high");
  assert.equal(resolveClaudeCodeEffort("xhigh"), "xhigh");
  // Codex accepts `ultra`; the Claude Code CLI does not expose that level.
  assert.throws(() => resolveClaudeCodeEffort("ultra"), /CLAUDE_CODE_CLI_EFFORT/u);
});

test("Claude Code generation arguments isolate the CLI from the operator workspace", () => {
  const args = buildClaudeCodeGenerationArguments({
    model: "opus",
    effort: "max",
    developerInstructions: "写一段测试文本。",
  });
  for (const flag of [
    "--print",
    "--verbose",
    "--safe-mode",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--include-partial-messages",
  ]) {
    assert.ok(args.includes(flag), `expected ${flag}`);
  }
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", ""]);
  assert.deepEqual(
    args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2),
    ["--permission-mode", "dontAsk"],
  );
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "opus"]);
  assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", "max"]);
  assert.match(args[args.indexOf("--system-prompt") + 1], /text-generation backend/u);
  assert.equal(args[args.indexOf("--append-system-prompt") + 1], "写一段测试文本。");
  assert.ok(!args.includes("--json-schema"));
});

test("Claude Code schema requests carry --json-schema and stop forwarding text deltas", () => {
  const args = buildClaudeCodeGenerationArguments({
    model: "opus",
    effort: "high",
    developerInstructions: "",
    outputSchema: { type: "object", properties: { value: { type: "string" } } },
  });
  assert.equal(
    args[args.indexOf("--json-schema") + 1],
    '{"type":"object","properties":{"value":{"type":"string"}}}',
  );
  // Deltas would interleave every structured-output retry attempt, so partial messages are off
  // and the caller receives the validated `structured_output` instead.
  assert.ok(!args.includes("--include-partial-messages"));
  assert.ok(!args.includes("--append-system-prompt"));
});

test("Claude Code stream frames only surface text deltas", () => {
  assert.equal(extractStreamEventTextDelta({
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "甲" } },
  }), "甲");
  assert.equal(extractStreamEventTextDelta({
    event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "推理" } },
  }), "");
  assert.equal(extractStreamEventTextDelta({ event: { type: "message_start" } }), "");
  assert.equal(extractStreamEventTextDelta({}), "");
});

test("Claude Code usage normalization maps Anthropic token fields", () => {
  assert.deepEqual(normalizeClaudeCodeTokenUsage({
    input_tokens: 10,
    output_tokens: 4,
    cache_read_input_tokens: 3,
  }), {
    totalTokens: 14,
    inputTokens: 10,
    cachedInputTokens: 3,
    outputTokens: 4,
    reasoningOutputTokens: 0,
  });
  assert.equal(normalizeClaudeCodeTokenUsage({ input_tokens: 0, output_tokens: 0 }), null);
  assert.equal(normalizeClaudeCodeTokenUsage(null), null);
});

test("Claude Code CLI proxy exposes authenticated model and completion endpoints", async () => {
  const client = createFakeClient();
  const proxy = new ClaudeCodeCliOpenAIProxy(client);
  const connection = await proxy.start();
  const headers = {
    Authorization: `Bearer ${connection.apiKey}`,
    "Content-Type": "application/json",
  };

  try {
    const unauthorized = await fetch(`${connection.baseURL}/models`);
    assert.equal(unauthorized.status, 401);

    const modelsResponse = await fetch(`${connection.baseURL}/models`, { headers });
    assert.equal(modelsResponse.status, 200);
    const modelsPayload = await modelsResponse.json();
    assert.deepEqual(modelsPayload.data.map((item) => item.id), ["opus"]);
    assert.equal(modelsPayload.data[0].owned_by, "claude-code-cli");

    const completionResponse = await fetch(`${connection.baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        // Claude Code exposes bracketed context aliases such as `opus[1m]`.
        model: "opus[1m]",
        messages: [
          { role: "system", content: "写一段测试文本。" },
          { role: "user", content: "开始。" },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "result",
            strict: true,
            schema: { type: "object", properties: { value: { type: "string" } } },
          },
        },
      }),
    });
    assert.equal(completionResponse.status, 200);
    const completionPayload = await completionResponse.json();
    assert.equal(completionPayload.choices[0].message.content, "甲乙");
    assert.equal(completionPayload.usage.total_tokens, 12);
    assert.equal(client.calls[0].model, "opus[1m]");
    assert.equal(client.calls[0].outputSchema.type, "object");
    assert.match(client.calls[0].developerInstructions, /写一段测试文本/u);
    assert.match(client.calls[0].input, /开始/u);
  } finally {
    await proxy.close();
  }
  assert.equal(client.closed, true);
});

test("Claude Code CLI proxy rejects model tool calls", async () => {
  const proxy = new ClaudeCodeCliOpenAIProxy(createFakeClient());
  const connection = await proxy.start();
  try {
    const response = await fetch(`${connection.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "opus",
        messages: [{ role: "user", content: "写点东西" }],
        tools: [{ type: "function", function: { name: "run" } }],
      }),
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.error.code, "unsupported_tools");
    assert.match(payload.error.message, /Claude Code CLI/u);
  } finally {
    await proxy.close();
  }
});

test("Claude Code CLI proxy maps deltas to OpenAI-compatible SSE chunks", async () => {
  const proxy = new ClaudeCodeCliOpenAIProxy(createFakeClient());
  const connection = await proxy.start();

  try {
    const response = await fetch(`${connection.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "opus",
        messages: [{ role: "user", content: "流式测试" }],
        stream: true,
      }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/u);
    const body = await response.text();
    assert.match(body, /"content":"甲"/u);
    assert.match(body, /"content":"乙"/u);
    assert.match(body, /"finish_reason":"stop"/u);
    assert.match(body, /data: \[DONE\]/u);
  } finally {
    await proxy.close();
  }
});

test("Claude Code CLI client streams text deltas and reports usage", { concurrency: false }, withFakeCli(`
  if (frame.type !== "user") {
    return;
  }
  note("user-received:" + frame.message.content);
  send({ type: "system", subtype: "init", session_id: "s1", model: "opus" });
  for (const piece of ["甲", "乙"]) {
    send({
      type: "stream_event",
      session_id: "s1",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: piece } },
    });
  }
  send({ type: "assistant", session_id: "s1", message: { role: "assistant", content: [{ type: "text", text: "甲乙" }] } });
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "s1",
    result: "甲乙",
    usage: { input_tokens: 9, output_tokens: 2, cache_read_input_tokens: 0 },
  });
`, async ({ client, marker }) => {
  const deltas = [];
  const result = await client.generate({
    model: "opus",
    developerInstructions: "Return test content.",
    input: "写两个字",
    onDelta: (delta) => deltas.push(delta),
  });
  assert.deepEqual(deltas, ["甲", "乙"]);
  assert.equal(result.content, "甲乙");
  assert.equal(result.usage.inputTokens, 9);
  assert.equal(result.usage.outputTokens, 2);
  assert.match(readFileSync(marker, "utf8"), /user-received:写两个字/u);
}));

test("Claude Code CLI client returns the validated structured output", { concurrency: false }, withFakeCli(`
  if (frame.type !== "user") {
    return;
  }
  note("schema-flag:" + String(argv.includes("--json-schema")));
  send({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "s1",
    result: "{\\"value\\":\\"甲\\"}",
    structured_output: { value: "甲" },
    usage: { input_tokens: 5, output_tokens: 2 },
  });
`, async ({ client, marker }) => {
  const result = await client.generate({
    model: "opus",
    developerInstructions: "Return JSON.",
    input: "生成 JSON",
    outputSchema: { type: "object", properties: { value: { type: "string" } } },
  });
  assert.equal(result.content, '{"value":"甲"}');
  assert.match(readFileSync(marker, "utf8"), /schema-flag:true/u);
}));

test("Claude Code CLI client surfaces a failed result frame", { concurrency: false }, withFakeCli(`
  if (frame.type !== "user") {
    return;
  }
  send({
    type: "assistant",
    session_id: "s1",
    error: "authentication_failed",
    message: { role: "assistant", content: [{ type: "text", text: "Failed to authenticate" }] },
  });
  send({
    type: "result",
    subtype: "success",
    is_error: true,
    terminal_reason: "api_error",
    session_id: "s1",
    result: "Failed to authenticate: OAuth session expired",
    usage: { input_tokens: 0, output_tokens: 0 },
  });
`, async ({ client }) => {
  await assert.rejects(
    client.generate({ model: "opus", developerInstructions: "", input: "写点东西" }),
    /OAuth session expired/u,
  );
}));

test("Claude Code CLI client degrades a structured-retry exhaustion to a json_schema failure", {
  concurrency: false,
}, withFakeCli(`
  if (frame.type !== "user") {
    return;
  }
  send({
    type: "result",
    subtype: "error_max_structured_output_retries",
    is_error: true,
    terminal_reason: "structured_output_retry_exhausted",
    session_id: "s1",
    errors: ["schema validation failed"],
    usage: { input_tokens: 5, output_tokens: 5 },
  });
`, async ({ client }) => {
  // The message must mention json_schema so the shared classifier picks
  // `unsupported_native_json` and the caller can retry with prompt-driven JSON.
  await assert.rejects(
    client.generate({
      model: "opus",
      developerInstructions: "",
      input: "生成 JSON",
      outputSchema: { type: "object" },
    }),
    /json_schema/u,
  );
}));

test("Claude Code CLI client interrupts the CLI when the request is cancelled", {
  concurrency: false,
}, withFakeCli(`
  if (frame.type === "user") {
    note("turn-started");
    return;
  }
  if (frame.type === "control_request" && frame.request.subtype === "interrupt") {
    note("turn-interrupt");
    send({ type: "control_response", response: { subtype: "success", request_id: frame.request_id } });
  }
`, async ({ client, marker }) => {
  const controller = new AbortController();
  const generation = client.generate({
    model: "opus",
    developerInstructions: "",
    input: "写点东西",
    signal: controller.signal,
  });
  await waitFor(() => {
    try {
      return readFileSync(marker, "utf8").includes("turn-started");
    } catch {
      return false;
    }
  });
  controller.abort();
  await assert.rejects(generation, /请求已取消/u);
  await waitFor(() => readFileSync(marker, "utf8").includes("turn-interrupt"));
}));

test("Claude Code CLI client reads the model catalog over the control protocol", {
  concurrency: false,
}, withFakeCli(`
  if (frame.type !== "control_request" || frame.request.subtype !== "list_models") {
    return;
  }
  send({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: frame.request_id,
      response: {
        models: [
          { value: "default", resolvedModel: "claude-opus-5[1m]", displayName: "Default" },
          { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet" },
          { value: "  ", displayName: "Blank" },
        ],
      },
    },
  });
`, async ({ client }) => {
  const models = await client.listModels();
  assert.deepEqual(models.map((item) => item.model), ["default", "sonnet"]);
  assert.equal(models[0].resolvedModel, "claude-opus-5[1m]");
}));

test("Claude Code CLI client reports an exit that arrives before any result", {
  concurrency: false,
}, withFakeCli(`
  if (frame.type === "user") {
    process.stderr.write("boom: api_key=super-secret\\n");
    process.exit(3);
  }
`, async ({ client }) => {
  await assert.rejects(
    client.generate({ model: "opus", developerInstructions: "", input: "写点东西" }),
    (error) => {
      assert.match(error.message, /在返回结果前退出/u);
      assert.match(error.message, /api_key=\[redacted\]/u);
      assert.ok(!error.message.includes("super-secret"));
      return true;
    },
  );
}));

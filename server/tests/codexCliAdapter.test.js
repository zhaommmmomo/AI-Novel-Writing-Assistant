const test = require("node:test");
const assert = require("node:assert/strict");
const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const {
  CodexAppServerClient,
  CodexCliOpenAIProxy,
} = require("../dist/platform/llm/codex/index.js");

async function waitFor(predicate, timeoutMs = 1500) {
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
        { model: "gpt-test", displayName: "GPT Test" },
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

test("Codex CLI proxy exposes authenticated model and completion endpoints", async () => {
  const client = createFakeClient();
  const proxy = new CodexCliOpenAIProxy(client);
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
    assert.deepEqual(modelsPayload.data.map((item) => item.id), ["gpt-test"]);

    const completionResponse = await fetch(`${connection.baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "gpt-test",
        messages: [
          { role: "system", content: "写一段测试文本。" },
          { role: "user", content: "开始。" },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "result",
            strict: true,
            schema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
              additionalProperties: false,
            },
          },
        },
      }),
    });
    assert.equal(completionResponse.status, 200);
    const completionPayload = await completionResponse.json();
    assert.equal(completionPayload.choices[0].message.content, "甲乙");
    assert.equal(completionPayload.usage.total_tokens, 12);
    assert.equal(client.calls[0].model, "gpt-test");
    assert.equal(client.calls[0].outputSchema.type, "object");
    assert.match(client.calls[0].developerInstructions, /写一段测试文本/u);
    assert.match(client.calls[0].input, /开始/u);
  } finally {
    await proxy.close();
  }
  assert.equal(client.closed, true);
});

test("Codex CLI proxy maps Codex deltas to OpenAI-compatible SSE chunks", async () => {
  const client = createFakeClient();
  const proxy = new CodexCliOpenAIProxy(client);
  const connection = await proxy.start();

  try {
    const response = await fetch(`${connection.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-test",
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

test("Codex app-server client interrupts a turn whose id arrives after cancellation", { concurrency: false }, async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "novel-codex-abort-race-"));
  const executable = path.join(directory, "fake-codex");
  const marker = path.join(directory, "events.log");
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const marker = process.env.CODEX_TEST_MARKER;
const input = readline.createInterface({ input: process.stdin });
function reply(id, result) {
  process.stdout.write(JSON.stringify({ id, result }) + "\\n");
}
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    reply(message.id, {});
    return;
  }
  if (message.method === "thread/start") {
    reply(message.id, { thread: { id: "thread-1" } });
    return;
  }
  if (message.method === "turn/start") {
    fs.appendFileSync(marker, "turn-started\\n");
    setTimeout(() => reply(message.id, { turn: { id: "turn-1" } }), 80);
    return;
  }
  if (message.method === "turn/interrupt") {
    fs.appendFileSync(marker, "turn-interrupt:" + message.params.turnId + "\\n");
    reply(message.id, {});
  }
});
`, "utf8");
  chmodSync(executable, 0o755);

  const previousPath = process.env.CODEX_CLI_PATH;
  const previousMarker = process.env.CODEX_TEST_MARKER;
  process.env.CODEX_CLI_PATH = executable;
  process.env.CODEX_TEST_MARKER = marker;
  const client = new CodexAppServerClient();
  const controller = new AbortController();

  try {
    const generation = client.generate({
      model: "gpt-test",
      developerInstructions: "Return test content.",
      input: "test",
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
    await waitFor(() => readFileSync(marker, "utf8").includes("turn-interrupt:turn-1"));
  } finally {
    await client.close();
    if (previousPath === undefined) {
      delete process.env.CODEX_CLI_PATH;
    } else {
      process.env.CODEX_CLI_PATH = previousPath;
    }
    if (previousMarker === undefined) {
      delete process.env.CODEX_TEST_MARKER;
    } else {
      process.env.CODEX_TEST_MARKER = previousMarker;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

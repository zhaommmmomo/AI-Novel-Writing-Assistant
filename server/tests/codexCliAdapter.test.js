const test = require("node:test");
const assert = require("node:assert/strict");
const { CodexCliOpenAIProxy } = require("../dist/platform/llm/codex/index.js");

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

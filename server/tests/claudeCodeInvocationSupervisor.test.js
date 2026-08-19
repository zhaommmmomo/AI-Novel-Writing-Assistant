const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ClaudeCodeInvocationSupervisor,
} = require("../dist/platform/llm/claudeCode/ClaudeCodeInvocationSupervisor.js");

function createHarness(config = {}) {
  let now = 0;
  const events = [];
  const failures = [];
  let interrupts = 0;
  const timer = { unref() {} };
  const supervisor = new ClaudeCodeInvocationSupervisor({
    config: {
      intervalMs: 1_000,
      stallTimeoutMs: 10_000,
      hardTimeoutMs: 20_000,
      ...config,
    },
    scheduler: {
      now: () => now,
      setInterval: () => timer,
      clearInterval: () => undefined,
    },
    onEvent: (event) => events.push(event),
  });
  const handle = supervisor.register({
    sessionKey: "session-1",
    interrupt: async () => {
      interrupts += 1;
    },
    onFailure: (error) => failures.push(error),
  });
  return {
    supervisor,
    handle,
    events,
    failures,
    setNow(value) {
      now = value;
    },
    get interrupts() {
      return interrupts;
    },
  };
}

test("Claude Code watchdog stays quiet while the CLI keeps emitting frames", () => {
  const harness = createHarness();
  for (const timestamp of [4_000, 8_000, 12_000, 16_000]) {
    harness.setNow(timestamp);
    harness.handle.activity("stream_event");
    harness.supervisor.checkNow();
  }
  assert.deepEqual(harness.events, []);
  assert.deepEqual(harness.failures, []);
  assert.equal(harness.interrupts, 0);
});

test("Claude Code watchdog interrupts a silent turn once the stall threshold passes", () => {
  const harness = createHarness();
  harness.setNow(9_000);
  harness.supervisor.checkNow();
  assert.deepEqual(harness.events, []);

  harness.setNow(10_000);
  harness.supervisor.checkNow();
  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0].event, "stalled");
  assert.equal(harness.events[0].sessionKey, "session-1");
  assert.equal(harness.failures.length, 1);
  assert.equal(harness.failures[0].name, "ClaudeCodeStallError");
  assert.equal(harness.interrupts, 1);
});

test("Claude Code watchdog enforces an absolute cap even while frames keep arriving", () => {
  const harness = createHarness();
  for (const timestamp of [5_000, 10_000, 15_000, 19_000]) {
    harness.setNow(timestamp);
    harness.handle.activity("stream_event");
    harness.supervisor.checkNow();
  }
  assert.deepEqual(harness.failures, []);

  harness.setNow(20_000);
  harness.handle.activity("stream_event");
  harness.supervisor.checkNow();
  assert.equal(harness.events.at(-1).event, "hard_timeout");
  assert.equal(harness.failures.length, 1);
  assert.equal(harness.failures[0].name, "TimeoutError");
  assert.equal(harness.interrupts, 1);
});

test("Claude Code watchdog stops reporting after the invocation is released", () => {
  const harness = createHarness();
  harness.handle.stop();
  harness.setNow(30_000);
  harness.supervisor.checkNow();
  assert.deepEqual(harness.events, []);
  assert.deepEqual(harness.failures, []);
  assert.equal(harness.interrupts, 0);
});

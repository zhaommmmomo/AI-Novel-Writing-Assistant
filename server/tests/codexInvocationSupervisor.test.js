const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CodexInvocationSupervisor,
  normalizeCodexThreadRuntimeStatus,
} = require("../dist/platform/llm/codex/CodexInvocationSupervisor.js");

function createHarness(config = {}) {
  let now = 0;
  const events = [];
  const failures = [];
  let interrupts = 0;
  let probes = 0;
  let probe = async () => {
    probes += 1;
    return { type: "active", activeFlags: [] };
  };
  const timer = { unref() {} };
  const supervisor = new CodexInvocationSupervisor({
    config: {
      intervalMs: 1_000,
      idleProbeMs: 3_000,
      stallTimeoutMs: 10_000,
      hardTimeoutMs: 20_000,
      maxProbeFailures: 2,
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
    threadId: "thread-1",
    probe: () => probe(),
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
    setProbe(value) {
      probe = value;
    },
    get interrupts() {
      return interrupts;
    },
    get probes() {
      return probes;
    },
  };
}

test("Codex invocation supervisor probes silent active turns without failing them", async () => {
  const harness = createHarness();
  harness.setNow(3_000);
  await harness.supervisor.checkNow();

  assert.equal(harness.probes, 1);
  assert.equal(harness.failures.length, 0);
  assert.equal(harness.interrupts, 0);
  assert.ok(harness.events.some((event) => event.event === "probe_active"));

  harness.handle.activity("token_usage");
  harness.setNow(5_000);
  await harness.supervisor.checkNow();
  assert.equal(harness.probes, 1);
  harness.handle.stop();
});

test("Codex invocation supervisor interrupts turns after the stall threshold", async () => {
  const harness = createHarness();
  harness.setNow(10_000);
  await harness.supervisor.checkNow();
  await Promise.resolve();

  assert.equal(harness.failures.length, 1);
  assert.equal(harness.failures[0].name, "CodexStallError");
  assert.equal(harness.interrupts, 1);
});

test("Codex invocation supervisor interrupts turns at the hard deadline", async () => {
  const harness = createHarness({ stallTimeoutMs: 30_000, hardTimeoutMs: 20_000 });
  harness.handle.activity("delta");
  harness.setNow(20_000);
  await harness.supervisor.checkNow();
  await Promise.resolve();

  assert.equal(harness.failures.length, 1);
  assert.equal(harness.failures[0].name, "TimeoutError");
  assert.equal(harness.interrupts, 1);
});

test("Codex invocation supervisor fails after repeated control-plane probe errors", async () => {
  const harness = createHarness();
  harness.setProbe(async () => {
    throw new Error("thread/read unavailable");
  });
  harness.setNow(3_000);
  await harness.supervisor.checkNow();
  harness.setNow(4_000);
  await harness.supervisor.checkNow();
  await Promise.resolve();

  assert.equal(harness.failures.length, 1);
  assert.equal(harness.failures[0].name, "CodexProbeError");
  assert.equal(harness.interrupts, 1);
});

test("Codex invocation supervisor rejects interactive blocked states", async () => {
  const harness = createHarness();
  harness.handle.observeStatus({ type: "active", activeFlags: ["waitingOnUserInput"] });
  await Promise.resolve();

  assert.equal(harness.failures.length, 1);
  assert.equal(harness.failures[0].name, "CodexBlockedError");
  assert.equal(harness.interrupts, 1);
});

test("Codex thread status normalization accepts protocol states and rejects unknown values", () => {
  assert.deepEqual(
    normalizeCodexThreadRuntimeStatus({ type: "active", activeFlags: ["waitingOnApproval", 3] }),
    { type: "active", activeFlags: ["waitingOnApproval"] },
  );
  assert.deepEqual(normalizeCodexThreadRuntimeStatus({ type: "idle" }), { type: "idle" });
  assert.throws(() => normalizeCodexThreadRuntimeStatus({ type: "mystery" }), /未知状态/u);
});

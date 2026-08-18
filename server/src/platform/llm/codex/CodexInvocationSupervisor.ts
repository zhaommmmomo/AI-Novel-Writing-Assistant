import type { CodexInvocationWatchdogConfig } from "../../../config/llmInvocation";
import { resolveCodexInvocationWatchdogConfig } from "../../../config/llmInvocation";

export type CodexThreadRuntimeStatus =
  | { type: "active"; activeFlags: string[] }
  | { type: "idle" | "notLoaded" | "systemError" };

export type CodexInvocationSupervisorEvent =
  | "probe_started"
  | "probe_active"
  | "probe_failed"
  | "thread_unavailable"
  | "stalled"
  | "hard_timeout";

export interface CodexInvocationHandle {
  activity(source: string): void;
  observeStatus(status: CodexThreadRuntimeStatus): void;
  stop(): void;
}

interface SupervisedInvocation {
  threadId: string;
  startedAt: number;
  lastActivityAt: number;
  lastProbeAt: number;
  probeFailures: number;
  probeInFlight: boolean;
  activeProbeReported: boolean;
  stopped: boolean;
  probe: () => Promise<CodexThreadRuntimeStatus>;
  interrupt: () => Promise<void>;
  onFailure: (error: Error) => void;
}

interface SupervisorScheduler {
  now: () => number;
  setInterval: (callback: () => void, intervalMs: number) => NodeJS.Timeout;
  clearInterval: (timer: NodeJS.Timeout) => void;
}

interface CodexInvocationSupervisorOptions {
  config?: CodexInvocationWatchdogConfig;
  scheduler?: SupervisorScheduler;
  onEvent?: (input: {
    event: CodexInvocationSupervisorEvent;
    threadId: string;
    elapsedMs: number;
    idleMs: number;
    detail?: string;
  }) => void;
}

const defaultScheduler: SupervisorScheduler = {
  now: () => Date.now(),
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (timer) => clearInterval(timer),
};

function createSupervisorError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function describeBlockedStatus(status: Extract<CodexThreadRuntimeStatus, { type: "active" }>): string | null {
  return status.activeFlags.length > 0 ? status.activeFlags.join(",") : null;
}

export function normalizeCodexThreadRuntimeStatus(value: unknown): CodexThreadRuntimeStatus {
  if (!value || typeof value !== "object") {
    throw new Error("Codex thread/read 未返回有效状态。");
  }
  const candidate = value as { type?: unknown; activeFlags?: unknown };
  if (candidate.type === "active") {
    return {
      type: "active",
      activeFlags: Array.isArray(candidate.activeFlags)
        ? candidate.activeFlags.filter((item): item is string => typeof item === "string")
        : [],
    };
  }
  if (candidate.type === "idle" || candidate.type === "notLoaded" || candidate.type === "systemError") {
    return { type: candidate.type };
  }
  throw new Error("Codex thread/read 返回了未知状态。");
}

export class CodexInvocationSupervisor {
  private readonly config: CodexInvocationWatchdogConfig;
  private readonly scheduler: SupervisorScheduler;
  private readonly onEvent?: CodexInvocationSupervisorOptions["onEvent"];
  private readonly invocations = new Map<string, SupervisedInvocation>();
  private timer: NodeJS.Timeout | null = null;

  constructor(options: CodexInvocationSupervisorOptions = {}) {
    this.config = options.config ?? resolveCodexInvocationWatchdogConfig();
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.onEvent = options.onEvent;
  }

  register(input: {
    threadId: string;
    probe: () => Promise<CodexThreadRuntimeStatus>;
    interrupt: () => Promise<void>;
    onFailure: (error: Error) => void;
  }): CodexInvocationHandle {
    const now = this.scheduler.now();
    const record: SupervisedInvocation = {
      threadId: input.threadId,
      startedAt: now,
      lastActivityAt: now,
      lastProbeAt: 0,
      probeFailures: 0,
      probeInFlight: false,
      activeProbeReported: false,
      stopped: false,
      probe: input.probe,
      interrupt: input.interrupt,
      onFailure: input.onFailure,
    };
    this.invocations.set(input.threadId, record);
    this.ensureTimer();
    return {
      activity: () => {
        if (record.stopped) {
          return;
        }
        record.lastActivityAt = this.scheduler.now();
        record.probeFailures = 0;
        record.activeProbeReported = false;
      },
      observeStatus: (status) => {
        if (record.stopped) {
          return;
        }
        if (status.type === "active") {
          const blockedBy = describeBlockedStatus(status);
          if (blockedBy) {
            this.terminate(
              record,
              createSupervisorError(
                "CodexBlockedError",
                `Codex turn is blocked by unsupported interactive state: ${blockedBy}.`,
              ),
              "thread_unavailable",
              blockedBy,
            );
            return;
          }
          record.lastActivityAt = this.scheduler.now();
          record.probeFailures = 0;
          record.activeProbeReported = false;
          return;
        }
        // The app-server emits a detailed `error` notification around a
        // systemError transition. The client gives that original error a
        // short window to arrive before falling back to a generic message.
      },
      stop: () => this.remove(record),
    };
  }

  async checkNow(): Promise<void> {
    const now = this.scheduler.now();
    await Promise.all([...this.invocations.values()].map((record) => this.inspect(record, now)));
  }

  close(): void {
    for (const record of this.invocations.values()) {
      record.stopped = true;
    }
    this.invocations.clear();
    this.stopTimer();
  }

  private ensureTimer(): void {
    if (this.timer) {
      return;
    }
    this.timer = this.scheduler.setInterval(() => {
      void this.checkNow();
    }, this.config.intervalMs);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (!this.timer) {
      return;
    }
    this.scheduler.clearInterval(this.timer);
    this.timer = null;
  }

  private remove(record: SupervisedInvocation): void {
    if (record.stopped) {
      return;
    }
    record.stopped = true;
    this.invocations.delete(record.threadId);
    if (this.invocations.size === 0) {
      this.stopTimer();
    }
  }

  private async inspect(record: SupervisedInvocation, now: number): Promise<void> {
    if (record.stopped) {
      return;
    }
    const elapsedMs = now - record.startedAt;
    const idleMs = now - record.lastActivityAt;
    if (elapsedMs >= this.config.hardTimeoutMs) {
      this.terminate(
        record,
        createSupervisorError(
          "TimeoutError",
          `Codex turn exceeded hard timeout after ${this.config.hardTimeoutMs}ms.`,
        ),
        "hard_timeout",
      );
      return;
    }
    if (idleMs >= this.config.stallTimeoutMs) {
      this.terminate(
        record,
        createSupervisorError(
          "CodexStallError",
          `Codex turn reported no protocol activity for ${this.config.stallTimeoutMs}ms.`,
        ),
        "stalled",
      );
      return;
    }
    if (
      idleMs < this.config.idleProbeMs
      || record.probeInFlight
      || now - record.lastProbeAt < this.config.intervalMs
    ) {
      return;
    }

    record.probeInFlight = true;
    record.lastProbeAt = now;
    this.emit(record, "probe_started", now, idleMs);
    try {
      const status = await record.probe();
      if (record.stopped) {
        return;
      }
      if (status.type === "active") {
        const blockedBy = describeBlockedStatus(status);
        if (blockedBy) {
          this.terminate(
            record,
            createSupervisorError(
              "CodexBlockedError",
              `Codex turn is blocked by unsupported interactive state: ${blockedBy}.`,
            ),
            "thread_unavailable",
            blockedBy,
          );
          return;
        }
        record.probeFailures = 0;
        if (!record.activeProbeReported) {
          record.activeProbeReported = true;
          this.emit(record, "probe_active", this.scheduler.now(), this.scheduler.now() - record.lastActivityAt);
        }
        return;
      }
      this.terminate(
        record,
        createSupervisorError(
          "CodexThreadUnavailableError",
          `Codex thread became ${status.type} before turn completion.`,
        ),
        "thread_unavailable",
        status.type,
      );
    } catch (error) {
      if (record.stopped) {
        return;
      }
      record.probeFailures += 1;
      const detail = error instanceof Error ? error.message : String(error);
      this.emit(record, "probe_failed", this.scheduler.now(), this.scheduler.now() - record.lastActivityAt, detail);
      if (record.probeFailures >= this.config.maxProbeFailures) {
        this.terminate(
          record,
          createSupervisorError(
            "CodexProbeError",
            `Codex app-server liveness probe failed ${record.probeFailures} times: ${detail}`,
          ),
          "thread_unavailable",
          detail,
        );
      }
    } finally {
      record.probeInFlight = false;
    }
  }

  private terminate(
    record: SupervisedInvocation,
    error: Error,
    event: CodexInvocationSupervisorEvent,
    detail?: string,
  ): void {
    if (record.stopped) {
      return;
    }
    const now = this.scheduler.now();
    this.emit(record, event, now, now - record.lastActivityAt, detail);
    this.remove(record);
    void record.interrupt().catch(() => undefined);
    record.onFailure(error);
  }

  private emit(
    record: SupervisedInvocation,
    event: CodexInvocationSupervisorEvent,
    now: number,
    idleMs: number,
    detail?: string,
  ): void {
    this.onEvent?.({
      event,
      threadId: record.threadId,
      elapsedMs: now - record.startedAt,
      idleMs,
      detail,
    });
  }
}

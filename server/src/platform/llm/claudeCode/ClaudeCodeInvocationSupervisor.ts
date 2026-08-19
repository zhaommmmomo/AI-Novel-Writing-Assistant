import type { ClaudeCodeInvocationWatchdogConfig } from "../../../config/llmInvocation";
import { resolveClaudeCodeInvocationWatchdogConfig } from "../../../config/llmInvocation";

export type ClaudeCodeInvocationSupervisorEvent = "stalled" | "hard_timeout";

export interface ClaudeCodeInvocationHandle {
  activity(source: string): void;
  stop(): void;
}

interface SupervisedInvocation {
  sessionKey: string;
  startedAt: number;
  lastActivityAt: number;
  stopped: boolean;
  interrupt: () => Promise<void>;
  onFailure: (error: Error) => void;
}

interface SupervisorScheduler {
  now: () => number;
  setInterval: (callback: () => void, intervalMs: number) => NodeJS.Timeout;
  clearInterval: (timer: NodeJS.Timeout) => void;
}

interface ClaudeCodeInvocationSupervisorOptions {
  config?: ClaudeCodeInvocationWatchdogConfig;
  scheduler?: SupervisorScheduler;
  onEvent?: (input: {
    event: ClaudeCodeInvocationSupervisorEvent;
    sessionKey: string;
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

/**
 * Watchdog for in-flight Claude Code CLI turns.
 *
 * A per-request child process means the watchdog cannot ask the CLI whether a turn is still
 * progressing the way Codex's `thread/read` allows. Every stdout frame therefore counts as
 * protocol activity, and only two thresholds remain: a silence threshold and an absolute cap.
 * Both end with an interrupt so an unresponsive CLI cannot hold a call slot forever.
 */
export class ClaudeCodeInvocationSupervisor {
  private readonly config: ClaudeCodeInvocationWatchdogConfig;
  private readonly scheduler: SupervisorScheduler;
  private readonly onEvent?: ClaudeCodeInvocationSupervisorOptions["onEvent"];
  private readonly invocations = new Map<string, SupervisedInvocation>();
  private timer: NodeJS.Timeout | null = null;

  constructor(options: ClaudeCodeInvocationSupervisorOptions = {}) {
    this.config = options.config ?? resolveClaudeCodeInvocationWatchdogConfig();
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.onEvent = options.onEvent;
  }

  register(input: {
    sessionKey: string;
    interrupt: () => Promise<void>;
    onFailure: (error: Error) => void;
  }): ClaudeCodeInvocationHandle {
    const now = this.scheduler.now();
    const record: SupervisedInvocation = {
      sessionKey: input.sessionKey,
      startedAt: now,
      lastActivityAt: now,
      stopped: false,
      interrupt: input.interrupt,
      onFailure: input.onFailure,
    };
    this.invocations.set(input.sessionKey, record);
    this.ensureTimer();
    return {
      activity: () => {
        if (record.stopped) {
          return;
        }
        record.lastActivityAt = this.scheduler.now();
      },
      stop: () => this.remove(record),
    };
  }

  checkNow(): void {
    const now = this.scheduler.now();
    for (const record of [...this.invocations.values()]) {
      this.inspect(record, now);
    }
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
    this.timer = this.scheduler.setInterval(() => this.checkNow(), this.config.intervalMs);
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
    this.invocations.delete(record.sessionKey);
    if (this.invocations.size === 0) {
      this.stopTimer();
    }
  }

  private inspect(record: SupervisedInvocation, now: number): void {
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
          `Claude Code turn exceeded hard timeout after ${this.config.hardTimeoutMs}ms.`,
        ),
        "hard_timeout",
      );
      return;
    }
    if (idleMs >= this.config.stallTimeoutMs) {
      this.terminate(
        record,
        createSupervisorError(
          "ClaudeCodeStallError",
          `Claude Code turn reported no protocol activity for ${this.config.stallTimeoutMs}ms.`,
        ),
        "stalled",
      );
    }
  }

  private terminate(
    record: SupervisedInvocation,
    error: Error,
    event: ClaudeCodeInvocationSupervisorEvent,
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
    event: ClaudeCodeInvocationSupervisorEvent,
    now: number,
    idleMs: number,
    detail?: string,
  ): void {
    this.onEvent?.({
      event,
      sessionKey: record.sessionKey,
      elapsedMs: now - record.startedAt,
      idleMs,
      detail,
    });
  }
}

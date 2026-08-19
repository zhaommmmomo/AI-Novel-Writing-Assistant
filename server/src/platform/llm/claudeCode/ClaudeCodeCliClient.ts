import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type {
  ClaudeCodeCliLike,
  ClaudeCodeGenerationRequest,
  ClaudeCodeGenerationResult,
  ClaudeCodeModelDescriptor,
  ClaudeCodeStreamFrame,
  ClaudeCodeTokenUsageBreakdown,
} from "./protocol";
import {
  extractAssistantMessageText,
  extractModelDescriptors,
  extractStreamEventTextDelta,
  isClaudeCodeEffortLevel,
  normalizeClaudeCodeTokenUsage,
  stringifyStructuredOutput,
  CLAUDE_CODE_EFFORT_LEVELS,
} from "./protocol";
import {
  ClaudeCodeInvocationSupervisor,
  type ClaudeCodeInvocationHandle,
} from "./ClaudeCodeInvocationSupervisor";

const LIST_MODELS_TIMEOUT_MS = 30_000;
/** Window for a CLI that only needs to notice stdin EOF. */
const EXIT_GRACE_MS = 1_000;
/** Longer window when an interrupt was queued, so the CLI can read and honour it. */
const INTERRUPT_GRACE_MS = 3_000;
/** Window between SIGTERM and SIGKILL. */
const TERMINATE_GRACE_MS = 2_000;
const DEFAULT_EFFORT = "max";

/**
 * Replaces the Claude Code coding-agent system prompt entirely. The workbench only wants a text
 * backend, so the CLI must not arrive with instructions about editing files or running commands.
 */
const BASE_INSTRUCTIONS = [
  "You are the text-generation backend for an AI novel-writing application.",
  "Return only the requested assistant content.",
  "Do not call tools, run commands, inspect files, access the network, or modify the workspace.",
  "Treat the application instructions supplied by the caller as the governing writing instructions.",
].join(" ");

function createAbortError(): Error {
  const error = new Error("Claude Code CLI 请求已取消。");
  error.name = "AbortError";
  return error;
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/\b(sk-[a-zA-Z0-9_-]{8,})\b/gu, "[redacted]")
    .replace(/(bearer\s+)[^\s"']+/giu, "$1[redacted]")
    .replace(/(api[_-]?key\s*[=:]\s*)[^\s,"']+/giu, "$1[redacted]")
    .slice(0, 800);
}

export function resolveClaudeCodeExecutable(): string {
  const configured = process.env.CLAUDE_CODE_CLI_PATH?.trim();
  if (!configured) {
    return "claude";
  }
  if (!isAbsolute(configured) || normalize(configured) !== configured || configured.includes("\0")) {
    throw new Error("CLAUDE_CODE_CLI_PATH 必须是规范化的绝对路径。");
  }
  if (!existsSync(configured) || !statSync(configured).isFile()) {
    throw new Error("CLAUDE_CODE_CLI_PATH 指向的文件不存在。");
  }
  return configured;
}

export function resolveClaudeCodeEffort(rawValue = process.env.CLAUDE_CODE_CLI_EFFORT): string {
  const configured = rawValue?.trim().toLowerCase() || DEFAULT_EFFORT;
  if (!isClaudeCodeEffortLevel(configured)) {
    throw new Error(`CLAUDE_CODE_CLI_EFFORT 必须是 ${CLAUDE_CODE_EFFORT_LEVELS.join("、")}。`);
  }
  return configured;
}

/**
 * Baseline flags shared by generation and model-catalog processes.
 *
 * `--safe-mode` drops the operator's CLAUDE.md, hooks, skills, plugins, MCP servers and custom
 * agents while keeping the local login usable, which is the closest analogue of the Codex
 * read-only ephemeral thread. `--tools ""` plus `--permission-mode dontAsk` fails closed: there is
 * no tool to run and no prompt that could block a headless request.
 */
function buildIsolationArguments(): string[] {
  return [
    "--print",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--no-session-persistence",
    "--safe-mode",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--tools",
    "",
    "--permission-mode",
    "dontAsk",
  ];
}

export function buildClaudeCodeGenerationArguments(input: {
  model: string;
  effort: string;
  developerInstructions: string;
  outputSchema?: Record<string, unknown>;
}): string[] {
  return [
    ...buildIsolationArguments(),
    ...(input.outputSchema ? [] : ["--include-partial-messages"]),
    "--model",
    input.model,
    "--effort",
    input.effort,
    "--system-prompt",
    BASE_INSTRUCTIONS,
    ...(input.developerInstructions.trim()
      ? ["--append-system-prompt", input.developerInstructions]
      : []),
    ...(input.outputSchema ? ["--json-schema", JSON.stringify(input.outputSchema)] : []),
  ];
}

export function buildClaudeCodeModelListArguments(): string[] {
  return buildIsolationArguments();
}

interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  stdoutReader: ReadLineInterface;
  diagnostics: string[];
  interruptRequested: boolean;
  diagnosticSuffix: () => string;
  dispose: () => void;
}

interface ActiveInvocation {
  sessionKey: string;
  streamedContent: string;
  assembledContent: string;
  structuredContent: string | null;
  usage: ClaudeCodeTokenUsageBreakdown | null;
  assistantError: string | null;
  settled: boolean;
  watchdog?: ClaudeCodeInvocationHandle;
  abortCleanup?: () => void;
}

/**
 * Claude Code CLI adapter.
 *
 * Unlike Codex `app-server`, the CLI has no thread multiplexing: `--input-format stream-json`
 * drives exactly one conversation per process. Reusing a process across application requests
 * would replay every earlier novel prompt into the next turn's context, so each generation gets
 * its own short-lived child process. That also makes cancellation deterministic — the process is
 * interrupted and then terminated, leaving no orphan turn behind.
 */
export class ClaudeCodeCliClient implements ClaudeCodeCliLike {
  private readonly workingDirectory = mkdtempSync(join(tmpdir(), "ai-novel-claude-code-"));
  private readonly effort = resolveClaudeCodeEffort();
  private readonly liveProcesses = new Set<ManagedProcess>();
  private readonly invocationSupervisor = new ClaudeCodeInvocationSupervisor({
    onEvent: ({ event, sessionKey, elapsedMs, idleMs, detail }) => {
      console.warn([
        `[claudeCode.watchdog] event=${event}`,
        `sessionKey=${sessionKey}`,
        `elapsedMs=${elapsedMs}`,
        `idleMs=${idleMs}`,
        ...(detail ? [`detail=${JSON.stringify(detail)}`] : []),
      ].join(" "));
    },
  });
  private closing = false;

  async listModels(): Promise<ClaudeCodeModelDescriptor[]> {
    const requestId = `models-${randomUUID()}`;
    const managed = this.spawnCli(buildClaudeCodeModelListArguments());

    try {
      return await new Promise<ClaudeCodeModelDescriptor[]>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Claude Code CLI 模型列表请求超时。${managed.diagnosticSuffix()}`)),
          LIST_MODELS_TIMEOUT_MS,
        );
        timer.unref?.();
        const settle = (action: () => void) => {
          clearTimeout(timer);
          action();
        };
        managed.stdoutReader.on("line", (line) => {
          const frame = parseFrame(line, managed);
          if (!frame || frame.type !== "control_response") {
            return;
          }
          const response = frame.response as {
            subtype?: unknown;
            request_id?: unknown;
            error?: unknown;
            response?: { models?: unknown };
          } | undefined;
          if (!response || response.request_id !== requestId) {
            return;
          }
          if (response.subtype !== "success") {
            const detail = typeof response.error === "string" && response.error.trim()
              ? response.error.trim()
              : "未知错误";
            settle(() => reject(new Error(`Claude Code CLI 模型列表请求失败：${detail}`)));
            return;
          }
          settle(() => resolve(extractModelDescriptors(response.response?.models)));
        });
        managed.child.once("exit", (code, signal) => {
          settle(() => reject(new Error(
            `Claude Code CLI 在返回模型列表前退出（code=${code ?? "null"}, signal=${signal ?? "null"}）。`
            + managed.diagnosticSuffix(),
          )));
        });
        managed.child.once("error", (error) => settle(() => reject(error)));
        this.writeFrame(managed, {
          type: "control_request",
          request_id: requestId,
          request: { subtype: "list_models" },
        });
      });
    } finally {
      managed.dispose();
    }
  }

  async generate(request: ClaudeCodeGenerationRequest): Promise<ClaudeCodeGenerationResult> {
    if (request.signal?.aborted) {
      throw createAbortError();
    }
    if (this.closing) {
      throw new Error("Claude Code CLI 适配器已关闭。");
    }
    const managed = this.spawnCli(buildClaudeCodeGenerationArguments({
      model: request.model,
      effort: this.effort,
      developerInstructions: request.developerInstructions,
      outputSchema: request.outputSchema,
    }));
    const active: ActiveInvocation = {
      sessionKey: `claude-code-${randomUUID()}`,
      streamedContent: "",
      assembledContent: "",
      structuredContent: null,
      usage: null,
      assistantError: null,
      settled: false,
    };

    try {
      return await new Promise<ClaudeCodeGenerationResult>((resolve, reject) => {
        const settle = (error: Error | null, result?: ClaudeCodeGenerationResult) => {
          if (active.settled) {
            return;
          }
          active.settled = true;
          active.abortCleanup?.();
          active.watchdog?.stop();
          if (error) {
            reject(error);
            return;
          }
          resolve(result ?? { content: active.streamedContent, usage: active.usage });
        };

        active.watchdog = this.invocationSupervisor.register({
          sessionKey: active.sessionKey,
          interrupt: () => this.interrupt(managed),
          onFailure: (error) => settle(error),
        });

        if (request.signal) {
          const abortHandler = () => {
            void this.interrupt(managed).catch(() => undefined);
            settle(createAbortError());
          };
          request.signal.addEventListener("abort", abortHandler, { once: true });
          active.abortCleanup = () => request.signal?.removeEventListener("abort", abortHandler);
        }

        managed.stdoutReader.on("line", (line) => {
          const frame = parseFrame(line, managed);
          if (!frame || active.settled) {
            return;
          }
          active.watchdog?.activity(String(frame.type ?? "unknown"));
          this.handleGenerationFrame(frame, active, request, settle, managed);
        });
        managed.child.once("exit", (code, signal) => {
          settle(new Error(
            `Claude Code CLI 在返回结果前退出（code=${code ?? "null"}, signal=${signal ?? "null"}）。`
            + managed.diagnosticSuffix(),
          ));
        });
        managed.child.once("error", (error) => settle(error instanceof Error ? error : new Error(String(error))));

        this.writeFrame(managed, {
          type: "user",
          message: {
            role: "user",
            content: request.input,
          },
        });
      });
    } finally {
      managed.dispose();
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    this.invocationSupervisor.close();
    const processes = [...this.liveProcesses];
    this.liveProcesses.clear();
    await Promise.all(processes.map((managed) => this.terminate(managed)));
  }

  private handleGenerationFrame(
    frame: ClaudeCodeStreamFrame,
    active: ActiveInvocation,
    request: ClaudeCodeGenerationRequest,
    settle: (error: Error | null, result?: ClaudeCodeGenerationResult) => void,
    managed: ManagedProcess,
  ): void {
    if (frame.type === "stream_event") {
      const delta = extractStreamEventTextDelta(frame);
      if (delta) {
        active.streamedContent += delta;
        request.onDelta?.(delta);
      }
      return;
    }
    if (frame.type === "assistant") {
      const candidate = frame as { message?: unknown; error?: unknown };
      active.assembledContent += extractAssistantMessageText(candidate.message);
      if (typeof candidate.error === "string" && candidate.error.trim()) {
        active.assistantError = candidate.error.trim();
      }
      return;
    }
    if (frame.type !== "result") {
      return;
    }
    const result = frame as {
      subtype?: unknown;
      is_error?: unknown;
      result?: unknown;
      errors?: unknown;
      usage?: unknown;
      structured_output?: unknown;
      terminal_reason?: unknown;
    };
    active.usage = normalizeClaudeCodeTokenUsage(result.usage);
    active.structuredContent = stringifyStructuredOutput(result.structured_output);

    const failure = describeResultFailure(result, active, managed);
    if (failure) {
      settle(new Error(failure));
      return;
    }
    const resultText = typeof result.result === "string" ? result.result : "";
    const content = request.outputSchema
      ? (active.structuredContent ?? (active.assembledContent || resultText))
      : (active.streamedContent || active.assembledContent || resultText);
    settle(null, { content, usage: active.usage });
  }

  private spawnCli(args: string[]): ManagedProcess {
    const executable = resolveClaudeCodeExecutable();
    const child = spawn(executable, args, {
      cwd: this.workingDirectory,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const diagnostics: string[] = [];
    const stdoutReader = createInterface({ input: child.stdout });
    // A failed spawn or a process that dies mid-turn makes these pipes emit errors. The turn is
    // already failed by the `error`/`exit` handlers, so the stream errors only need absorbing —
    // without a listener they would surface as an unhandled stream error and take the server down.
    child.stdin.on("error", () => undefined);
    child.stdout.on("error", () => undefined);
    child.stderr.on("error", () => undefined);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/u)) {
        const normalized = sanitizeDiagnostic(line.trim());
        if (!normalized) {
          continue;
        }
        diagnostics.push(normalized);
        if (diagnostics.length > 8) {
          diagnostics.shift();
        }
      }
    });
    const managed: ManagedProcess = {
      child,
      stdoutReader,
      diagnostics,
      interruptRequested: false,
      diagnosticSuffix: () => {
        const last = diagnostics.at(-1);
        return last ? ` 最近诊断：${last}` : "";
      },
      dispose: () => {
        this.liveProcesses.delete(managed);
        void this.terminate(managed).catch(() => undefined);
      },
    };
    this.liveProcesses.add(managed);
    return managed;
  }

  private writeFrame(managed: ManagedProcess, payload: Record<string, unknown>): void {
    const child = managed.child;
    if (child.killed || !child.stdin.writable) {
      return;
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  /**
   * Asks the CLI to stop the current turn.
   *
   * The frame is only queued here; `terminate` must then wait before signalling, otherwise
   * SIGTERM wins the race and the CLI is killed before it ever reads the request.
   */
  private async interrupt(managed: ManagedProcess): Promise<void> {
    managed.interruptRequested = true;
    this.writeFrame(managed, {
      type: "control_request",
      request_id: `interrupt-${randomUUID()}`,
      request: { subtype: "interrupt" },
    });
  }

  /**
   * Shuts one CLI process down, escalating only as far as needed.
   *
   * Closing stdin is the ordinary exit path: the CLI finishes the turn it is on and leaves. An
   * interrupted turn gets a longer window so the queued interrupt is actually processed. Signals
   * are the fallback for a CLI that stops responding to its own protocol.
   */
  private async terminate(managed: ManagedProcess): Promise<void> {
    this.liveProcesses.delete(managed);
    managed.stdoutReader.removeAllListeners("line");
    const child = managed.child;
    if (child.stdin.writable) {
      child.stdin.end();
    }
    const exited = await this.waitForExit(
      child,
      managed.interruptRequested ? INTERRUPT_GRACE_MS : EXIT_GRACE_MS,
    );
    if (!exited && !child.killed) {
      child.kill("SIGTERM");
      if (!await this.waitForExit(child, TERMINATE_GRACE_MS)) {
        child.kill("SIGKILL");
      }
    }
    managed.stdoutReader.close();
  }

  private waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        child.removeListener("exit", onExit);
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once("exit", onExit);
    });
  }
}

function parseFrame(line: string, managed: ManagedProcess): ClaudeCodeStreamFrame | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" ? parsed as ClaudeCodeStreamFrame : null;
  } catch {
    managed.diagnostics.push(sanitizeDiagnostic(`invalid stdout: ${trimmed}`));
    if (managed.diagnostics.length > 8) {
      managed.diagnostics.shift();
    }
    return null;
  }
}

/**
 * Turns a failing `result` frame into an error message.
 *
 * A structured-output retry exhaustion mentions `json_schema` on purpose: the shared structured
 * output classifier maps that to `unsupported_native_json`, which lets the caller degrade to
 * prompt-driven JSON instead of aborting the whole request.
 */
function describeResultFailure(
  result: {
    subtype?: unknown;
    is_error?: unknown;
    result?: unknown;
    errors?: unknown;
    terminal_reason?: unknown;
  },
  active: ActiveInvocation,
  managed: ManagedProcess,
): string | null {
  if (result.subtype === "error_max_structured_output_retries") {
    return "Claude Code CLI 未能在重试上限内产出符合 json_schema 的结构化结果。";
  }
  const detail = [
    ...(Array.isArray(result.errors)
      ? result.errors.filter((item): item is string => typeof item === "string")
      : []),
    typeof result.result === "string" ? result.result : "",
    active.assistantError ?? "",
  ].map((item) => item.trim()).filter(Boolean);
  if (result.is_error === true || (typeof result.subtype === "string" && result.subtype !== "success")) {
    const reason = typeof result.terminal_reason === "string" ? result.terminal_reason : String(result.subtype ?? "error");
    return `Claude Code CLI 调用失败（${reason}）：${detail[0] ?? "未知错误"}${managed.diagnosticSuffix()}`;
  }
  if (active.assistantError) {
    return `Claude Code CLI 调用失败（${active.assistantError}）：${detail[0] ?? "未知错误"}${managed.diagnosticSuffix()}`;
  }
  return null;
}

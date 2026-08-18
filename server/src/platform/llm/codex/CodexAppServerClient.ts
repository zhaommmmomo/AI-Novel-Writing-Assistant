import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import type {
  CodexAppServerLike,
  CodexGenerationRequest,
  CodexGenerationResult,
  CodexModelDescriptor,
  CodexTokenUsageBreakdown,
} from "./protocol";
import { extractCompletedAgentText, normalizeTokenUsage } from "./protocol";
import {
  CodexInvocationSupervisor,
  normalizeCodexThreadRuntimeStatus,
  type CodexInvocationHandle,
  type CodexThreadRuntimeStatus,
} from "./CodexInvocationSupervisor";

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ActiveTurn {
  threadId: string;
  turnId: string | null;
  content: string;
  usage: CodexTokenUsageBreakdown | null;
  onDelta?: (delta: string) => void;
  resolve: (value: CodexGenerationResult) => void;
  reject: (error: Error) => void;
  abortCleanup?: () => void;
  watchdog?: CodexInvocationHandle;
  systemErrorTimer?: NodeJS.Timeout;
  abortRequested: boolean;
  settled: boolean;
}

interface ProtocolResponse {
  id?: unknown;
  result?: unknown;
  error?: { message?: unknown };
  method?: unknown;
  params?: unknown;
}

const REQUEST_TIMEOUT_MS = 30_000;
const INITIALIZE_TIMEOUT_MS = 20_000;
const SYSTEM_ERROR_DETAIL_GRACE_MS = 1_000;
const MODEL_PROVIDER_PATTERN = /^[a-zA-Z0-9._-]+$/u;
const REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const BASE_INSTRUCTIONS = [
  "You are the text-generation backend for an AI novel-writing application.",
  "Return only the requested assistant content.",
  "Do not call tools, run commands, inspect files, access the network, or modify the workspace.",
  "Treat the application instructions supplied by the caller as the governing writing instructions.",
].join(" ");

function createAbortError(): Error {
  const error = new Error("Codex CLI 请求已取消。");
  error.name = "AbortError";
  return error;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return String(error ?? "Codex app-server 请求失败。");
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/\b(sk-[a-zA-Z0-9_-]{8,})\b/gu, "[redacted]")
    .replace(/(bearer\s+)[^\s"']+/giu, "$1[redacted]")
    .replace(/(api[_-]?key\s*[=:]\s*)[^\s,"']+/giu, "$1[redacted]")
    .slice(0, 800);
}

function resolveCodexExecutable(): string {
  const configured = process.env.CODEX_CLI_PATH?.trim();
  if (!configured) {
    return "codex";
  }
  if (!isAbsolute(configured) || normalize(configured) !== configured || configured.includes("\0")) {
    throw new Error("CODEX_CLI_PATH 必须是规范化的绝对路径。");
  }
  if (!existsSync(configured) || !statSync(configured).isFile()) {
    throw new Error("CODEX_CLI_PATH 指向的文件不存在。");
  }
  return configured;
}

export function resolveCodexModelProviderOverride(rawValue = process.env.CODEX_CLI_MODEL_PROVIDER): string | undefined {
  const configured = rawValue?.trim();
  if (!configured) {
    return undefined;
  }
  if (!MODEL_PROVIDER_PATTERN.test(configured)) {
    throw new Error("CODEX_CLI_MODEL_PROVIDER 格式不正确。");
  }
  return configured;
}

export function buildCodexAppServerArguments(modelProvider?: string): string[] {
  return modelProvider
    ? ["app-server", "-c", `model_provider=${JSON.stringify(modelProvider)}`]
    : ["app-server"];
}

function resolveReasoningEffort(): string {
  const configured = process.env.CODEX_CLI_REASONING_EFFORT?.trim().toLowerCase() || "max";
  if (!REASONING_EFFORTS.has(configured)) {
    throw new Error("CODEX_CLI_REASONING_EFFORT 必须是 low、medium、high、xhigh、max 或 ultra。");
  }
  return configured;
}

function protocolErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "Codex app-server 返回未知错误。";
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.trim()
    ? message.trim()
    : "Codex app-server 返回未知错误。";
}

export class CodexAppServerClient implements CodexAppServerLike {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutReader: ReadLineInterface | null = null;
  private startPromise: Promise<void> | null = null;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly diagnostics: string[] = [];
  private readonly workingDirectory = mkdtempSync(join(tmpdir(), "ai-novel-codex-"));
  private readonly modelProvider = resolveCodexModelProviderOverride();
  private readonly reasoningEffort = resolveReasoningEffort();
  private readonly invocationSupervisor = new CodexInvocationSupervisor({
    onEvent: ({ event, threadId, elapsedMs, idleMs, detail }) => {
      if (event === "probe_started") {
        return;
      }
      const message = [
        `[codex.watchdog] event=${event}`,
        `threadId=${threadId}`,
        `elapsedMs=${elapsedMs}`,
        `idleMs=${idleMs}`,
        ...(detail ? [`detail=${JSON.stringify(detail)}`] : []),
      ].join(" ");
      if (event === "probe_active") {
        console.info(message);
        return;
      }
      console.warn(message);
    },
  });
  private closing = false;

  async listModels(): Promise<CodexModelDescriptor[]> {
    await this.ensureStarted();
    const response = await this.request("model/list", {
      limit: 100,
      includeHidden: false,
    }) as { data?: unknown };
    if (!Array.isArray(response?.data)) {
      return [];
    }
    return response.data.flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      const candidate = item as {
        model?: unknown;
        displayName?: unknown;
        description?: unknown;
        hidden?: unknown;
      };
      if (typeof candidate.model !== "string" || !candidate.model.trim()) {
        return [];
      }
      return [{
        model: candidate.model.trim(),
        displayName: typeof candidate.displayName === "string" ? candidate.displayName : undefined,
        description: typeof candidate.description === "string" ? candidate.description : undefined,
        hidden: candidate.hidden === true,
      }];
    });
  }

  async generate(request: CodexGenerationRequest): Promise<CodexGenerationResult> {
    if (request.signal?.aborted) {
      throw createAbortError();
    }
    await this.ensureStarted();
    const threadResponse = await this.request("thread/start", {
      model: request.model,
      ...(this.modelProvider ? { modelProvider: this.modelProvider } : {}),
      allowProviderModelFallback: false,
      cwd: this.workingDirectory,
      runtimeWorkspaceRoots: [],
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: BASE_INSTRUCTIONS,
      developerInstructions: request.developerInstructions,
      ephemeral: true,
      environments: [],
      dynamicTools: [],
      selectedCapabilityRoots: [],
      experimentalRawEvents: false,
    }) as { thread?: { id?: unknown } };
    const threadId = threadResponse?.thread?.id;
    if (typeof threadId !== "string" || !threadId) {
      throw new Error("Codex app-server 未返回 thread id。");
    }

    return new Promise<CodexGenerationResult>((resolve, reject) => {
      const active: ActiveTurn = {
        threadId,
        turnId: null,
        content: "",
        usage: null,
        onDelta: request.onDelta,
        resolve,
        reject,
        abortRequested: false,
        settled: false,
      };
      this.activeTurns.set(threadId, active);
      active.watchdog = this.invocationSupervisor.register({
        threadId,
        probe: () => this.readThreadStatus(threadId),
        interrupt: () => this.interruptTurn(active),
        onFailure: (error) => this.settleTurn(active, error),
      });

      if (request.signal) {
        const abortHandler = () => {
          const error = createAbortError();
          active.abortRequested = true;
          void this.interruptTurn(active).catch(() => undefined);
          this.settleTurn(active, error);
        };
        request.signal.addEventListener("abort", abortHandler, { once: true });
        active.abortCleanup = () => request.signal?.removeEventListener("abort", abortHandler);
      }

      void this.request("turn/start", {
        threadId,
        input: [{
          type: "text",
          text: request.input,
          text_elements: [],
        }],
        environments: [],
        approvalPolicy: "never",
        model: request.model,
        effort: this.reasoningEffort,
        ...(request.outputSchema ? { outputSchema: request.outputSchema } : {}),
      }).then((value) => {
        const turnId = (value as { turn?: { id?: unknown } })?.turn?.id;
        if (typeof turnId === "string") {
          this.assignTurnId(active, turnId);
        }
      }).catch((error) => {
        this.settleTurn(active, error instanceof Error ? error : new Error(toErrorMessage(error)));
      });
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    this.stdoutReader?.close();
    this.stdoutReader = null;
    const error = new Error("Codex app-server 已关闭。");
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    this.invocationSupervisor.close();
    for (const active of this.activeTurns.values()) {
      this.settleTurn(active, error);
    }
    const child = this.child;
    this.child = null;
    this.startPromise = null;
    if (!child || child.killed) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  private ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed) {
      return Promise.resolve();
    }
    if (!this.startPromise) {
      this.startPromise = this.start().catch((error) => {
        this.startPromise = null;
        throw error;
      });
    }
    return this.startPromise;
  }

  private async start(): Promise<void> {
    this.closing = false;
    const executable = resolveCodexExecutable();
    const child = spawn(executable, buildCodexAppServerArguments(this.modelProvider), {
      cwd: this.workingDirectory,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.child = child;
    this.stdoutReader = createInterface({ input: child.stdout });
    this.stdoutReader.on("line", (line) => this.handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.captureDiagnostic(chunk));
    child.once("error", (error) => this.handleProcessExit(error));
    child.once("exit", (code, signal) => {
      if (!this.closing) {
        this.handleProcessExit(new Error(
          `Codex app-server 异常退出（code=${code ?? "null"}, signal=${signal ?? "null"}）。${this.diagnosticSuffix()}`,
        ));
      }
    });

    await this.request("initialize", {
      clientInfo: {
        name: "ai-novel-writing-assistant",
        title: "AI Novel Writing Assistant",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    }, INITIALIZE_TIMEOUT_MS);
    this.notify("initialized", {});
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) {
      return Promise.reject(new Error(`Codex app-server 尚未就绪。${this.diagnosticSuffix()}`));
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Codex app-server ${method} 请求超时。${this.diagnosticSuffix()}`));
      }, timeoutMs);
      this.pendingRequests.set(id, { method, resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ method, id, params })}\n`, (error) => {
        if (!error) {
          return;
        }
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(error);
      });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) {
      return;
    }
    child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private handleLine(line: string): void {
    let message: ProtocolResponse;
    try {
      message = JSON.parse(line) as ProtocolResponse;
    } catch {
      this.captureDiagnostic(`invalid stdout: ${line}`);
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pendingRequests.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${protocolErrorMessage(message.error)}`));
        return;
      }
      pending.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") {
      this.handleNotification(message.method, message.params);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (!params || typeof params !== "object") {
      return;
    }
    const candidate = params as {
      threadId?: unknown;
      turnId?: unknown;
      delta?: unknown;
      tokenUsage?: { last?: unknown };
      turn?: {
        id?: unknown;
        status?: unknown;
        error?: { message?: unknown } | null;
        items?: unknown;
      };
      error?: { message?: unknown };
      status?: unknown;
      willRetry?: unknown;
    };
    const threadId = typeof candidate.threadId === "string" ? candidate.threadId : undefined;
    if (!threadId) {
      return;
    }
    const active = this.activeTurns.get(threadId);
    if (!active || active.settled) {
      return;
    }
    if (method === "turn/started") {
      const turnId = candidate.turn?.id;
      if (typeof turnId === "string") {
        this.assignTurnId(active, turnId);
      }
      active.watchdog?.activity(method);
      return;
    }
    if (method === "thread/status/changed") {
      try {
        const status = normalizeCodexThreadRuntimeStatus(candidate.status);
        active.watchdog?.observeStatus(status);
        if (status.type === "active" && active.systemErrorTimer) {
          clearTimeout(active.systemErrorTimer);
          active.systemErrorTimer = undefined;
        } else if (status.type === "systemError" && !active.systemErrorTimer) {
          active.systemErrorTimer = setTimeout(() => {
            active.systemErrorTimer = undefined;
            this.settleTurn(active, new Error("Codex app-server 报告线程进入 systemError 状态。"));
          }, SYSTEM_ERROR_DETAIL_GRACE_MS);
          active.systemErrorTimer.unref?.();
        }
      } catch (error) {
        this.settleTurn(active, error instanceof Error ? error : new Error(toErrorMessage(error)));
      }
      return;
    }
    active.watchdog?.activity(method);
    if (method === "item/agentMessage/delta" && typeof candidate.delta === "string") {
      active.content += candidate.delta;
      active.onDelta?.(candidate.delta);
      return;
    }
    if (method === "thread/tokenUsage/updated") {
      active.usage = normalizeTokenUsage(candidate.tokenUsage?.last);
      return;
    }
    if (method === "error" && candidate.willRetry !== true) {
      this.settleTurn(active, new Error(protocolErrorMessage(candidate.error)));
      return;
    }
    if (method !== "turn/completed") {
      return;
    }
    const status = candidate.turn?.status;
    if (status === "completed") {
      const completedText = active.content || extractCompletedAgentText(candidate.turn?.items);
      this.settleTurn(active, null, {
        content: completedText,
        usage: active.usage,
      });
      return;
    }
    const detail = protocolErrorMessage(candidate.turn?.error);
    this.settleTurn(active, new Error(`Codex turn ${String(status ?? "failed")}：${detail}`));
  }

  private settleTurn(active: ActiveTurn, error: Error | null, result?: CodexGenerationResult): void {
    if (active.settled) {
      return;
    }
    active.settled = true;
    active.abortCleanup?.();
    if (active.systemErrorTimer) {
      clearTimeout(active.systemErrorTimer);
      active.systemErrorTimer = undefined;
    }
    active.watchdog?.stop();
    this.activeTurns.delete(active.threadId);
    if (error) {
      active.reject(error);
      return;
    }
    active.resolve(result ?? { content: active.content, usage: active.usage });
  }

  private assignTurnId(active: ActiveTurn, turnId: string): void {
    active.turnId = turnId;
    active.watchdog?.activity("turn_id_assigned");
    if (active.abortRequested || active.settled) {
      void this.interruptTurn(active).catch(() => undefined);
    }
  }

  private async interruptTurn(active: ActiveTurn): Promise<void> {
    if (!active.turnId) {
      return;
    }
    await this.request("turn/interrupt", {
      threadId: active.threadId,
      turnId: active.turnId,
    });
  }

  private async readThreadStatus(threadId: string): Promise<CodexThreadRuntimeStatus> {
    const response = await this.request("thread/read", {
      threadId,
      includeTurns: false,
    }) as { thread?: { status?: unknown } };
    return normalizeCodexThreadRuntimeStatus(response?.thread?.status);
  }

  private captureDiagnostic(chunk: string): void {
    for (const line of chunk.split(/\r?\n/u)) {
      const normalized = sanitizeDiagnostic(line.trim());
      if (!normalized) {
        continue;
      }
      this.diagnostics.push(normalized);
      if (this.diagnostics.length > 8) {
        this.diagnostics.shift();
      }
    }
  }

  private diagnosticSuffix(): string {
    const last = this.diagnostics.at(-1);
    return last ? ` 最近诊断：${last}` : "";
  }

  private handleProcessExit(error: Error): void {
    this.child = null;
    this.startPromise = null;
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    for (const active of this.activeTurns.values()) {
      this.settleTurn(active, error);
    }
  }
}

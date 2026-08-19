export const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 20 * 60 * 1000;
export const MIN_LLM_REQUEST_TIMEOUT_MS = 60_000;
export const MAX_LLM_REQUEST_TIMEOUT_MS = 60 * 60 * 1000;

export const DEFAULT_CODEX_WATCHDOG_INTERVAL_MS = 15_000;
export const DEFAULT_CODEX_IDLE_PROBE_MS = 3 * 60 * 1000;
export const DEFAULT_CODEX_STALL_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_CODEX_MAX_PROBE_FAILURES = 2;

function clampInt(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function parseEnvDuration(
  rawValue: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const normalized = rawValue?.trim();
  return normalized
    ? clampInt(Number(normalized), fallback, min, max)
    : fallback;
}

export function resolveLlmRequestTimeoutMs(explicitTimeoutMs?: number): number {
  if (typeof explicitTimeoutMs === "number" && Number.isFinite(explicitTimeoutMs) && explicitTimeoutMs > 0) {
    return Math.floor(explicitTimeoutMs);
  }
  return parseEnvDuration(
    process.env.LLM_REQUEST_TIMEOUT_MS,
    DEFAULT_LLM_REQUEST_TIMEOUT_MS,
    MIN_LLM_REQUEST_TIMEOUT_MS,
    MAX_LLM_REQUEST_TIMEOUT_MS,
  );
}

export interface CodexInvocationWatchdogConfig {
  intervalMs: number;
  idleProbeMs: number;
  stallTimeoutMs: number;
  hardTimeoutMs: number;
  maxProbeFailures: number;
}

export function resolveCodexInvocationWatchdogConfig(): CodexInvocationWatchdogConfig {
  const hardTimeoutMs = parseEnvDuration(
    process.env.CODEX_CLI_WATCHDOG_HARD_TIMEOUT_MS,
    resolveLlmRequestTimeoutMs(),
    MIN_LLM_REQUEST_TIMEOUT_MS,
    MAX_LLM_REQUEST_TIMEOUT_MS,
  );
  const intervalMs = parseEnvDuration(
    process.env.CODEX_CLI_WATCHDOG_INTERVAL_MS,
    DEFAULT_CODEX_WATCHDOG_INTERVAL_MS,
    1_000,
    60_000,
  );
  const idleProbeMs = parseEnvDuration(
    process.env.CODEX_CLI_IDLE_PROBE_MS,
    DEFAULT_CODEX_IDLE_PROBE_MS,
    intervalMs * 2,
    Math.max(intervalMs * 2, hardTimeoutMs - intervalMs),
  );
  const stallTimeoutMs = parseEnvDuration(
    process.env.CODEX_CLI_STALL_TIMEOUT_MS,
    Math.min(DEFAULT_CODEX_STALL_TIMEOUT_MS, hardTimeoutMs),
    idleProbeMs,
    hardTimeoutMs,
  );
  const maxProbeFailures = clampInt(
    Number(process.env.CODEX_CLI_MAX_PROBE_FAILURES ?? DEFAULT_CODEX_MAX_PROBE_FAILURES),
    DEFAULT_CODEX_MAX_PROBE_FAILURES,
    1,
    10,
  );
  return {
    intervalMs,
    idleProbeMs,
    stallTimeoutMs,
    hardTimeoutMs,
    maxProbeFailures,
  };
}

export const DEFAULT_CLAUDE_CODE_WATCHDOG_INTERVAL_MS = 15_000;
export const DEFAULT_CLAUDE_CODE_STALL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Claude Code CLI has no out-of-band thread-status query, so its watchdog only tracks stdout
 * activity and two timeouts instead of Codex's `thread/read` probe loop.
 */
export interface ClaudeCodeInvocationWatchdogConfig {
  intervalMs: number;
  stallTimeoutMs: number;
  hardTimeoutMs: number;
}

export function resolveClaudeCodeInvocationWatchdogConfig(): ClaudeCodeInvocationWatchdogConfig {
  const hardTimeoutMs = parseEnvDuration(
    process.env.CLAUDE_CODE_CLI_WATCHDOG_HARD_TIMEOUT_MS,
    resolveLlmRequestTimeoutMs(),
    MIN_LLM_REQUEST_TIMEOUT_MS,
    MAX_LLM_REQUEST_TIMEOUT_MS,
  );
  const intervalMs = parseEnvDuration(
    process.env.CLAUDE_CODE_CLI_WATCHDOG_INTERVAL_MS,
    DEFAULT_CLAUDE_CODE_WATCHDOG_INTERVAL_MS,
    1_000,
    60_000,
  );
  const stallTimeoutMs = parseEnvDuration(
    process.env.CLAUDE_CODE_CLI_STALL_TIMEOUT_MS,
    Math.min(DEFAULT_CLAUDE_CODE_STALL_TIMEOUT_MS, hardTimeoutMs),
    intervalMs * 2,
    hardTimeoutMs,
  );
  return {
    intervalMs,
    stallTimeoutMs,
    hardTimeoutMs,
  };
}

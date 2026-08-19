/**
 * Shared contract between the local OpenAI-compatible bridge and a CLI-backed text generator.
 *
 * Codex CLI and Claude Code CLI both expose a coding-agent process instead of a chat-completions
 * endpoint, so each one implements this interface and reuses the same HTTP bridge.
 */
export interface CliModelDescriptor {
  model: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
}

export interface CliTokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface CliGenerationRequest {
  model: string;
  /** Application system/developer messages, already joined into governing writing instructions. */
  developerInstructions: string;
  /** The encoded conversation the CLI should continue. */
  input: string;
  outputSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}

export interface CliGenerationResult {
  content: string;
  usage: CliTokenUsageBreakdown | null;
}

export interface CliTextGenerator {
  listModels(): Promise<CliModelDescriptor[]>;
  generate(request: CliGenerationRequest): Promise<CliGenerationResult>;
  close(): Promise<void>;
}

/** User-facing identity of a bridge instance, used for error text and `/v1/models` ownership. */
export interface CliBridgeDescriptor {
  /** Chinese-facing provider label, for example `Codex CLI`. */
  label: string;
  /** Value reported as `owned_by` in the OpenAI-compatible model list. */
  ownedBy: string;
  /** Error `code` reported for unexpected adapter failures. */
  errorCode: string;
}

export function toCountedToken(input: unknown): number {
  return typeof input === "number" && Number.isFinite(input) && input >= 0
    ? Math.round(input)
    : 0;
}

export function toTokenUsageBreakdown(input: {
  inputTokens: unknown;
  outputTokens: unknown;
  cachedInputTokens?: unknown;
  reasoningOutputTokens?: unknown;
  totalTokens?: unknown;
}): CliTokenUsageBreakdown | null {
  const inputTokens = toCountedToken(input.inputTokens);
  const outputTokens = toCountedToken(input.outputTokens);
  const cachedInputTokens = toCountedToken(input.cachedInputTokens);
  const reasoningOutputTokens = toCountedToken(input.reasoningOutputTokens);
  const totalTokens = toCountedToken(input.totalTokens) || inputTokens + outputTokens;
  return totalTokens > 0 || inputTokens > 0 || outputTokens > 0
    ? {
      totalTokens,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
    }
    : null;
}

export interface CodexModelDescriptor {
  model: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
}

export interface CodexTokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface CodexGenerationRequest {
  model: string;
  developerInstructions: string;
  input: string;
  outputSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}

export interface CodexGenerationResult {
  content: string;
  usage: CodexTokenUsageBreakdown | null;
}

export interface CodexAppServerLike {
  listModels(): Promise<CodexModelDescriptor[]>;
  generate(request: CodexGenerationRequest): Promise<CodexGenerationResult>;
  close(): Promise<void>;
}

export interface CodexThreadItem {
  type?: string;
  text?: string;
}

export function extractCompletedAgentText(items: unknown): string {
  if (!Array.isArray(items)) {
    return "";
  }
  return items
    .filter((item): item is CodexThreadItem => Boolean(
      item
      && typeof item === "object"
      && (item as CodexThreadItem).type === "agentMessage"
      && typeof (item as CodexThreadItem).text === "string",
    ))
    .map((item) => item.text ?? "")
    .join("");
}

export function normalizeTokenUsage(value: unknown): CodexTokenUsageBreakdown | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as {
    totalTokens?: unknown;
    inputTokens?: unknown;
    cachedInputTokens?: unknown;
    outputTokens?: unknown;
    reasoningOutputTokens?: unknown;
  };
  const toCount = (input: unknown): number => (
    typeof input === "number" && Number.isFinite(input) && input >= 0
      ? Math.round(input)
      : 0
  );
  const usage = {
    totalTokens: toCount(candidate.totalTokens),
    inputTokens: toCount(candidate.inputTokens),
    cachedInputTokens: toCount(candidate.cachedInputTokens),
    outputTokens: toCount(candidate.outputTokens),
    reasoningOutputTokens: toCount(candidate.reasoningOutputTokens),
  };
  return usage.totalTokens > 0 || usage.inputTokens > 0 || usage.outputTokens > 0
    ? usage
    : null;
}

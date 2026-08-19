import {
  toTokenUsageBreakdown,
  type CliGenerationRequest,
  type CliGenerationResult,
  type CliModelDescriptor,
  type CliTextGenerator,
  type CliTokenUsageBreakdown,
} from "../cliBridge";

export type CodexModelDescriptor = CliModelDescriptor;
export type CodexTokenUsageBreakdown = CliTokenUsageBreakdown;
export type CodexGenerationRequest = CliGenerationRequest;
export type CodexGenerationResult = CliGenerationResult;
export type CodexAppServerLike = CliTextGenerator;

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
  return toTokenUsageBreakdown({
    totalTokens: candidate.totalTokens,
    inputTokens: candidate.inputTokens,
    cachedInputTokens: candidate.cachedInputTokens,
    outputTokens: candidate.outputTokens,
    reasoningOutputTokens: candidate.reasoningOutputTokens,
  });
}

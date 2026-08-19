import {
  toTokenUsageBreakdown,
  type CliGenerationRequest,
  type CliGenerationResult,
  type CliModelDescriptor,
  type CliTextGenerator,
  type CliTokenUsageBreakdown,
} from "../cliBridge";

export type ClaudeCodeModelDescriptor = CliModelDescriptor & {
  /** Wire model id the alias resolves to, for example `sonnet` → `claude-sonnet-5`. */
  resolvedModel?: string;
  supportedEffortLevels?: string[];
};
export type ClaudeCodeTokenUsageBreakdown = CliTokenUsageBreakdown;
export type ClaudeCodeGenerationRequest = CliGenerationRequest;
export type ClaudeCodeGenerationResult = CliGenerationResult;
export type ClaudeCodeCliLike = CliTextGenerator;

/**
 * A single NDJSON frame written by `claude --output-format stream-json`.
 *
 * Only the frames the adapter reacts to are modelled; every other frame counts as
 * protocol activity for the watchdog and is otherwise ignored.
 */
export type ClaudeCodeStreamFrame = {
  type?: unknown;
  subtype?: unknown;
  [key: string]: unknown;
};

export const CLAUDE_CODE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeCodeEffortLevel = typeof CLAUDE_CODE_EFFORT_LEVELS[number];

export function isClaudeCodeEffortLevel(value: string): value is ClaudeCodeEffortLevel {
  return (CLAUDE_CODE_EFFORT_LEVELS as readonly string[]).includes(value);
}

/** Extracts the concatenated text of an Anthropic message content array. */
export function extractAssistantMessageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
    })
    .join("");
}

/**
 * Pulls the incremental text out of a `stream_event` frame.
 *
 * Only `text_delta` blocks are forwarded. `thinking_delta` blocks stay out of the assistant
 * content so reasoning never leaks into generated novel text.
 */
export function extractStreamEventTextDelta(frame: ClaudeCodeStreamFrame): string {
  const event = frame.event;
  if (!event || typeof event !== "object") {
    return "";
  }
  const candidate = event as { type?: unknown; delta?: unknown };
  if (candidate.type !== "content_block_delta" || !candidate.delta || typeof candidate.delta !== "object") {
    return "";
  }
  const delta = candidate.delta as { type?: unknown; text?: unknown };
  return delta.type === "text_delta" && typeof delta.text === "string" ? delta.text : "";
}

/** Normalizes the Anthropic `usage` block reported on a `result` frame. */
export function normalizeClaudeCodeTokenUsage(value: unknown): ClaudeCodeTokenUsageBreakdown | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
  };
  const cachedInputTokens = candidate.cache_read_input_tokens;
  return toTokenUsageBreakdown({
    inputTokens: candidate.input_tokens,
    outputTokens: candidate.output_tokens,
    cachedInputTokens,
    reasoningOutputTokens: 0,
  });
}

/**
 * Renders the structured-output payload as the assistant content.
 *
 * When a JSON Schema is supplied the CLI validates the model output and reports the parsed value
 * on `result.structured_output`; the OpenAI-compatible bridge must hand the caller JSON text.
 */
export function stringifyStructuredOutput(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export function extractModelDescriptors(value: unknown): ClaudeCodeModelDescriptor[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const candidate = item as {
      value?: unknown;
      resolvedModel?: unknown;
      displayName?: unknown;
      description?: unknown;
      supportedEffortLevels?: unknown;
    };
    if (typeof candidate.value !== "string" || !candidate.value.trim()) {
      return [];
    }
    return [{
      model: candidate.value.trim(),
      resolvedModel: typeof candidate.resolvedModel === "string" ? candidate.resolvedModel : undefined,
      displayName: typeof candidate.displayName === "string" ? candidate.displayName : undefined,
      description: typeof candidate.description === "string" ? candidate.description : undefined,
      supportedEffortLevels: Array.isArray(candidate.supportedEffortLevels)
        ? candidate.supportedEffortLevels.filter((level): level is string => typeof level === "string")
        : undefined,
    }];
  });
}

export const LLM_PROVIDERS = [
  "deepseek",
  "siliconflow",
  "openai",
  "anthropic",
  "grok",
  "kimi",
  "minimax",
  "glm",
  "qwen",
  "gemini",
  "codex",
  "claudeCode",
  "ollama",
] as const;

export type BuiltinLLMProvider = typeof LLM_PROVIDERS[number];
export type LLMProvider = BuiltinLLMProvider | (string & {});

/**
 * Providers backed by a local coding-agent CLI instead of an HTTP model endpoint.
 *
 * They reuse the machine's CLI login, so they never take an API Key or API URL, are text-only
 * (no image generation, no embeddings), and expose no balance query.
 */
export const CLI_BACKED_LLM_PROVIDERS = ["codex", "claudeCode"] as const;
export type CliBackedLLMProvider = typeof CLI_BACKED_LLM_PROVIDERS[number];

export function isBuiltinLLMProvider(provider: string): provider is BuiltinLLMProvider {
  return (LLM_PROVIDERS as readonly string[]).includes(provider);
}

export function isCliBackedLLMProvider(provider: string): provider is CliBackedLLMProvider {
  return (CLI_BACKED_LLM_PROVIDERS as readonly string[]).includes(provider);
}

export interface ModelConfig {
  provider: LLMProvider;
  model: string;
  baseURL?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ProviderConfig {
  name: string;
  provider: LLMProvider;
  baseURL: string;
  defaultModel: string;
  models: string[];
  envKey: string;
}

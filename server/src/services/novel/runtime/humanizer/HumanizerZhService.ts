import type { LLMProvider } from "@ai-novel/shared/types/llm";
import { runTextPrompt } from "../../../../prompting/core/promptRunner";
import type { PromptExecutionOptions } from "../../../../prompting/core/promptTypes";
import {
  humanizerZhPrompt,
  type HumanizerZhPromptInput,
  type HumanizerZhScope,
} from "../../../../prompting/prompts/novel/humanizer/humanizerZh.prompts";
import { buildWriterStyleContractText } from "../../../styleEngine/styleContractText";
import { StyleRuntimeResolver } from "../../../styleEngine/StyleRuntimeResolver";

export interface HumanizeNovelProseInput {
  content: string;
  scope: HumanizerZhScope;
  novelId?: string;
  chapterId?: string;
  taskStyleProfileId?: string;
  styleHint?: string;
  provider?: LLMProvider;
  model?: string;
  temperature?: number;
  taskId?: string;
  stage?: string;
  itemKey?: string;
  entrypoint?: string;
}

export interface HumanizeNovelProseResult {
  content: string;
  changed: boolean;
  originalLength: number;
  finalLength: number;
}

type HumanizerPromptRunner = (input: {
  asset: typeof humanizerZhPrompt;
  promptInput: HumanizerZhPromptInput;
  options: PromptExecutionOptions;
}) => Promise<{ output: string }>;

interface HumanizerZhServiceDeps {
  runPrompt?: HumanizerPromptRunner;
  styleRuntimeResolver?: Pick<StyleRuntimeResolver, "resolve">;
}

function countCharacters(value: string): number {
  return value.replace(/\s+/gu, "").length;
}

function resolveMaxTokens(content: string): number {
  return Math.min(32768, Math.max(2048, Math.ceil(countCharacters(content) * 1.6)));
}

export class HumanizerZhRequiredError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "HumanizerZhRequiredError";
  }
}

export class HumanizerZhService {
  private readonly runPrompt: HumanizerPromptRunner;
  private readonly styleRuntimeResolver: Pick<StyleRuntimeResolver, "resolve">;

  constructor(deps: HumanizerZhServiceDeps = {}) {
    this.runPrompt = deps.runPrompt ?? ((input) => runTextPrompt(input));
    this.styleRuntimeResolver = deps.styleRuntimeResolver ?? new StyleRuntimeResolver();
  }

  async humanize(input: HumanizeNovelProseInput): Promise<HumanizeNovelProseResult> {
    const source = input.content.trim();
    if (!source) {
      throw new HumanizerZhRequiredError("Humanizer 不能处理空正文。");
    }
    const styleContractText = await this.resolveStyleContractText(input);
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await this.runPrompt({
          asset: humanizerZhPrompt,
          promptInput: {
            scope: input.scope,
            content: source,
            styleContractText,
            styleHint: input.styleHint,
            retryInstruction: attempt > 0
              ? `上一次结果未通过正文完整性校验。必须保留原有剧情事实与篇幅，只输出完整正文。错误：${this.errorMessage(lastError)}`
              : undefined,
          },
          options: {
            provider: input.provider,
            model: input.model,
            temperature: Math.min(input.temperature ?? 0.45, 0.6),
            maxTokens: resolveMaxTokens(source),
            novelId: input.novelId,
            chapterId: input.chapterId,
            taskId: input.taskId,
            stage: input.stage ?? "prose_humanizer",
            itemKey: input.itemKey,
            entrypoint: input.entrypoint,
            triggerReason: input.scope,
          },
        });
        const content = result.output.trim();
        return {
          content,
          changed: content !== source,
          originalLength: countCharacters(source),
          finalLength: countCharacters(content),
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw new HumanizerZhRequiredError(
      `Humanizer-zh 处理失败，正文未进入成稿状态：${this.errorMessage(lastError)}`,
      lastError,
    );
  }

  private async resolveStyleContractText(input: HumanizeNovelProseInput): Promise<string | undefined> {
    if (!input.novelId && !input.chapterId && !input.taskStyleProfileId) {
      return undefined;
    }
    try {
      const resolved = await this.styleRuntimeResolver.resolve({
        novelId: input.novelId,
        chapterId: input.chapterId,
        taskStyleProfileId: input.taskStyleProfileId,
      });
      return buildWriterStyleContractText(resolved.context.compiledBlocks?.contract ?? null) || undefined;
    } catch {
      return undefined;
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error && error.message.trim()
      ? error.message.trim().slice(0, 300)
      : "未知错误";
  }
}

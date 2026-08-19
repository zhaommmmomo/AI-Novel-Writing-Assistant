import { ClaudeCodeCliOpenAIProxy, type ClaudeCodeCliProxyConnection } from "./ClaudeCodeCliOpenAIProxy";

let sharedProxy: ClaudeCodeCliOpenAIProxy | null = null;
let sharedConnectionPromise: Promise<ClaudeCodeCliProxyConnection> | null = null;

function getSharedProxy(): ClaudeCodeCliOpenAIProxy {
  if (!sharedProxy) {
    sharedProxy = new ClaudeCodeCliOpenAIProxy();
  }
  return sharedProxy;
}

export function getClaudeCodeCliProxyConnection(): Promise<ClaudeCodeCliProxyConnection> {
  if (!sharedConnectionPromise) {
    sharedConnectionPromise = getSharedProxy().start().catch((error) => {
      sharedConnectionPromise = null;
      throw error;
    });
  }
  return sharedConnectionPromise;
}

export async function listClaudeCodeCliModels(): Promise<string[]> {
  return getSharedProxy().listModels();
}

export async function closeClaudeCodeCliProxy(): Promise<void> {
  const proxy = sharedProxy;
  sharedProxy = null;
  sharedConnectionPromise = null;
  await proxy?.close();
}

export {
  buildClaudeCodeGenerationArguments,
  buildClaudeCodeModelListArguments,
  ClaudeCodeCliClient,
  resolveClaudeCodeEffort,
  resolveClaudeCodeExecutable,
} from "./ClaudeCodeCliClient";
export { ClaudeCodeCliOpenAIProxy } from "./ClaudeCodeCliOpenAIProxy";
export {
  ClaudeCodeInvocationSupervisor,
  type ClaudeCodeInvocationHandle,
} from "./ClaudeCodeInvocationSupervisor";
export {
  extractAssistantMessageText,
  extractModelDescriptors,
  extractStreamEventTextDelta,
  normalizeClaudeCodeTokenUsage,
  type ClaudeCodeCliLike,
  type ClaudeCodeGenerationRequest,
  type ClaudeCodeGenerationResult,
  type ClaudeCodeModelDescriptor,
  type ClaudeCodeTokenUsageBreakdown,
} from "./protocol";

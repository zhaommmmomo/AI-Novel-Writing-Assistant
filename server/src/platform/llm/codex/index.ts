import { CodexCliOpenAIProxy, type CodexCliProxyConnection } from "./CodexCliOpenAIProxy";

let sharedProxy: CodexCliOpenAIProxy | null = null;
let sharedConnectionPromise: Promise<CodexCliProxyConnection> | null = null;

function getSharedProxy(): CodexCliOpenAIProxy {
  if (!sharedProxy) {
    sharedProxy = new CodexCliOpenAIProxy();
  }
  return sharedProxy;
}

export function getCodexCliProxyConnection(): Promise<CodexCliProxyConnection> {
  if (!sharedConnectionPromise) {
    sharedConnectionPromise = getSharedProxy().start().catch((error) => {
      sharedConnectionPromise = null;
      throw error;
    });
  }
  return sharedConnectionPromise;
}

export async function listCodexCliModels(): Promise<string[]> {
  return getSharedProxy().listModels();
}

export async function closeCodexCliProxy(): Promise<void> {
  const proxy = sharedProxy;
  sharedProxy = null;
  sharedConnectionPromise = null;
  await proxy?.close();
}

export {
  buildCodexAppServerArguments,
  CodexAppServerClient,
  resolveCodexModelProviderOverride,
} from "./CodexAppServerClient";
export { CodexCliOpenAIProxy } from "./CodexCliOpenAIProxy";
export type {
  CodexAppServerLike,
  CodexGenerationRequest,
  CodexGenerationResult,
  CodexModelDescriptor,
  CodexTokenUsageBreakdown,
} from "./protocol";

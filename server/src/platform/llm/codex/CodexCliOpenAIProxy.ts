import {
  CliOpenAICompatibleBridge,
  type CliBridgeConnection,
} from "../cliBridge";
import type { CodexAppServerLike } from "./protocol";
import { CodexAppServerClient } from "./CodexAppServerClient";

export type CodexCliProxyConnection = CliBridgeConnection;

/**
 * Codex-flavoured instance of the shared loopback OpenAI bridge. All transport behaviour lives in
 * `CliOpenAICompatibleBridge`; only the user-facing provider identity is Codex-specific.
 */
export class CodexCliOpenAIProxy extends CliOpenAICompatibleBridge {
  constructor(client: CodexAppServerLike = new CodexAppServerClient()) {
    super({
      label: "Codex CLI",
      ownedBy: "codex-cli",
      errorCode: "codex_cli_error",
    }, client);
  }
}

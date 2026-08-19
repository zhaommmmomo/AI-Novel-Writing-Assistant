import {
  CliOpenAICompatibleBridge,
  type CliBridgeConnection,
} from "../cliBridge";
import type { ClaudeCodeCliLike } from "./protocol";
import { ClaudeCodeCliClient } from "./ClaudeCodeCliClient";

export type ClaudeCodeCliProxyConnection = CliBridgeConnection;

/**
 * Claude Code flavoured instance of the shared loopback OpenAI bridge. All transport behaviour
 * lives in `CliOpenAICompatibleBridge`; only the user-facing provider identity differs.
 */
export class ClaudeCodeCliOpenAIProxy extends CliOpenAICompatibleBridge {
  constructor(client: ClaudeCodeCliLike = new ClaudeCodeCliClient()) {
    super({
      label: "Claude Code CLI",
      ownedBy: "claude-code-cli",
      errorCode: "claude_code_cli_error",
    }, client);
  }
}

/**
 * Claude Code backend — STUB.
 *
 * Real implementation plan: `@anthropic-ai/claude-agent-sdk` `query()` in
 * streaming-input mode (the SDK launches the `claude` executable and streams
 * JSON messages). send() pushes user messages into the input iterable;
 * interrupt uses `query.interrupt()`; assistant/tool_use/result messages map
 * onto SubagentEvents; session id + projects-dir JSONL land in SubagentMeta.
 */

import type { SubagentBackend } from "../backend.ts";
import { makeStubBackend } from "./stub.ts";

export const claudeBackend: SubagentBackend = makeStubBackend({
  backend: "claude",
  defaultModelLabel: "claude/sonnet",
  contextWindow: 200_000,
  toolName: "Bash",
  cadenceMs: 220,
});

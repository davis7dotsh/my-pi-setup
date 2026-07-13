/**
 * Codex backend — STUB.
 *
 * Real implementation plan: spawn `codex app-server` as a scoped child
 * process (effect/unstable/process ChildProcess) and speak JSON-RPC over
 * stdin/stdout: `newConversation`/`sendUserTurn` requests; notifications
 * (`agentMessageDelta`, `execCommandBegin/End`, `taskComplete`, `tokenCount`)
 * map onto SubagentEvents; `interruptConversation` behind interrupt; the
 * rollout path + conversation id land in SubagentMeta.
 */

import type { SubagentBackend } from "../backend.ts";
import { makeStubBackend } from "./stub.ts";

export const codexBackend: SubagentBackend = makeStubBackend({
  backend: "codex",
  defaultModelLabel: "codex/gpt-5-codex",
  contextWindow: 272_000,
  toolName: "shell",
  cadenceMs: 180,
});

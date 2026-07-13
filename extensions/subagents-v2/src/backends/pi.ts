/**
 * pi backend — STUB.
 *
 * Real implementation plan: in-process `createAgentSession()` via the pi SDK
 * (port of v1 subagents/manager.ts session code): real session files visible
 * in /resume, `session.subscribe()` events translated to SubagentEvents,
 * `session.steer()`/`prompt()` behind send(), `session.abort()` behind
 * interrupt, child resource loading + trust gating + tool denylist.
 */

import type { SubagentBackend } from "../backend.ts";
import { makeStubBackend } from "./stub.ts";

export const piBackend: SubagentBackend = makeStubBackend({
  backend: "pi",
  defaultModelLabel: "stub/pi-inherit",
  contextWindow: 200_000,
  toolName: "bash",
  cadenceMs: 150,
});

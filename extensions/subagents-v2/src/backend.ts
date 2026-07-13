/**
 * The unified backend interface: one `SubagentBackend` per agent runtime
 * (pi, Claude Code, Codex), all producing the same `SubagentSession` shape.
 *
 * Planned real implementations (currently stubbed in ./backends/):
 * - pi: in-process `createAgentSession()` via the pi SDK.
 * - claude: `@anthropic-ai/claude-agent-sdk` `query()` in streaming-input mode.
 * - codex: `codex app-server` child process speaking JSON-RPC over stdio.
 */

import type { Effect, Scope, Stream } from "effect";
import { Context } from "effect";
import type {
  BackendName,
  SendError,
  SpawnError,
  SpawnTask,
  SubagentEvent,
  SubagentMeta,
} from "./domain.ts";

export interface BackendCapabilities {
  /** Can send() steer a live run (vs. only starting a fresh run when idle). */
  readonly steering: boolean;
  readonly modelSelection: boolean;
  readonly reasoningEffort: boolean;
}

/**
 * A live subagent session. The manager is the single consumer of `events`;
 * it folds them into the `SubagentSnapshot` everything else reads.
 */
export interface SubagentSession {
  /** Current metadata snapshot. Updates also arrive as MetaChanged events. */
  readonly meta: Effect.Effect<SubagentMeta>;
  /**
   * All activity, normalized. Ends when the session's scope closes. Every
   * run started within the session terminates with a RunSettled event.
   */
  readonly events: Stream.Stream<SubagentEvent>;
  /**
   * Steer the active run, or start a fresh run when idle (v1 `manager.send`
   * semantics — the "is a run active" decision is backend-native state).
   */
  send(text: string): Effect.Effect<void, SendError>;
  /**
   * Interrupt the active run. Resolves once the backend acknowledges; the
   * corresponding RunSettled(Interrupted) arrives on `events`. Callers bound
   * this with a timeout and fall back to closing the session scope.
   */
  readonly interrupt: Effect.Effect<void>;
}

export interface SubagentBackend {
  readonly name: BackendName;
  readonly capabilities: BackendCapabilities;
  /** Probe availability (binary on PATH, SDK importable, credentials). */
  readonly available: Effect.Effect<boolean>;
  /**
   * Spawn a session. Scoped: closing the scope interrupts/kills the
   * underlying session or process and ends `events`. Fire-and-forget
   * semantics (background fibers, result delivery) live in the manager.
   */
  spawn(
    task: SpawnTask,
  ): Effect.Effect<SubagentSession, SpawnError, Scope.Scope>;
}

/** Registry of all wired backends, keyed by name. */
export class BackendRegistry extends Context.Service<
  BackendRegistry,
  ReadonlyMap<BackendName, SubagentBackend>
>()("subagents-v2/BackendRegistry") {}

# subagents-v2 — Design Plan

A pi extension that fires off background subagents from a parent pi session, where each
subagent can be powered by one of three backends — **pi** (in-process SDK session),
**Claude Code** (`@anthropic-ai/claude-agent-sdk`), or **Codex** (`codex app-server`) —
unified behind a single Effect v4 service interface.

**Scope of the first version:** interface design + stubbed backend internals + the v1 UI
carried over. No real Claude/Codex process integration yet; the pi backend may also stay
stubbed initially so the manager/UI/tool loop can be exercised end to end with zero
external dependencies.

**Location:** `/Users/davis/.pi/agent/extensions/subagents-v2/` — fully self-contained
(no imports from `../shared` or `../subagents`; the handful of shared helpers v1 uses are
copied in).

---

## 1. V1 inventory (what must be preserved)

Source: `/Users/davis/.pi/agent/extensions/subagents/` (`index.ts`, `manager.ts`,
`prompt.ts`, `result-delivery.ts`, `takeover.ts`) plus `../shared/` helpers.

### 1.1 Tools exposed to the parent LLM

| Tool | Parameters | Behavior |
|---|---|---|
| `subagent_spawn` | `prompt`, `title`, `working_dir?`, `model?`, `provider?`, `reasoning_effort?` | Fire-and-forget spawn. Returns immediately with an id (`sa-N`). Enforces `MAX_RUNNING = 4` with a synchronous reservation so parallel tool calls can't race past the cap. Validates `working_dir`, resolves model against the registry (inherit parent model/thinking level by default), truncates title to 160 chars. |
| `subagent_wait` | `ids[]` (max 64) | Blocks until all listed subagents settle; respects the tool `AbortSignal`; streams `Waiting for ...` via `onUpdate`. Marks the awaited results "consumed" so they are not also auto-delivered. Output budgets: 48KB total, 16KB per agent, with per-section fallbacks (`[omitted: ...]`). Errors on unknown ids (lists known ids). |
| `subagent_cancel` | `ids[]` | Aborts running subagents (marks consumed first to avoid duplicate delivery), waits for settlement, reports per-id `Cancelled ...` / `was already <status>`. Partial transcripts remain on disk. |
| `subagent_check` | `id` | Non-blocking peek: status line, turn count, error text, up to 2KB/20 lines of latest output (includes the live streaming assistant message). Does not consume the result. |
| `subagent_list` | — | One `describeSubagent()` line per agent: `id [status] "title" (provider/model, ctx%, elapsed, cwd)`. |

Prompt metadata (all strings live in `prompt.ts`): `subagent_spawn` has a
`promptSnippet` and two `promptGuidelines` (delegate self-contained tasks; don't block on
`subagent_wait` unless necessary). Tool descriptions explain fire-and-forget semantics,
the concurrency cap, and that children can't orchestrate/see the parent conversation.

### 1.2 State tracking (v1 `SubagentManager`)

- Plain class with `Map<string, Subagent>`; each `Subagent` = `{ id, title, prompt, cwd,
  session: AgentSession, status: "running" | "done" | "error", createdAt, settledAt?,
  errorText?, unsubscribeLifecycle }`.
- Children are **in-process pi `AgentSession`s** created via the SDK
  (`createAgentSession` + `SessionManager.create(cwd)` → real session files visible in
  `/resume`), with child resources loaded per-cwd (`DefaultResourceLoader`, trust-gated
  project resources) and a tool denylist (`excludeTools`: the subagent_* tools,
  `workflow`, `ask_user`).
- Settlement is driven by session lifecycle events (`agent_start` re-marks running;
  `agent_settled` settles). Failure detection: thrown prompt error, last assistant
  `stopReason === "error" | "aborted"`, error text bounded to 4096 chars.
- Change notification: `addChangeListener()` + `nextChange(signal)` promise — used by
  `waitFor`, the footer status, and the dashboard.
- `waitFor(ids, signal, onPending)` keeps a `waitInterest` refcount per id so settles
  during an active wait are marked consumed.
- `send(sub, text)`: steer via `session.steer()` while streaming, else start a fresh
  `prompt()` run (used by takeover).
- Caps and cleanup: `MAX_RUNNING = 4`, `MAX_TRACKED = 64` with LRU pruning of settled
  agents, `STOP_TIMEOUT_MS = 5s` bounded aborts, force-dispose fallback, idempotent
  `disposeAll()` on `session_shutdown`.

### 1.3 Result delivery back to the parent

- When a child settles **unconsumed**, `onSettled` defers it into a tiny
  `createDeferredResultDelivery` buffer (defer/consume/drain/clear keyed by id).
- Flush happens when the parent goes idle: immediately if `sessionContext.isIdle()`,
  otherwise on the parent's `agent_settled` event. A later `subagent_wait` can still
  consume a deferred result before flush (that's why it is a buffer, not an immediate
  send).
- Delivery = `pi.sendMessage({ customType: "subagent-result", content, display: true,
  details: { id, title, status } }, { deliverAs: "followUp", triggerTurn: true })`.
  Content is built by `buildSubagentResultMessage` (`Subagent sa-N "title"
  finished/failed.` + optional `Error:` line + output truncated to 24KB/600 lines with a
  pointer to the child session file for the full transcript).

### 1.4 UI (carried over into v2 essentially as-is)

1. **Footer status** (`ctx.ui.setStatus("subagents", ...)`): `subagents: ■ 2 running ·
   ■ 1 done · ■ 1 failed · /subagents to view` (warning/success/error colored squares;
   cleared when no subagents). Driven by manager change listener.
2. **`subagent-result` message renderer**: status icon (`■`/`x`) + bold accent header
   `subagent sa-N · title · finished/failed`; collapsed = first 8 body lines +
   `... (ctrl+o to expand)`; expanded = header + `Markdown` component render of the body.
3. **`/subagents` command** → `openSubagentPicker` loop (TUI mode only; notifies and
   bails in non-TUI or when there are no subagents):
   - **SubagentDashboard** — fullscreen overlay (`anchor: "center", width: "100%",
     maxHeight: "100%"`), bordered list panel titled `agents · settled/total`. Each row:
     selection marker `❯`, status glyph, title, dim id on the left; model id · context
     utilization (`%/capacity`) · elapsed · status word on the right. Scroll window
     centered on the selection with `... N more` markers. 1Hz ticker re-render for
     elapsed/token columns + manager change subscription. Keys: `tui.select.up/down`
     **and** `j`/`k` to move, `tui.select.confirm` to take over, `x` to abort the
     selected running agent, `tui.select.cancel` to close. Hint line shows the
     *configured* keys via `keybindings.getKeys()`.
   - **TakeoverView** — fullscreen overlay for one subagent: header line (status glyph,
     `id · title · status · elapsed · provider/model · ctx%`), fixed-height transcript
     viewport (error line and scroll indicator consume viewport rows so height never
     jumps), an `Input` line, and a hint row. Keys: `tui.input.submit` send (steer if
     streaming, new run if idle), `app.interrupt`/`tui.select.cancel` back to dashboard,
     `app.clear` abort run, `tui.editor.cursorUp/Down` scroll ±6 lines,
     `tui.editor.pageUp/Down` page. Renders are throttled to 50ms because streaming can
     emit per-token events.
   - **Transcript rendering** (`buildTranscriptLines`): sanitizes ANSI/tabs/control
     chars; user messages as `> ` accent-prefixed wrapped lines; assistant text wrapped
     plain; thinking as dim italic `~ ` lines; tool calls as `→ toolname {args}`; tool
     results as one dim `output:`/red `error:` first line. Includes the **live streaming
     assistant message**, **live tool executions** (running/done/error marker + first
     output line preview, tracked from `tool_execution_*` events until the final tool
     result message lands), and **queued steering/follow-up messages** (`> [queued
     steer] ...`) so Enter visibly acknowledges input.

**V2 requirement:** all of the above renders from a *normalized* per-subagent view
instead of poking at `sub.session` directly — that is the main UI refactor, everything
else ports over mostly verbatim.

---

## 2. Backend integration facts

These shape the interface even though v1-of-v2 stubs the internals. (Traced from the
"T3 Code" codebase which integrates Codex and Claude Code.)

| | Interactive sessions | One-shot tasks | Event shape | Interrupt | Steering |
|---|---|---|---|---|---|
| **pi** | In-process `createAgentSession()` (pi SDK); real session files; `session.subscribe()` | `session.prompt()` and read final assistant message (or `pi -p` subprocess, not needed) | `AgentSessionEvent` (message_start/update/end, tool_execution_*, agent_start/settled, queue_update, ...) | `session.abort()` | `session.steer()` / `followUp()` |
| **Claude Code** | `@anthropic-ai/claude-agent-sdk` `query()` — SDK launches the `claude` executable and streams JSON messages (assistant/user/result/system, streaming partials, tool_use blocks) | `claude -p --output-format json` | SDK message stream (async iterable) | `query.interrupt()` / abort controller | streaming-input mode: push more user messages into the input iterable |
| **Codex** | spawn `codex app-server` child process, JSON-RPC over stdin/stdout (`newConversation` / `sendUserTurn`, notifications: `agentMessageDelta`, `execCommandBegin/End`, `taskComplete`, `tokenCount`, ...) | `codex exec` (prints result to stdout, `--json` for events) | JSON-RPC notifications | `interruptConversation` request | send another `sendUserTurn` on the same conversation |

Common denominator all three can supply:

- an async event stream with: lifecycle (started/turn/settled), assistant text
  (deltas and/or completed messages), reasoning text, tool execution begin/update/end,
  token usage, errors;
- a way to send a follow-up/steering user message into a live session;
- an interrupt operation;
- a final result text per run;
- metadata: backend name, model identifier, session/log file path (pi session file,
  Claude session id + projects dir JSONL, Codex rollout path), working dir.

That is exactly what the normalized event model below encodes.

---

## 3. Architecture

### 3.1 Effect v4 conventions used

- Single `effect` package (v4 beta). Services defined with
  `ServiceMap.Service<T>()("id", ...)` / `ServiceMap.Key`; wiring via `Layer`;
  `ManagedRuntime.make(layer)` at the extension edge with `runtime.runPromise(effect,
  { signal })` inside `async execute()` tool handlers and `await runtime.dispose()` on
  `session_shutdown`.
- `Effect.gen` generators throughout the internals. `async`/`Promise` appears **only**
  in: tool `execute()` bodies, `pi.on(...)` handlers, the `/subagents` command handler,
  and the imperative TUI component classes (which are callback-driven, not effectful).
- Streams: `Stream<SubagentEvent>` per subagent, produced by backends
  (`Stream.callback` for push-based sources like JSON-RPC notifications / SDK
  iterables), consumed by a manager fiber per subagent.
- Errors: tagged error classes (`Data.TaggedError`) — `SpawnError`, `BackendUnavailable`,
  `SubagentNotFound`, `ConcurrencyLimitError`, `SendError`, `InterruptTimeout`. Tool
  handlers map these to thrown `Error`s with the same user-facing messages v1 uses.

### 3.2 Domain model (`src/domain.ts`)

```ts
type BackendName = "pi" | "claude" | "codex";
type SubagentStatus = "running" | "done" | "error";   // unchanged from v1

interface SpawnTask {
  prompt: string;
  title: string;
  cwd: string;
  // Generic model hint; each backend interprets/validates it its own way.
  model?: string;            // pi: "provider/model-id"; claude: model alias; codex: model slug
  reasoningEffort?: string;  // pi thinking level; codex reasoning effort; claude: ignored/mapped
  parentContext: {           // resolved by the tool layer, passed opaquely
    parentCwd: string;
    projectTrusted: boolean;
    inheritedModelRef?: { provider: string; id: string };  // pi only
    inheritedThinkingLevel?: string;
  };
}

interface SubagentMeta {
  backend: BackendName;
  modelLabel?: string;         // "anthropic/claude-opus-4-5", "gpt-5-codex", ...
  contextWindow?: number;      // for utilization %, when known
  sessionFilePath?: string;    // pi session file / claude JSONL / codex rollout path
  nativeSessionId?: string;    // claude session id, codex conversation id
}
```

### 3.3 Normalized event model (`src/domain.ts`)

One discriminated union covers everything the v1 UI and manager need. Backends translate
their native streams into this; nothing downstream knows which backend produced it.

```ts
type SubagentEvent =
  // lifecycle
  | { _tag: "RunStarted" }                       // pi agent_start / claude init / codex turn start
  | { _tag: "RunSettled"; outcome: RunOutcome }  // terminal per run (a session can run again via send())
  // transcript building blocks
  | { _tag: "UserMessage"; text: string }        // initial prompt + takeover sends, echoed by backend
  | { _tag: "AssistantDelta"; kind: "text" | "thinking"; delta: string }
  | { _tag: "AssistantMessage"; parts: TranscriptPart[] }  // finalized message (replaces live buffer)
  | { _tag: "ToolStart";  toolId: string; name: string; argsPreview?: string }
  | { _tag: "ToolUpdate"; toolId: string; outputPreview?: string }
  | { _tag: "ToolEnd";    toolId: string; isError: boolean; outputPreview?: string }
  // bookkeeping
  | { _tag: "QueueChanged"; queued: ReadonlyArray<{ text: string; kind: "steer" | "follow-up" }> }
  | { _tag: "UsageChanged"; tokens?: number; contextWindow?: number }
  | { _tag: "MetaChanged";  meta: Partial<SubagentMeta> }  // model switched, session file known, ...
  | { _tag: "BackendError"; message: string };   // non-fatal diagnostics (fatal → RunSettled outcome)

type RunOutcome =
  | { _tag: "Completed"; finalText: string }
  | { _tag: "Failed"; errorText: string; partialText?: string }
  | { _tag: "Interrupted"; partialText?: string };

type TranscriptPart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; redacted?: boolean }
  | { type: "toolCall"; toolId: string; name: string; argsPreview?: string };
```

Mapping sanity check against what the v1 UI renders:

| v1 render source | v2 event source |
|---|---|
| `sub.session.messages` (user/assistant/toolResult) | fold of `UserMessage` / `AssistantMessage` / `ToolEnd` into the snapshot transcript |
| streaming message (`agent.state.streamingMessage`) | live buffer fed by `AssistantDelta` (cleared on `AssistantMessage`/`RunSettled`) |
| live tool map from `tool_execution_*` | `ToolStart/Update/End` (entries drop when the finalized assistant/tool item lands, same as v1) |
| queued steer/follow-up messages | `QueueChanged` |
| status / errorText / settledAt | `RunStarted` / `RunSettled` |
| model + context utilization columns | `MetaChanged` + `UsageChanged` |
| `finalOutput` / `latestOutput` for check/wait/result delivery | `RunOutcome.finalText` (+ live buffer for `latestOutput`) |

Previews (`argsPreview`, `outputPreview`) are pre-flattened single-line strings because
the UI only ever shows one sanitized line — this avoids leaking three different native
"tool result" shapes through the interface.

### 3.4 The `SubagentBackend` service (`src/backend.ts`)

One interface; three implementations; a registry keyed by `BackendName`.

```ts
interface SubagentBackend {
  readonly name: BackendName;
  readonly capabilities: {
    steering: boolean;         // can send() into a live run (all three eventually; stubs: true)
    modelSelection: boolean;
    reasoningEffort: boolean;
  };
  /** Probe availability (binary on PATH, SDK importable, API key). Cheap + cached. */
  readonly available: Effect.Effect<boolean>;
  /**
   * Spawn a session. Scoped: releasing the scope interrupts/kills the underlying
   * session/process. Returns a live handle immediately (fire-and-forget semantics
   * live in the manager, not here).
   */
  spawn(task: SpawnTask): Effect.Effect<SubagentSession, SpawnError, Scope.Scope>;
}

interface SubagentSession {
  readonly meta: Effect.Effect<SubagentMeta>;                 // snapshot; also updated via MetaChanged
  /** All activity. Single consumer (the manager). Ends after the final RunSettled on close. */
  readonly events: Stream.Stream<SubagentEvent, never>;
  /** Steer while running, or start a fresh run when idle (v1 `manager.send` semantics). */
  send(text: string): Effect.Effect<void, SendError>;
  /** Interrupt the active run; resolves when the backend acknowledges. Bounded by the caller. */
  readonly interrupt: Effect.Effect<void>;
  /** Resolves with the outcome of the most recent run (mirrors the last RunSettled). */
  readonly awaitSettled: Effect.Effect<RunOutcome>;
}

// Registry: a plain ServiceMap.Key holding a ReadonlyMap<BackendName, SubagentBackend>,
// built by a Layer that collects the three backend layers. Adding a 4th backend = one
// new file + one line in the registry layer.
class BackendRegistry extends ServiceMap.Key<BackendRegistry,
  ReadonlyMap<BackendName, SubagentBackend>>()("subagents-v2/BackendRegistry") {}
```

Design choices worth calling out:

- **`spawn` is scoped, not paired with an explicit `dispose`.** The manager opens one
  `Scope` per subagent and closes it on cancel/prune/disposeAll — this replaces v1's
  `shutdownAndDisposeChildSession` + WeakMap-idempotence machinery with Effect's own
  guaranteed-once finalization. Timeout-bounded teardown (`5s`, then force) is a
  finalizer concern inside each backend.
- **`send` unifies steer/new-run.** v1's `manager.send` already had these semantics; the
  interface keeps the decision inside the backend because "is a run active" is
  backend-native state.
- **Events, not message arrays, are the contract.** The manager folds events into
  snapshots; backends never expose native message types. The pi backend has the richest
  native data and simply down-converts.
- **No `exec()` one-shot operation in v1 of this extension** — see Open Questions; the
  interface deliberately leaves room to add `exec(task): Effect<RunOutcome>` later
  without touching the manager.

### 3.5 `SubagentManager` service (`src/manager.ts`)

Owns the registry of running/finished subagents. Effect service; internally a `Ref` (or
plain mutable map guarded by the single-threaded JS model) of entries plus a
**synchronous read model** for the TUI.

```ts
interface SubagentEntry {
  id: string;                    // "sa-N", same scheme as v1
  backend: BackendName;
  title: string; prompt: string; cwd: string;
  scope: Scope.Closeable;        // owns the SubagentSession
  session: SubagentSession;
  eventPump: Fiber.Fiber<void>;  // folds events → snapshot, fires settle hooks
}

interface SubagentSnapshot {      // what the UI and tools read; plain immutable data
  id: string; backend: BackendName; title: string; cwd: string;
  status: SubagentStatus;
  createdAt: number; settledAt?: number;
  errorText?: string;
  meta: SubagentMeta;
  usage: { tokens?: number; contextWindow?: number };
  transcript: ReadonlyArray<TranscriptItem>;    // finalized items
  liveAssistant?: { text: string; thinking: string };
  liveTools: ReadonlyArray<LiveToolState>;      // v1's LiveToolEvent, verbatim
  queued: ReadonlyArray<{ text: string; kind: "steer" | "follow-up" }>;
  finalText: string;             // last Completed finalText (v1 finalOutput)
  latestText: string;            // finalText or live buffer (v1 latestOutput)
  turns: number;                 // count of AssistantMessage events (for subagent_check)
}

class SubagentManager extends ServiceMap.Key<SubagentManager, {
  spawn(backend: BackendName, task: SpawnTask):
    Effect.Effect<SubagentSnapshot, SpawnError | ConcurrencyLimitError | BackendUnavailable>;
  waitFor(ids: string[], onPending?: (pending: string[]) => void):
    Effect.Effect<void, SubagentNotFound>;      // interruption = tool signal abort
  cancel(ids: string[]): Effect.Effect<CancelReport, SubagentNotFound>;
  send(id: string, text: string): Effect.Effect<void, SubagentNotFound | SendError>;
  get(id: string): Effect.Effect<SubagentSnapshot | undefined>;
  list: Effect.Effect<ReadonlyArray<SubagentSnapshot>>;
  disposeAll: Effect.Effect<void>;
  /** Synchronous read model for the TUI (see 3.6). */
  readonly view: SubagentReadModel;
}>()("subagents-v2/SubagentManager") {}
```

Behavior preserved from v1, expressed in Effect terms:

- **Concurrency cap**: `MAX_RUNNING = 4` enforced with a synchronous
  reserve-before-first-yield counter (same race-avoidance rationale as v1); the cap
  counts *running* agents across all backends (see Open Questions for per-backend caps).
- **Settlement**: the per-subagent event pump fiber updates the snapshot on every event;
  on `RunSettled` it computes `status`/`errorText` (bounded to 4096 chars) and invokes
  the settle hook with `consumed = waitInterest > 0`. `waitFor` keeps the same
  wait-interest refcounts (a `Ref<Map<string, number>>`) and wakes on snapshot changes
  (a `Latch`/`PubSub`-based "next change" primitive replacing v1's resolver array).
- **Cancel**: mark consumed → `session.interrupt` with 5s bound → close scope on
  timeout → wait for settle. Same "already \<status\>" reporting.
- **Pruning**: `MAX_TRACKED = 64`, oldest settled non-wait-interested entries pruned by
  closing their scopes; cleanup tracked so `disposeAll` can await it.
- **Settle → result delivery hook**: the manager exposes `onSettled` wiring identical in
  spirit to v1: the extension layer registers a callback that defers into the
  `result-delivery` buffer and flushes on parent idle / `agent_settled`. The
  `createDeferredResultDelivery` module is copied over unchanged (it is pure and already
  has a test).

### 3.6 Synchronous read model for the TUI (`src/read-model.ts`)

The TUI components (`Component` classes with `render(width)`/`handleInput(data)`) are
imperative and render synchronously — they cannot `yield*` effects. Bridge:

```ts
interface SubagentReadModel {
  list(): ReadonlyArray<SubagentSnapshot>;         // sync snapshot reads
  get(id: string): SubagentSnapshot | undefined;
  subscribe(listener: () => void): () => void;     // any-change notification (dashboard, footer)
  subscribeTo(id: string, l: () => void): () => void; // per-agent (takeover view)
  // sync fire-and-forget commands, executed via the ManagedRuntime under the hood:
  requestSend(id: string, text: string): void;     // TakeoverView input submit
  requestAbort(id: string): void;                  // dashboard `x`, takeover app.clear
}
```

The manager's event pump writes each new snapshot into this store (plain mutable map +
listener set) as its last step, so the UI is always at most one microtask behind the
Effect world and v1's dashboard/takeover code ports with only these substitutions:

| v1 | v2 |
|---|---|
| `manager.list()` / `manager.get(id)` | `view.list()` / `view.get(id)` |
| `manager.addChangeListener` | `view.subscribe` |
| `sub.session.subscribe(handleSessionEvent)` + local live-tool map | `view.subscribeTo(id, ...)` + read `snapshot.liveTools` / `liveAssistant` (the fold moved into the manager) |
| `manager.send(sub, text)` / `manager.abort(sub)` | `view.requestSend(id, text)` / `view.requestAbort(id)` |
| `buildTranscriptLines(sub, ...)` reading `session.messages` | `buildTranscriptLines(snapshot, ...)` reading `snapshot.transcript` + live state + `snapshot.queued` |

Keybindings, layout math, scroll behavior, 1Hz ticker, 50ms render throttle, sanitize
logic: copied as-is.

### 3.7 Extension edge (`index.ts` + `src/runtime.ts`)

```
Layer graph:
  PiBackendStub.layer      ─┐
  ClaudeBackendStub.layer  ─┼→ BackendRegistry.layer ─→ SubagentManager.layer ─→ AppLayer
  CodexBackendStub.layer   ─┘
```

- `const runtime = ManagedRuntime.make(AppLayer)` — created lazily on first use (per the
  extension-docs guidance to not start background resources in the factory;
  `ManagedRuntime` builds its layer on first run, which satisfies this, but we still
  gate creation behind `session_start`). `session_shutdown`: `runtime.runPromise(
  manager.disposeAll)` then `await runtime.dispose()`, then recreate on the next
  `session_start` (handles `/new`, `/resume`, `/reload`).
- **Tool handlers are the async boundary.** Each `execute(toolCallId, params, signal,
  onUpdate, ctx)` builds one `Effect.gen` program and runs it with
  `runtime.runPromise(program, { signal })`; tool-visible errors are converted from
  tagged errors to `Error` messages matching v1 wording. `onUpdate` and `ctx`
  (model registry, cwd, trust) are captured into the program as plain values/callbacks.
- **Tool schema change:** `subagent_spawn` gains
  `agent: StringEnum(["pi", "claude", "codex"])` (optional, default `"pi"`), and
  `model`/`provider`/`reasoning_effort` keep their v1 shapes but are documented as
  backend-interpreted (pi validates against the registry; claude/codex validate against
  their own known-model rules — stubs accept anything). `describeSubagent` lines and the
  dashboard gain the backend name (e.g. `sa-3 [running] "title" (codex, gpt-5-codex,
  41%/272k, 1m32s, /repo)`).
- `pi.registerMessageRenderer("subagent-result", ...)`, `pi.registerCommand(
  "subagents", ...)`, footer status updates, and the result-delivery flush hooks
  (`agent_settled`, idle-check on settle) are wired exactly like v1 — these all live
  outside the runtime and call into it only via `runPromise`/the read model.

### 3.8 What the stubs do (v1 of this extension)

All three backends share a `createStubSession(profile)` helper (`src/backends/stub.ts`)
that fakes a plausible session so the manager, tools, result delivery, and both TUI
views are exercised end to end:

- **spawn**: emits `MetaChanged` (backend-flavored model label + fake session file path
  under `os.tmpdir()`, e.g. `.../subagents-v2-stub/sa-1.jsonl`, actually written with the
  transcript so "full transcript in session file" pointers resolve), then `RunStarted`,
  then a scripted turn: 2–3 `AssistantDelta` batches on a timer (~200ms cadence so
  streaming is visible), one fake `ToolStart/Update/End` cycle (`bash` with an args
  preview), `UsageChanged` ramping tokens, a final `AssistantMessage`, and `RunSettled`
  with `Completed` — final text echoes the task: `"[stub:claude] completed: <first 200
  chars of prompt>"`. Total runtime ~3–6s (configurable per profile) so `subagent_wait`,
  the footer counters, and the dashboard's running→done transition are observable.
- **send**: emits `UserMessage` + `QueueChanged` (briefly, to exercise the queued-line
  rendering) and runs another scripted turn — so takeover steering works.
- **interrupt**: stops the script timer and settles with `Interrupted` (→ status
  `error`, errorText `"Run was aborted"`, matching v1) — so `subagent_cancel` and the
  `x`/`app.clear` keybindings work.
- **failure path**: a magic prompt prefix (e.g. `FAIL:`) makes the run settle with
  `Failed` — so error rendering, `errorText` rows, and failed result delivery are
  testable without real backends.
- **Backend differentiation**: per-backend profiles vary the model label
  (`anthropic/claude-opus-4-5` vs `claude-sonnet-4-5` vs `gpt-5-codex`), fake context
  window, tool names, and delta cadence — enough to verify the UI treats backends
  uniformly. `available` returns `true` for stubs (real impls will probe binaries/SDK).
- The **pi stub** can later be swapped for the real in-process SDK implementation by
  porting v1's `manager.ts` session code behind the same `SubagentSession` shape; that
  port is the first post-stub milestone.

---

## 4. File/module layout

```
/Users/davis/.pi/agent/extensions/subagents-v2/
├── package.json               # name, "effect": "^4.0.0-beta.x"; pi extension entry via pi.extensions
├── package-lock.json / node_modules/   (after npm install)
├── docs/
│   └── design-plan.md         # this document
├── index.ts                   # extension factory: runtime lifecycle, 5 tools, /subagents
│                              # command, message renderer, footer status, result flush hooks
└── src/
    ├── domain.ts              # BackendName, SubagentStatus, SpawnTask, SubagentEvent,
    │                          # RunOutcome, TranscriptItem/Part, SubagentSnapshot, tagged errors
    ├── backend.ts             # SubagentBackend + SubagentSession interfaces, BackendRegistry
    │                          # key + registry layer
    ├── backends/
    │   ├── stub.ts            # shared scripted fake-session machinery
    │   ├── pi.ts              # PiBackend layer (v1: stub profile; later: real pi SDK sessions)
    │   ├── claude.ts          # ClaudeBackend layer (v1: stub; later: @anthropic-ai/claude-agent-sdk)
    │   └── codex.ts           # CodexBackend layer (v1: stub; later: codex app-server JSON-RPC)
    ├── manager.ts             # SubagentManager service + layer: registry, cap, waitFor,
    │                          # cancel, prune, settle hook, event-fold into snapshots
    ├── read-model.ts          # sync SubagentReadModel bridge for the TUI
    ├── runtime.ts             # AppLayer composition + ManagedRuntime create/dispose helpers
    ├── result-delivery.ts     # deferred delivery buffer (copied from v1, unchanged)
    ├── result-delivery.test.ts
    ├── prompt.ts              # all model-facing strings (v1 copy + `agent` param description)
    ├── format.ts              # elapsed/context-utilization/activity-status formatting
    │                          # (merged copies of ../shared/{context-utilization,activity-status}.ts)
    └── ui/
        ├── transcript.ts      # sanitize + buildTranscriptLines over SubagentSnapshot
        └── takeover.ts        # SubagentDashboard + TakeoverView + openSubagentPicker (ported)
```

Notes:
- `package.json` is needed because `effect` is an npm dependency (extension-with-deps
  style from the extension docs). Everything else avoids new dependencies.
- v1's `child-session.ts` trust/tool-policy helpers are **not** copied in v1 of v2 (the
  stubs don't need them); the real pi backend will bring the needed subset into
  `backends/pi.ts` when implemented. The `resolveStandaloneChildProjectTrust` logic *is*
  still referenced by the design (SpawnTask.parentContext.projectTrusted) so the tool
  layer computes trust the same way v1 does.
- Suggested project scripts (per house rules, to be added): `check` (`tsc --noEmit`),
  `test` (`node --test` or vitest for `result-delivery` + manager fold tests against
  stub backends).

---

## 5. Migration/coexistence note

v1 and v2 register the same tool names (`subagent_spawn`, ...) and the same
`/subagents` command. While both live in `~/.pi/agent/extensions/`, pi will suffix
duplicate commands (`/subagents:1`, `/subagents:2`) and both tool sets would be
registered. During development, either (a) v2 uses temporary names
(`subagent2_spawn`, `/subagents2`), or (b) v1 is moved out of the auto-discovery dir.
Recommendation: (a) during development, rename to final names when v2 replaces v1.

---

## 6. Open questions (need user input)

1. **Per-backend spawn options.** v1's `model`/`provider`/`reasoning_effort` are
   pi-shaped. Options: (a) keep one generic `model` string + `reasoning_effort` that
   each backend interprets (proposed above — simplest for the LLM); (b) add a
   `backend_options` free-form object; (c) per-backend defaults in a config file with no
   per-spawn override. Which surface do you want the parent LLM to have?
2. **One-shot exec mode.** Should the interface expose a separate cheap
   `exec(task): Effect<RunOutcome>` (mapping to `codex exec` / `claude -p
   --output-format json` / a fresh in-memory pi session), or is one interactive-session
   path enough? Exec would forfeit takeover/steering for that subagent — is a
   `mode: "session" | "exec"` spawn parameter desirable, or backend-internal
   optimization only?
3. **Permissions/sandboxing for Claude/Codex children.** Subagents are headless, so
   interactive permission prompts are impossible. Do we run Claude with
   `bypassPermissions`/`--dangerously-skip-permissions` and Codex with
   `--full-auto`-style sandbox + never-ask approval policy? Should this be a global
   extension setting, per-spawn, or hardcoded? (Pi children inherit v1's trust-store
   logic — keep that as-is?)
4. **Concurrency cap scope.** Keep one global `MAX_RUNNING = 4`, or per-backend caps
   (e.g. 4 pi + 2 claude + 2 codex)? Global is proposed as default.
5. **Steering support parity in real backends.** Codex steering means
   interrupt-then-new-turn or queued `sendUserTurn`; Claude requires streaming-input
   mode from the start. OK to declare `capabilities.steering` and have the TakeoverView
   input show "(steering not supported)" if a backend can't, or is steering a hard
   requirement for all three?
6. **Model/thinking inheritance across backends.** When `agent: "claude"` and no model
   given, what's the default (e.g. always `opus`/`sonnet`)? Inheriting the parent pi
   model is meaningless cross-backend. Proposal: per-backend default model in a small
   config block; confirm.
7. **Binary/SDK discovery + failure UX.** When `codex`/`claude` isn't installed or has
   no credentials, should `subagent_spawn` fail fast with a clear tool error (proposed),
   or should the backends be hidden from the `agent` enum dynamically?
8. **Result truncation budgets.** Keep v1's numbers (24KB result message, 48KB wait
   total, 16KB per agent, 2KB check preview) unchanged?
9. **Effect version pinning.** Effect v4 is beta — pin an exact `4.0.0-beta.x` and
   accept manual bumps, or track the beta dist-tag?
10. **Persistence across reloads.** v1 loses all subagents on `session_shutdown`
    (disposeAll). Codex/Claude children are external processes that *could* outlive a
    pi reload — should v2 keep v1's kill-everything behavior (proposed for v1 of v2) or
    plan for reattach later?

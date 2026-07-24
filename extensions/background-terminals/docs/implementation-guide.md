# background-terminals — Implementation Guide

> Research phase output. Updated 2026-07-24 against:
> - `effect@4.0.0-beta.101` (verified installed in this package's `node_modules/effect`; the
>   `unstable/process` module exists there but we deliberately do NOT use it — see §6)
> - `@earendil-works/pi-coding-agent@^0.82.0` docs at
>   `/Users/davis/.vite-plus/js_runtime/node/24.18.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/`
> - Reference implementations: `extensions/subagents` (Effect v4 service/manager/read-model/tools)
>   and `extensions/workflows` (dashboard UI, status line, background completion follow-ups).
>
> Read alongside `extensions/subagents/docs/effect-v4-notes.md` (API cheat sheet) and
> `extensions/subagents/docs/effect-v4-extension-guide.md` (toolchain + ManagedRuntime boundary).
> Those two documents are authoritative for Effect v4 API names — do not use v3 APIs
> (`Effect.fork`, `Effect.async`, `Either`, `Context.Tag`, `Mailbox`, `ServiceMap` are all
> wrong; use `forkChild`/`forkDetach`, `Effect.callback`, `Result`, `Context.Service`, `Queue`).

## 1. What this extension is

The model can start long-running shell processes ("background terminals"), keep working while
they run, check on them, and stop them. It can **never** write to a running process's stdin —
processes are launched with `stdin: "ignore"`; there is no send/steer surface at all (this is
the key simplification vs. subagents' `send()`).

- Full stdout and stderr are captured **separately and completely** in private spill files;
  bounded in-memory tails keep `/ps` responsive (§7.4).
- Tool responses to the model are **always truncated** with the pi truncation utilities.
- When a process exits, the model is woken **exactly once** via `pi.sendMessage(...,
  { deliverAs: "followUp", triggerTurn: true })` — no polling — using the same
  deferred-delivery/consumed dance as subagents (§9).
- While ≥1 process is running, a one-line widget renders **directly above the editor**:
  `N background terminal(s) running • /ps to view` (§10).
- `/ps` opens a two-stage full-screen overlay (list → detail with scrollable stdout/stderr),
  modeled on `extensions/subagents/src/ui/takeover.ts` and
  `extensions/workflows/dashboard.ts` (§11).

## 2. Directory / file architecture

Mirror the subagents layout exactly (it is the known-green reference; `npm run check` passes
there against the pinned toolchain):

```
extensions/background-terminals/
├── package.json              # exact pins, see §3
├── tsconfig.json             # extends ../../tsconfig.json + effect LS plugin
├── index.ts                  # extension edge: tools, command, widget, events (plain TS + runTool)
├── docs/
│   └── implementation-guide.md   (this file)
├── src/
│   ├── domain.ts             # types, status union, errors, formatting helpers
│   ├── manager.ts            # TerminalManager Context.Service + Layer (the Effect core)
│   ├── output.ts             # OutputBuffer: bounded decoded text + byte counters (plain TS class)
│   ├── runtime.ts            # ManagedRuntime factory + runTool helper (copy of subagents')
│   ├── prompt.ts             # all model-facing strings (tool descriptions, result builders)
│   ├── result-delivery.ts    # deferred one-shot delivery map (copy of subagents')
│   └── ui/
│       ├── ps.ts             # /ps picker + detail view components
│       └── output-view.ts    # stdout/stderr → wrapped display lines
├── manager.test.ts           # node:test end-to-end through a real ManagedRuntime
├── output.test.ts            # OutputBuffer truncation/decoding unit tests
├── result-delivery.test.ts   # (copied semantics, tiny)
└── ps.test.ts                # selection-reconciliation tests (like takeover.test.ts)
```

Tests live at the package root, plain `node --test --experimental-strip-types`, exactly like
`extensions/subagents/package.json`'s `test` script. Note the repo-root `package.json` test
script (`node --test --experimental-strip-types extensions/*/*.test.ts`) will automatically
pick these up.

## 3. Toolchain (copy exactly, per effect-v4-extension-guide.md §1)

`package.json`:

```jsonc
{
  "name": "background-terminals",
  "private": true,
  "type": "module",
  "scripts": {
    "check": "tsc --noEmit -p .",
    "prepare": "effect-tsgo patch",
    "test": "node --test --experimental-strip-types manager.test.ts output.test.ts result-delivery.test.ts ps.test.ts"
  },
  "dependencies": {
    "effect": "^4.0.0-beta.99"
  },
  "devDependencies": {
    "@effect/tsgo": "^0.24.2",
    "typescript": "^7.0.2"
  }
}
```

`tsconfig.json` — identical to `extensions/subagents/tsconfig.json`:

```jsonc
{
  "extends": "../../tsconfig.json",
  "compilerOptions": { "plugins": [{ "name": "@effect/language-service" }] },
  "include": ["index.ts", "src/**/*.ts", "*.test.ts"]
}
```

Per AGENTS.md: add deps with an install command (`npm install effect@^4.0.0-beta.99`),
run `npm run check` when done, avoid explicit return types unless needed, no `as any`.
Verification runs from inside `extensions/background-terminals/` only — never root scripts
(house rule, effect-v4-extension-guide.md §7/§8).

Note: we do **not** need `@effect/platform-node`. Subagents' codex backend uses raw
`node:child_process` `spawn` inside Effect and that is the right model here too (§6).

## 4. Domain model (`src/domain.ts`)

Follow `extensions/subagents/src/domain.ts` (readonly interfaces, `Data.TaggedError`, status
string union, mutable-snapshot-behind-readonly-view trick lives in the manager).

```ts
import { Data } from "effect";

export type TerminalStatus = "running" | "done" | "failed" | "killed";
// "done"   = exited with code 0
// "failed" = exited non-zero, or spawn-level runtime error after start
// "killed" = terminated by bg_kill, UI kill, or session teardown

export interface TerminalSnapshot {
  readonly id: string;                 // "bt-1", "bt-2", ... (manager counter, like "sa-N")
  readonly command: string;            // exactly what the model asked to run (display string)
  readonly title: string;              // short model-provided name, shown in UI (<=80 chars)
  readonly cwd: string;                // resolved absolute cwd the process runs in
  readonly pid?: number;               // undefined only if spawn itself failed
  readonly status: TerminalStatus;
  readonly createdAt: number;          // Date.now() at spawn
  readonly settledAt?: number;         // Date.now() at exit/kill
  readonly exitCode?: number;          // null-safe: only set when exited via exit code
  readonly signal?: string;            // e.g. "SIGTERM" when terminated by signal
  readonly errorText?: string;         // spawn error / kill-escalation notes, bounded
  // Live output views (see src/output.ts):
  readonly stdout: OutputView;
  readonly stderr: OutputView;
}

export interface OutputView {
  readonly text: string;               // decoded, possibly head-trimmed text (bounded)
  readonly totalBytes: number;         // true total bytes ever received
  readonly truncatedBytes: number;     // bytes dropped from the head (0 = complete)
  readonly spillPath?: string;         // on-disk full capture, when spilling engaged (§7.6)
}

export class SpawnError extends Data.TaggedError("SpawnError")<{
  readonly message: string;
}> {}
export class ConcurrencyLimitError extends Data.TaggedError("ConcurrencyLimitError")<{
  readonly message: string;
}> {}
export class UnknownTerminalError extends Data.TaggedError("UnknownTerminalError")<{
  readonly message: string;
}> {}

export function formatElapsed(snap: TerminalSnapshot) { /* copy from subagents domain.ts */ }
```

### State transitions

```
        spawn ok                     exit code 0
 (none) ────────► running ───────────────────────► done
                    │                exit code ≠0 / 'error' event
                    ├─────────────────────────────► failed
                    │      bg_kill / UI x / session_shutdown
                    └─────────────────────────────► killed
 spawn throws (ENOENT etc.) → tool call fails; NO entry is tracked (SpawnError to the model)
```

Terminal states are final; there is no restart (unlike subagents' `send()` restart). A killed
process that raced an exit event keeps whichever settle landed first — settle must be
idempotent (`if (s.status !== "running") return;`, exactly like `settle()` in
`extensions/subagents/src/manager.ts`).

Timestamps: `createdAt`/`settledAt` are `Date.now()` millis (matches subagents; `formatElapsed`
consumes them). Exit status: record **both** `exitCode` (number | undefined) and `signal`
(string | undefined) from Node's `exit (code, signal)` callback — exactly one is non-null per
Node semantics; render "exit 0", "exit 137", or "SIGKILL" accordingly.

## 5. Effect architecture (`src/runtime.ts`, `src/manager.ts`)

### 5.1 Runtime boundary

Copy `extensions/subagents/src/runtime.ts` nearly verbatim (it is only 53 lines):

```ts
import { Cause, Exit, ManagedRuntime, type Effect } from "effect";
import { TerminalManagerLive } from "./manager.ts";

export function createTerminalRuntime() {
  return ManagedRuntime.make(TerminalManagerLive);
}
export type TerminalRuntime = ReturnType<typeof createTerminalRuntime>;

export async function runTool<A, E>(
  runtime: TerminalRuntime,
  effect: Effect.Effect<A, E>,
  options: { signal?: AbortSignal; interruptMessage?: string } = {},
) {
  const exit = await runtime.runPromiseExit(
    effect,
    options.signal ? { signal: options.signal } : undefined,
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    throw new Error(options.interruptMessage ?? "Operation was aborted.");
  }
  const [first] = Cause.prettyErrors(exit.cause);
  throw new Error(first?.message ?? Cause.pretty(exit.cause));
}
```

No `BackendRegistry` layer is needed — there is exactly one "backend" (node spawn), so
`AppLayer` is just `TerminalManagerLive`.

`index.ts` builds the runtime lazily and disposes it on `session_shutdown`, exactly like
`extensions/subagents/index.ts` lines 128–222:

```ts
let runtime: TerminalRuntime | undefined;
let managerPromise: Promise<TerminalManagerShape> | undefined;
const getRuntime = () => (runtime ??= createTerminalRuntime());
const getManager = () => {
  managerPromise ??= getRuntime().runPromise(TerminalManager).then((manager) => {
    manager.view.setOnSettled(onSettled);
    unsubStatus?.();
    unsubStatus = manager.view.subscribe(() => updateWidget(manager));
    updateWidget(manager);
    return manager;
  });
  return managerPromise;
};
```

### 5.2 TerminalManager service (`src/manager.ts`)

One `Context.Service` holding a plain `Map<string, Entry>` plus the synchronous read model
(the exact structure of `SubagentManager` — see `extensions/subagents/src/manager.ts`, which
is the single most important file to imitate):

```ts
export interface TerminalManagerShape {
  start(options: StartOptions): Effect.Effect<TerminalSnapshot, SpawnError | ConcurrencyLimitError>;
  status(id: string): Effect.Effect<TerminalSnapshot, UnknownTerminalError>;
  readonly list: Effect.Effect<ReadonlyArray<TerminalSnapshot>>;
  kill(ids: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<KillResult>>; // resolves when settled
  readonly disposeAll: Effect.Effect<void>;
  readonly view: TerminalReadModel;   // synchronous bridge for the TUI + widget
}

export class TerminalManager extends Context.Service<TerminalManager, TerminalManagerShape>()(
  "background-terminals/TerminalManager",
) {}

export const TerminalManagerLive: Layer.Layer<TerminalManager> =
  Layer.effect(TerminalManager, makeManager);
```

`makeManager = Effect.gen(function* () { ... })` closes over:

- `const entries = new Map<string, Entry>()` — mutable snapshot per entry (readonly view out).
- `const listeners = new Set<() => void>()` + `notify()` — any-change subscription for the
  widget and `/ps` list, with try/catch around each UI listener.
- One `Deferred<void>` per entry, completed synchronously and exactly once by `settle()`.
  Every `kill()` caller awaits the Deferreds for entries that were running when it began.
- A scoped `FiberSet.runtime` bridge for fire-and-forget UI kills, process-event settlement,
  and pruning. Completed fibers remove themselves; disposal waits for the set within a bound,
  and scope close interrupts cleanup still live after that bound.
- `let counter = 0` for ids; `let disposed = false`; `waitInterest` is NOT needed (there is no
  `bg_wait` tool in v1 — see §8 note), but the "consumed" concept still applies to `bg_kill`
  and `bg_status` so a settle isn't double-announced (§9.3).
- `yield* Effect.addFinalizer(() => disposeAll)` — the safety net so `runtime.dispose()` in
  `session_shutdown` kills every process even if the extension forgot (subagents manager.ts
  line 657).

Concurrency cap: subagents caps at `MAX_RUNNING = 4` with a synchronous reservation
(`Effect.suspend` before the first yield so parallel tool calls cannot race the check —
manager.ts lines 364–383). For terminals use `MAX_RUNNING = 8` (processes are cheaper than
agents) and the same reservation pattern; and `MAX_TRACKED = 32` completed entries retained,
pruned oldest-settled-first exactly like `pruneSettled()` (never prune running entries).

### 5.3 Where Effect fibers/queues/etc. do and don't earn their keep

Per effect-v4-extension-guide.md §0 the async core is Effect; per the codex backend precedent
the Node stream plumbing stays plain callbacks. Concretely:

- **Yes Effect:** the manager service/layer, `start` reservation, per-entry `Deferred`,
  `kill` (timeout + escalation + Deferred wait), scoped `FiberSet` cleanup, `disposeAll`
  (parallel bounded teardown), `runTool` boundary, and `Effect.addFinalizer`.
- **Plain TS callbacks:** `child.stdout.on("data")`, `child.on("exit")` handlers mutate the
  entry snapshot and call `notify()` directly. This is exactly what the codex backend does with
  its JSON-RPC stdout pump (`codex.ts` lines ~820–860). Do NOT build a
  `Queue<SubagentEvent>`/pump-fiber pipeline here — subagents needs that because three
  heterogeneous backends normalize into one event stream; a single spawn does not.

## 6. Node child_process design (the core of `start`)

Model on `makeCodexSession` in `extensions/subagents/src/backends/codex.ts` (spawn options,
kill-tree, terminate-with-escalation), minus the JSON-RPC machinery:

```ts
import { spawn } from "node:child_process";

const child = yield* Effect.try({
  try: () =>
    spawn(shellPath, ["-c", options.command], {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],       // ← stdin IGNORED: no input surface, ever
      detached: process.platform !== "win32",  // own process group on POSIX → group kill
    }),
  catch: (error) => new SpawnError({ message: boundedError(error) }),
});
```

Decisions and rationale:

- **Shell execution.** The model supplies one `command` string; run it through the platform
  shell (`/bin/sh -c` on POSIX, `cmd.exe /d /s /c` on Windows) so pipes/redirection work. Honor the
  user's configured shell if convenient (`~/.pi/agent/settings.json` has
  `"shellPath": ".../zsh-with-rc"`), but `/bin/sh` is an acceptable v1 — document which you
  pick in the tool description. Never `shell: true` with an args array (double-parse trap).
- **`stdin: "ignore"`** enforces the "no subsequent input" requirement at the OS level. A
  process that tries to read stdin gets EOF immediately, which is the honest contract (and the
  tool description must say so — interactive commands will exit or hang, and `bg_kill` is the
  remedy).
- **`detached: true` on POSIX** gives the child its own process group, so kill can signal
  `-pid` and take down the whole tree (grandchildren from `npm run dev` etc.). `killTree`
  keeps the direct-signal fallback when the group is gone; Windows uses `taskkill /T` and
  adds `/F` for the force-kill phase. `terminateChild` uses Effect
  callbacks/timeouts: SIGTERM now, SIGKILL after 2s if needed, then a final 500ms bound.
  Do NOT call `child.unref()` — we want the exit event, and pi owns the lifetime anyway.
- **Spawn failure semantics.** `spawn()` itself rarely throws; ENOENT arrives via
  `child.once("error", ...)`. Wire the error handler *before* returning from `start`, and treat
  an error event pre-exit as settling the entry to `failed` with `errorText` (mirror
  `failForProcessExit` in codex.ts). To catch instant failures, you may optionally wait one
  tick for `spawn` event vs `error` event, but simplest correct behavior: register the entry
  immediately as `running` and let the near-instant `error`/`exit` settle it; the model gets
  the settle notification milliseconds later.
- **Exit handling** (single source of truth for settling):

```ts
child.once("exit", (code, signal) => {
  finishOutput(entry);       // flush any pending partial decode
  settle(entry, {
    status: entry.killSignaled ? "killed" : code === 0 ? "done" : "failed",
    exitCode: code ?? undefined,
    signal: signal ?? undefined,
  });
});
```

  `killSignaled` is set in the same synchronous effect that sends SIGTERM, so a process that
  exits before signaling keeps its natural status while a signaled process reports `killed`.
  Settle is idempotent (§4).
- **cwd semantics.** The tool takes optional `working_dir`; resolve with
  `path.resolve(ctx.cwd, params.working_dir ?? ".")` and validate
  `fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()` in the tool handler *before* touching
  the runtime — throw a plain Error otherwise. This is copied from `subagent_spawn`'s handler
  (`extensions/subagents/index.ts` lines 262–265). No trust-store logic is needed (we are not
  spawning an agent in another project; a shell command in another directory is equivalent to
  what the bash tool already allows).

### 6.1 Why not `effect/unstable/process` yet?

`ChildProcess.make` + `ChildProcessHandle` is the eventual target, but the current Effect beta
cannot preserve the current process contract yet:

1. `forceKillAfter` does not correctly wait before SIGKILL on POSIX in this pin.
2. `ChildProcessHandle.exitCode` does not expose the actual terminating signal, while the
   public snapshot and model-facing output distinguish `SIGTERM` from `SIGKILL`.

This first pass therefore keeps raw spawn and stream callbacks, while moving termination
waits, escalation deadlines, settlement coordination, and cleanup ownership into Effect.
Do not add `@effect/platform-node` until both blockers can be resolved.

## 7. Output capture (`src/output.ts`)

### 7.1 Requirements recap

Capture stdout and stderr **separately** and **completely** (the user's "full stdout/stderr"),
viewable in `/ps`; tool responses truncated; memory must be bounded.

### 7.2 Decoding — do it right

Do NOT use `child.stdout.setEncoding("utf8")` naïvely-per-chunk... actually `setEncoding`
internally uses a StringDecoder and *is* multibyte-safe across chunk boundaries, which is why
codex.ts can use it. Two acceptable options; pick (a):

- (a) `child.stdout.setEncoding("utf8")` and receive `string` chunks (Node handles split
  UTF-8 sequences). Simplest, matches codex.ts line ~824.
- (b) accumulate `Buffer`s and decode with `new (await import("node:string_decoder")).StringDecoder("utf8")`.

Either way, strip nothing at capture time — raw text goes into the buffer; ANSI/control
sanitization happens at *render* time using `sanitizeText` (copy from
`extensions/subagents/src/ui/transcript.ts` lines 15–29; it exists precisely because raw ANSI
desyncs the TUI renderer).

### 7.3 OutputBuffer (bounded ring with head-drop + optional spill)

```ts
export class OutputBuffer {
  private chunks: string[] = [];
  private bytes = 0;            // bytes currently retained (Buffer.byteLength of chunks)
  totalBytes = 0;               // true total ever received
  truncatedBytes = 0;           // dropped from the head
  spillPath?: string;

  constructor(private maxRetainedBytes: number, private spill?: (chunk: string) => void) {}

  push(chunk: string) {
    /* Count and spill the complete chunk first. If the chunk alone exceeds
       maxRetainedBytes, discard older retained chunks and UTF-8-safely trim
       this chunk to its newest cap-sized tail. Otherwise append it and evict
       older whole chunks until retained bytes fit. Every discarded byte
       increments truncatedBytes; totalBytes counts the original input. */
  }
  view(): OutputView { /* { text: this.chunks.join(""), totalBytes, truncatedBytes, spillPath } */ }
}
```

Cache the `join("")` and invalidate on push so the 1Hz UI tick doesn't re-join megabytes.

### 7.4 Memory bounds vs "full inspection" — the honest tradeoff

Unbounded retention of a `yes`-style firehose is a hard memory leak (codex.ts caps its stderr
retain at 4 KiB and treats an unbounded protocol buffer as session-fatal for exactly this
reason). Resolution:

- **In-memory retained cap: 2 MiB per stream per process** (so ≤ 8 procs × 2 streams × 2 MiB =
  32 MiB worst case). The newest output is always retained; the head is dropped.
- **Spill-to-disk for the full capture** (this is what makes "full stdout/stderr" true even
  past the cap): create the shared/session directories with owner-only `0700` permissions,
  then open two `0600` append-mode `WriteStream`s under
  ``path.join(os.tmpdir(), "pi-background-terminals", sessionId, `${id}.stdout.log`)`` (and
  `.stderr.log`). A `WriteStream` serializes writes per stream; settlement ends and awaits
  both streams behind a bounded flush barrier before publishing the result. A stream error or
  flush timeout clears the affected full-log pointer and surfaces a bounded `errorText` note.
  The `/ps` detail view shows the in-memory tail and, when `truncatedBytes > 0`, a header line
  "first N KiB dropped from view — full log: <spillPath>"; model-facing results reference the
  same path. `disposeAll` removes the private session spill directory after all entry scopes
  and spill flushes complete, so secret-bearing logs do not outlive the owning pi session.
- Precedent for "truncate + point at the full file": docs/extensions.md "Output Truncation"
  section recommends exactly this shape for tool results.

### 7.5 Entry wiring inside `start`

Per entry, like subagents' `spawn` (manager.ts lines 385–466):

```ts
const scope = yield* Scope.make();
const settled = yield* Deferred.make<void>();
// finalizer kills the tree; registered in the scope so BOTH kill() and disposeAll()
// and runtime.dispose() converge on one teardown path:
yield* Scope.provide(
  Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* terminateChild(child, () => entry.stdioClosed, markKillSignaled);
      yield* Deferred.await(settled).pipe(
        Effect.timeout(SETTLE_GRACE_MS),
        Effect.ignore,
      );
      // If still running, flush output within its bound and settle here.
    }),
  ),
  scope,
);
entries.set(id, { snapshot, child, scope, stdoutBuf, stderrBuf, settled });
```

`kill(ids)` then is: `Scope.close(entry.scope, Exit.void)` (bounded with
`Effect.timeout(STOP_TIMEOUT_MS)` + `Effect.ignore`) in the scoped cleanup `FiberSet`, then
await every captured entry's `Deferred`. Return per-id `{ id, status, killed: boolean }`
results and treat already-settled ids as no-ops rather than errors.

`disposeAll`: set `disposed = true`, snapshot `[...entries.values()]`, close every scope with
`{ concurrency: "unbounded" }` and a 5s timeout each — verbatim subagents `disposeAll`
(manager.ts lines 596–618).

### 7.6 Race conditions checklist (each has a subagents precedent)

- **Spawn vs concurrent spawn past the cap** → synchronous reservation before first yield
  (`reserved++` inside `Effect.suspend`; decrement in `Effect.ensuring`).
- **Kill vs natural exit** → idempotent `settle` with one authoritative precedence rule. If
  kill reaches a live shell, set `killSignaled` in the same effect that signals it and report
  `killed`. If the shell's `exit` event was already observed, preserve its natural
  `done`/`failed` status even when cleanup must still signal descendants holding stdio open.
  A missing `close` after `exit` starts a bounded grace, then closes the entry scope so the
  surviving process group is terminated and the entry cannot occupy a running slot forever.
- **Exit event vs scope close ("stream ended unexpectedly")** → we have no pump, so this class
  disappears; the only settle source is the `exit`/`error` listener.
- **Settle during teardown** → `if (!disposed) onSettled?.(...)` so a result is never queued
  into a shutting-down session (subagents `settle`, manager.ts line 280).
- **Tool AbortSignal during `bg_kill`'s wait** → interruption stops only that caller's
  `Deferred.await`; the detached scope-close stays owned by the manager `FiberSet`, and
  `Effect.ensuring` still releases bookkeeping.
- **Late output after exit** → Node may still flush 'data' after 'exit' is observed in rare
  orderings; buffers accept pushes until `close` — harmless because settle doesn't freeze the
  buffer, and the UI just shows more text. (Optionally listen on `close` instead of `exit` to
  be strictly after stdio flush; `close` fires when stdio streams end — prefer `close` for
  settling to guarantee complete output at notification time, and keep `exit` only to record
  code/signal. This is the one place we improve on codex.ts, which doesn't need output
  completeness.)

**Recommended:** record `{code, signal}` on `exit`, settle + notify on `close`. This
guarantees the completion follow-up message contains the final output tail.

## 8. Tools (`index.ts` + `src/prompt.ts`)

All model-facing strings live in `src/prompt.ts` (subagents convention). Register with
`pi.registerTool`; parameters via `typebox` `Type.Object`; use `StringEnum` from
`@earendil-works/pi-ai` if any enum appears (Google-compat rule, docs/extensions.md
"Tool Definition"). Throw plain `Error` for failures (that is what sets `isError`).

### 8.1 `bg_start`

```ts
parameters: Type.Object({
  command: Type.String({ description: "Shell command line to run in the background (sh -c on POSIX, cmd.exe /d /s /c on Windows). It receives no stdin (EOF immediately); interactive commands will not work." }),
  title: Type.String({ description: "Short human-readable name shown in listings and the UI" }),
  working_dir: Type.Optional(Type.String({ description: "Working directory (default: current working directory)" })),
})
```

Handler: validate cwd (§6), `title.trim().slice(0, 80) || "terminal"`, then
`runTool(getRuntime(), manager.start({ command, title, cwd }))`. Result text (build in
prompt.ts, like `buildSubagentSpawnResult`):

```
Started background terminal bt-3 "dev server" (pid 12345, /Users/davis/project).
It runs in the background with no stdin. You'll get a message when it exits, or use
bg_status(id: "bt-3") to peek, bg_kill to stop it, bg_list to see all.
```

`promptSnippet`: "Run a long-lived shell command in the background (dev servers, builds,
watchers); output is captured and you're notified on exit".
`promptGuidelines` (name the tool explicitly — docs warn "this tool" is ambiguous):
- "Use bg_start for commands expected to run long or indefinitely (servers, watch modes); use the regular bash tool for quick commands."
- "bg_start processes receive no stdin — never start a command that requires interactive input."
- "After bg_start, keep working; the exit result arrives automatically. Use bg_status only when you need current output before continuing."

Description documents the truncation limits (docs requirement) and the no-stdin contract.

### 8.2 `bg_status`

```ts
parameters: Type.Object({ id: Type.String({ description: 'Terminal id, e.g. "bt-1"' }) })
```

Unknown id → throw with the known-ids list (copy the exact error style from `subagent_check`:
`Unknown terminal id "x". Known: bt-1, bt-2.`). Result: one metadata line
(`bt-1 [running] "dev server" (pid 12345, 3m12s, exit -, /path)`) then **tail-truncated**
stdout and stderr sections:

```ts
const stdout = truncateTail(snap.stdout.text, { maxBytes: 16 * 1024, maxLines: 400 });
const stderr = truncateTail(snap.stderr.text, { maxBytes: 8 * 1024, maxLines: 200 });
```

`truncateTail` (not head) because for process logs the end matters — this is the documented
guidance in docs/extensions.md Output Truncation. When truncated, append
`[stdout truncated: showing last X of Y. Full log: <spillPath or "in /ps viewer">]` using
`formatSize` + the truncation result fields (see `truncatedOutput()` in subagents index.ts for
the message shape). If `bg_status` observes a settled entry whose completion message is still
pending delivery, mark it consumed (§9.3).

### 8.3 `bg_list`

No parameters. One line per entry via a `describeTerminal(snap)` helper (mirror
`describeSubagent`): id, status, title, pid, elapsed, exit code/signal, cwd, and total output
sizes (`formatSize(stdout.totalBytes)`). "No background terminals." when empty. Include both
running and completed (completed entries are retained up to `MAX_TRACKED`).

### 8.4 `bg_kill`

```ts
parameters: Type.Object({ ids: Type.Array(Type.String(), { description: 'Terminal ids to stop, e.g. ["bt-1"]' }) })
```

Validate all ids known first (throw listing unknowns, copy `subagent_cancel`). Then
`runTool(getRuntime(), manager.kill(ids), { signal, interruptMessage: "Kill wait aborted; termination continues in the background." })`.
Report per id: `Killed bt-1 "dev server" (SIGTERM).` or `bt-2 "build" was already done (exit 0).`
Killing marks the settle consumed so the model doesn't also get the async completion message
(§9.3) — same reason subagents' `cancel` calls `addInterest` before interrupting.

**No `bg_wait` and no `bg_send`.** No stdin is a hard requirement. Blocking wait is
deliberately omitted in v1: completion notification makes it redundant, and it would drag in
subagents' full `waitInterest` machinery. If it's ever wanted, each entry already has a
settlement `Deferred` and the subagents `waitFor` result shaping is the template.

## 9. Completion notification — exactly once, no polling, no turn races

This is the subtlest requirement. Copy the subagents solution wholesale; it exists precisely
to solve this problem (see comments in `extensions/subagents/index.ts` lines 168–222 and
`result-delivery.ts`).

### 9.1 Mechanism

On settle, the manager invokes a hook `onSettled(snap, consumed)` registered by `index.ts`
(same `view.setOnSettled` bridge). The hook:

```ts
const resultDelivery = createDeferredResultDelivery<TerminalSnapshot>();  // copy the 20-line module

const onSettled = (snap: TerminalSnapshot, consumed: boolean) => {
  if (consumed) { resultDelivery.consume([snap.id]); return; }
  // Defer a deep-enough copy: the live snapshot keeps mutating (late output flushes).
  resultDelivery.defer({ ...snap, stdout: { ...snap.stdout }, stderr: { ...snap.stderr } });
  if (sessionContext?.isIdle()) flushResults();
};

pi.on("agent_settled", flushResults);

const flushResults = () => {
  for (const snap of resultDelivery.drain()) {
    pi.sendMessage({
      customType: "background-terminal-result",
      content: buildTerminalResultMessage(snap),   // prompt.ts; truncateTail'd output inside
      display: true,
      details: { id: snap.id, title: snap.title, status: snap.status, exitCode: snap.exitCode, signal: snap.signal },
    }, { deliverAs: "followUp", triggerTurn: true });
  }
};
```

### 9.2 Why this is race-free (the reasoning to preserve in code comments)

- `deliverAs: "followUp"` queues the message until the agent has no more tool calls; it never
  interrupts a mid-turn stream (docs/extensions.md § pi.sendMessage).
- `triggerTurn: true` wakes the model immediately **iff idle**; if busy, the queued follow-up
  is delivered when the current run settles — either way exactly one delivery.
- The `Map`-keyed `resultDelivery` (keyed by id, `drain()` clears) makes double-delivery
  structurally impossible even if both the `isIdle()` fast-path and the `agent_settled` event
  fire: whoever drains first wins, the second drain sees an empty map.
- The `consumed` flag closes the remaining hole: if the model is *currently inside*
  `bg_kill` (which returns the final state itself), the settle must not ALSO queue a message.
  Manager computes `consumed` = "a kill/status collection is in flight for this id" at settle
  time (subagents: `waitInterest`; here: the `kill()`-marked id set).
- `if (!disposed)` in `settle` prevents queueing into a shutting-down session.

### 9.3 Consumed-set details

Keep a `Map<string, number> killInterest` in the manager; `kill()` adds interest before
signaling and releases in `Effect.ensuring` (identical to `addInterest`/`releaseInterest`).
`settle` computes `consumed = (killInterest.get(id) ?? 0) > 0`. Additionally, `bg_kill`'s tool
handler calls `resultDelivery.consume(ids)` after `runTool` returns, mirroring
`subagent_wait`'s "settlement may have happened before this wait began" comment (index.ts
line 352) — belt and suspenders for the settled-before-kill-started ordering.

### 9.4 Result message content

`buildTerminalResultMessage` (prompt.ts): first line
`Background terminal bt-3 "dev server" exited (exit 1) after 4m12s.` (or `(SIGTERM)` /
`was killed`), then tail-truncated stdout (≤ 16 KiB) and, if non-empty, stderr (≤ 8 KiB) in
labeled sections, with truncation notes pointing at the spill file. Register a
`pi.registerMessageRenderer("background-terminal-result", ...)` for a collapsed preview —
copy the subagent-result renderer (index.ts lines 514–561: icon by status, header line,
8-line preview, "ctrl+o to expand").

## 10. Widget above the editor

Requirement: visible **only while ≥1 process is running**, directly above editor, text
`N background terminal(s) running • /ps to view`.

API: `ctx.ui.setWidget(key, linesOrFactory)` — default placement is already **above the
editor** (docs/extensions.md "Widgets, Status, and Footer" + tui.md Pattern 5); do NOT pass
`placement: "belowEditor"`. Clear with `setWidget(key, undefined)`.

```ts
const updateWidget = (manager: TerminalManagerShape) => {
  if (!ui) return;                               // captured from session_start ctx.hasUI
  const running = manager.view.list().filter((s) => s.status === "running").length;
  if (running === 0) { ui.setWidget("background-terminals", undefined); return; }
  ui.setWidget("background-terminals", (_tui, theme) => {
    const line =
      theme.fg("warning", "■ ") +
      theme.fg("text", `${running} background terminal${running === 1 ? "" : "s"} running`) +
      theme.fg("dim", " • ") + theme.fg("accent", "/ps") + theme.fg("dim", " to view");
    return { render: () => [line], invalidate: () => {} };
  });
};
```

Drive it from `manager.view.subscribe(...)` exactly like subagents drives `setStatus`
(index.ts lines 139–166) — the subscription fires on every state change, including settles, so
the widget disappears the moment the last process exits. Guard `ctx.hasUI`; wrap in try/catch
like workflows' `updateIndicator` ("UI may be unavailable"). Clear the widget in
`session_shutdown` before disposing the runtime.

(Singular/plural: render `1 background terminal running`, `2 background terminals running` —
implement the requested "terminal(s)" sense as proper pluralization.)

## 11. `/ps` command + two-stage UI (`src/ui/ps.ts`, `src/ui/output-view.ts`)

Register `pi.registerCommand("ps", { description: "List and inspect background terminals", handler })`.
Handler: TUI-mode guard + empty-state notify + open picker — copy the `/subagents` command
skeleton (index.ts lines 565–587). Non-TUI (`ctx.mode !== "tui"`): print a plain-text listing
via `ctx.ui.notify` like workflows' non-TUI fallback, or just the notify error like subagents —
prefer the listing (cheap and useful in RPC mode).

### 11.1 Stage 1 — list (dashboard)

Copy `SubagentDashboard` (`src/ui/takeover.ts` lines 109–344) with terminal rows:

- Entry point loop `openTerminalPicker(ctx, view)` — the `while (true)` pick→detail→back loop
  of `openSubagentPicker` (lines 52–86), full-screen overlay
  (`{ overlay: true, overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" } }`).
- Row left: selection marker, status glyph (`■` warning/success/error — reuse `statusGlyph`
  pattern; map `killed` to muted/error), title, dim id.
- Row right: `pid 12345 · 3m12s · exit 0` (or `running` / `SIGTERM`), dim separators — the
  `split(left, right, width)` helper from workflows' dashboard is the cleanest to copy.
- Keys: up/down/j/k select, enter open, `x` kill selected (only when running →
  `view.requestKill(id)` fire-and-forget, precedent: dashboard `x` → `requestAbort`), esc
  close. Hint line built from `keybindings.getKeys(...)` via the `configuredKeys` helper.
- 1Hz `setInterval` ticker for elapsed times + `view.subscribe` re-render, both cleaned up in
  `dispose()`/`cleanup()` (idempotent closed-flag pattern — copy it exactly; overlay components
  are disposed on close and must not be reused, tui.md "Overlay Lifecycle").
- Keep list selection stable across refreshes with `reconcileDashboardSelection` (takeover.ts
  lines 95–107) — copy it and its test (`takeover.test.ts`).

### 11.2 Stage 2 — detail (read-only inspector)

Copy `TakeoverView` (takeover.ts lines 350–563) **minus the Input line** (read-only: no
`Focusable`, no `Input`, no `requestSend`). Layout:

```
────────────────────────────────────────────────────────────
■ bt-3 · dev server · running · 4m12s · pid 12345 · ~/project
$ npm run dev
────────────────────────────────────────────────────────────
[ tab: stdout (1.2MB) | stderr (4KB) ]        ← `t` toggles streams
  ...scrollable output lines (sanitized, wrapped, tail-pinned)...
  ... 120 lines below · ↓/pgdn
────────────────────────────────────────────────────────────
esc back · t stdout/stderr · x kill · ↑/↓ scroll · pgup/pgdn page · g/G top/bottom
────────────────────────────────────────────────────────────
```

- Metadata header: status glyph, id, title, status word, elapsed (`formatElapsed`), pid, cwd,
  exit code/signal when settled, total sizes (`formatSize`), truncation note when
  `truncatedBytes > 0` (with spill path).
- **stdout/stderr shown separately** (requirement): a `t` key toggles the active stream;
  header tab shows both sizes. (Alternative side-by-side split like workflows' phases/agents
  panels is more code for less readability of wide log lines — use the toggle.)
- Output rendering (`src/ui/output-view.ts`): split buffer text on `\n`, `sanitizeText` each
  line (copy from transcript.ts — ANSI strip is mandatory or the overlay smears), wrap with
  `wrapTextWithAnsi`, `truncateToWidth`. Scroll state = offset-from-bottom, 0 = pinned to
  bottom so a running process live-tails; clamp `scrollOffset` to `maxOffset` each render
  (TakeoverView lines 510–543 is exactly this fixed-height-viewport math — copy it, including
  the "scroll status consumes a viewport row" trick so height never jumps).
- Live updates: `view.subscribeTo(id, ...)` per-entry subscription + the 50ms
  `scheduleRender` debounce (TakeoverView lines 406–414 — a chatty process emits a chunk per
  write; do not repaint per chunk).
- Keys: esc/left back to list (loop re-opens dashboard), `x` kill (running only), scroll keys
  via `keybindings.matches(data, "tui.editor.cursorUp"/"cursorDown"/"pageUp"/"pageDown")` plus
  j/k and g/G (workflows transcript view precedent).
- Big-buffer perf: with the 2 MiB cap, worst case ~30k lines; recompute wrapped lines only when
  the buffer version or width changed (cache `(version, width) → lines`), not per render tick.

### 11.3 Read model

```ts
export interface TerminalReadModel {
  list(): ReadonlyArray<TerminalSnapshot>;
  get(id: string): TerminalSnapshot | undefined;
  size(): number;
  subscribe(listener: () => void): () => void;
  subscribeTo(id: string, listener: () => void): () => void;
  requestKill(id: string): void;   // fire-and-forget via the scoped FiberSet runtime
  setOnSettled(hook?: (snap: TerminalSnapshot, consumed: boolean) => void): void;
}
```

Verbatim shape of `SubagentReadModel` minus `requestSend`. Snapshots are live objects; the UI
must not mutate them (same doc comment as manager.ts line 89).

## 12. Lifecycle: reload / new / resume / fork / shutdown

pi's session replacement flow (docs/extensions.md "Lifecycle Overview" + session_shutdown):
`/new`, `/resume`, `/fork`, `/reload`, and quit all emit `session_shutdown` (with `event.reason`)
for the old extension instance, then re-instantiate extensions and emit `session_start`.
Consequences:

- **Processes do not survive any session transition.** In `session_shutdown`: clear
  `resultDelivery`, unsubscribe, clear widget, null the ui/context refs, then
  `await closing?.dispose()` — the ManagedRuntime close runs the manager finalizer →
  `disposeAll` → every entry scope → `terminateChild` (SIGTERM→SIGKILL tree kill). This is
  the identical teardown in subagents index.ts lines 210–222; each scope close is bounded
  (5s timeout) so a wedged process cannot hang shutdown, and SIGKILL covers it anyway.
- **Spill files do not survive the session either.** `disposeAll` first closes every entry
  scope and awaits bounded spill flushes, then recursively removes its owner-only session
  directory. Paths shown in the old transcript are intentionally session-lifetime pointers.
- **No persistence / no resurrection.** Unlike workflows (which persists `workflow.json` and
  marks stale "running" runs as aborted on reload — dashboard.ts lines 286–297), v1 keeps no
  cross-session record: killed-on-shutdown processes simply disappear. Optionally append a
  `pi.appendEntry("background-terminals-note", {...})` breadcrumb ("bt-2 'dev server' was
  killed by session shutdown") so a resumed session's transcript explains the vanished
  terminal — cheap and worth doing; entries don't enter LLM context (docs: appendEntry).
  The model-facing story stays consistent because tool results always describe terminals as
  session-scoped ("killed when the session ends" in `bg_start`'s description).
- **Do not spawn from stale contexts.** All spawning goes through tool handlers with a live
  `ctx`; the manager rejects `start` when `disposed` (SpawnError "shutting down", subagents
  manager.ts lines 370–374 precedent).
- **Fork/clone:** nothing special — same shutdown+start pair; the new instance starts empty.

## 13. Truncation constants (single place, `index.ts` top)

```ts
const STATUS_STDOUT_MAX = 16 * 1024;   // bg_status stdout tail
const STATUS_STDERR_MAX = 8 * 1024;    // bg_status stderr tail
const RESULT_STDOUT_MAX = 16 * 1024;   // completion follow-up stdout tail
const RESULT_STDERR_MAX = 8 * 1024;
const RETAINED_PER_STREAM = 2 * 1024 * 1024;  // in-memory cap per stream (spill keeps the rest)
```

All clamped by `Math.min(..., DEFAULT_MAX_BYTES)` and `DEFAULT_MAX_LINES` (imports from
`@earendil-works/pi-coding-agent`, verified exported in `dist/index.d.ts`) — same defensive
clamp as `truncatedOutput` in subagents index.ts. Always `truncateTail` for process output.

## 14. Test plan

Follow the house style: `node:test` + `assert/strict`, end-to-end through a real
`ManagedRuntime`, minimal count, deterministic (subagents `manager.test.ts` is the template,
including the `withManager` fixture that guarantees `runtime.dispose()` in `finally`).

**`output.test.ts`** (pure, no processes)
1. push/view roundtrip; totalBytes/truncatedBytes accounting when the cap evicts head chunks.
2. multibyte boundary: feeding split UTF-8 via setEncoding path is Node's job, but verify the
   buffer never splits what it was given and byte counts use `Buffer.byteLength`.
3. spill callback receives every chunk in order even after eviction.

**`manager.test.ts`** (real processes — use `node -e` one-liners for portability, no shell
tricks; they exist on any machine running pi)
1. happy path: `start` node printing to stdout+stderr then exiting 0 → status transitions
   running→done, exitCode 0, both buffers correct and separate, settle hook fired once with
   `consumed: false`.
2. non-zero exit → `failed`, exitCode captured.
3. `kill` on a `setInterval` never-exiting script → `killed`, signal recorded, `kill()` only
   resolves after settle; second `kill` of same id reports already-settled, no error.
4. process-tree termination: spawn a grandchild that updates a unique heartbeat sentinel,
   kill, then use bounded polling with an explicit timeout to confirm both that the process is
   gone and that its unique sentinel stopped changing. The sentinel ties the assertion to the
   spawned child so PID reuse cannot create a false pass.
5. concurrency cap: cap+1 concurrent starts → last fails with ConcurrencyLimitError;
   reservation released on spawn failure (start a bogus binary → SpawnError → slot free).
6. consumed semantics: settle during an in-flight `kill` reports `consumed: true`.
7. `disposeAll` (via `runtime.dispose()`) kills a running process and settles it as killed;
   no settle hook fires after dispose (`disposed` guard).
8. pruning: exceed MAX_TRACKED with settled entries → oldest pruned, running never pruned.
9. SIGTERM-resistant process → SIGKILL after the 2s grace, within the 5s close bound.
10. aborted `bg_kill` wait → detached escalation still reaches SIGKILL and settles.
11. overlapping multi-id kills → every caller observes every captured settlement; each
    settle hook fires once and consumed state remains true.
12. shell `exit` without stdio `close` → bounded cleanup reaps the descendant holding the
    pipes, preserves the shell's natural exit status, and releases the running slot.

**`result-delivery.test.ts`** — consume-before-drain, drain-once (copy subagents' file).

**`ps.test.ts`** — `reconcileTerminalSelection` behavior (copy `takeover.test.ts` cases).

**Manual validation (must actually run pi):**
- `pi` → ask the model to `bg_start` a dev-server-like command → widget appears above editor
  with correct count/pluralization → `/ps` list → enter detail → live tail scrolls, `t`
  toggles stderr, ANSI-heavy output (e.g. `npm run dev`) renders without smearing → back →
  `x` kills → widget disappears when last settles → completion message arrives exactly once,
  rendered collapsed, expands with ctrl+o.
- Race check: start a 2s `sleep`-then-echo while the model is mid-long-turn → result arrives
  as follow-up after the turn, not mid-stream, and only once.
- `/new` and `/reload` with a running process → process is dead afterwards (`ps aux | grep`),
  no orphan, widget cleared.
- `npm run check` green; `npm test` green; repo-root `npm run format:check` clean for the new
  files (prettier covers `extensions/**/*.ts`).

## 15. Pitfalls (each burned someone in the reference code)

1. **Effect v3 API names don't exist** — `Effect.fork`, `Effect.async`, `Either`,
   `Layer.scoped`, `Context.Tag`. Check every API against effect-v4-notes.md before writing it.
2. **`Queue.end` needs `Cause.Done` in the error type** — only relevant if you add a queue;
   this design avoids queues entirely.
3. **Don't render raw process output** — ANSI/tabs/control chars desync the TUI
   (transcript.ts's `sanitizeText` comment). Sanitize at render, never at capture.
4. **Don't repaint per data chunk** — 50ms debounce (TakeoverView) or the UI starves input.
5. **Overlay components are disposed on close** — never cache and re-show; re-invoke
   `ctx.ui.custom` (tui.md Overlay Lifecycle). Make `cleanup()` idempotent with a `closed`
   flag and clear every timer in it.
6. **`detached` + group kill or you orphan grandchildren** — `sh -c "npm run dev"` without
   process-group SIGTERM leaves node servers running after pi exits (codex.ts `killTree`
   comment).
7. **Settle must be idempotent and single-sourced** — kill vs exit vs error events race;
   `if (status !== "running") return` in settle. Set `killSignaled` atomically with SIGTERM
   only while the shell is live; an already-observed natural exit keeps `done`/`failed` even
   if its surviving process group still needs cleanup.
8. **Never queue messages into a dying session** — `disposed` guard around `onSettled`, and
   try/catch around `pi.sendMessage` (workflows wraps its follow-up send in try/catch:
   "Session may be shutting down").
9. **Defer a copy, not the live snapshot** — the buffer keeps mutating after settle (late
   flushes); subagents defers `{ ...snap, meta: { ...snap.meta } }` for the same reason.
10. **Synchronous reservation for the cap** — an `await` between check and increment lets
    parallel tool calls race past it (manager.ts spawn comment).
11. **Bound every teardown wait** — 5s timeout on scope closes, or a wedged child hangs
    `session_shutdown` (subagents `disposeAll` + `abortEntry` comments).
12. **Snapshot kill interest before Deferred completion** — Effect can resume kill waiters
    immediately; compute `consumed` before `Deferred.doneUnsafe` so their `ensuring`
    blocks cannot release interest first.
13. **Tool output limits are a hard requirement** — unbounded stdout in a tool result causes
    context overflow/compaction failures (docs Output Truncation). Truncate *everything* the
    model sees, including the completion message.
14. **`prepareArguments` is not needed v1** — but never rename/retype `bg_*` parameters later
    without adding it (resumed sessions replay old tool calls; docs Tool Definition).
15. **`hasUI`/`mode` guards** — widget + `/ps` must no-op gracefully in print/RPC modes.

## 16. Acceptance checklist

- [ ] `npm install && npm run check` green in `extensions/background-terminals` (TS7 + Effect LS).
- [ ] `npm test` green (manager, output, result-delivery, ps selection).
- [ ] Tools registered: `bg_start`, `bg_status`, `bg_list`, `bg_kill`; descriptions document
      no-stdin, session-scoped lifetime, and truncation limits; no stdin/steer surface exists.
- [ ] stdout and stderr captured separately and completely (in-memory tail + spill file);
      `/ps` detail can inspect both, read-only, scrollable, ANSI-sanitized, live-tailing.
- [ ] Every model-visible output path truncated (`truncateTail` + clamps) with pointers to the
      full log.
- [ ] Exactly-once async completion notification via `sendMessage followUp + triggerTurn`,
      deferred-delivery map, consumed-set for kill, `agent_settled` flush, `isIdle()` fast
      path, `disposed` guard. No polling anywhere.
- [ ] Widget above editor only while ≥1 running, text `N background terminals running • /ps to
      view`, cleared on last settle and on shutdown.
- [ ] `/ps` two-stage overlay: list (select/kill/open) → detail (metadata, stdout/stderr
      toggle, scroll, back), matching subagents/workflows interaction conventions and hint
      lines from `keybindings.getKeys`.
- [ ] Kill terminates the whole process tree (SIGTERM → 2s → SIGKILL), records exit
      code/signal, resolves only after settle.
- [ ] `session_shutdown` (quit/reload/new/resume/fork) kills all processes within bounded
      time via `runtime.dispose()`; no orphans; no messages sent during teardown.
- [ ] Completed entries retained (≤ MAX_TRACKED, pruned oldest-settled) and visible in
      `bg_list` + `/ps`; running entries never pruned.
- [ ] Concurrency cap enforced race-free; ids are `bt-N`; cwd resolved against `ctx.cwd` and
      validated; timestamps and elapsed rendering consistent with subagents.
- [ ] Code style: model strings in `prompt.ts`, Effect only in the async core, plain TS
      callbacks for stream plumbing, no `as any`, prettier-clean.

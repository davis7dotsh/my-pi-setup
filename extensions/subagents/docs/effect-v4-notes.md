# Effect v4 — Practical Notes for the Subagents Extension

> **Building a new pi extension on this stack?** Start with the migration-oriented
> [`effect-v4-extension-guide.md`](./effect-v4-extension-guide.md) (toolchain setup, the
> `ManagedRuntime` + `runTool` boundary, when *not* to use Effect, per-extension recipes).
> This file is the deeper Effect API reference it points back to.

> **Verified against:** `effect@4.0.0-beta.98` and `@effect/platform-node@4.0.0-beta.98`
> (npm dist-tag `beta`, checked 2026-07-13). Every snippet in this doc was type-checked
> with `tsc --strict` against these packages, and the process-spawning / runtime snippets
> were executed with Node 24. v4 source lives in the **`Effect-TS/effect-smol`** repo
> (not `Effect-TS/effect`); the official migration guide is
> [`effect-smol/MIGRATION.md`](https://github.com/Effect-TS/effect-smol/blob/main/MIGRATION.md)
> plus the `migration/*.md` files next to it (including a machine-readable
> `migration/v3-to-v4.md` rename map).

## Install

```bash
npm install effect@beta @effect/platform-node@beta
```

Big structural facts:

- **One version number for everything.** All ecosystem packages release together at
  `4.0.0-beta.N`. `@effect/platform-node` must match `effect` exactly.
- **`@effect/platform` is gone — merged into core `effect`.** `FileSystem`, `Path`,
  `PlatformError`, `Terminal`, `Stdio` are now top-level `effect` modules.
  `@effect/platform-node` remains as the Node *implementation* package.
- **`effect/unstable/*` namespace.** Modules that may break in minor releases:
  `effect/unstable/process` (child processes — the one we need), `http`, `rpc`, `cli`,
  `ai`, `workers`, etc. Everything outside `unstable/` follows strict semver.
- **`"type": "module"`**, ESM-first. Works with `moduleResolution: NodeNext` or `Bundler`.
- Runtime keep-alive is built in now: a fiber suspended on `Deferred.await` etc. keeps
  the Node process alive without `NodeRuntime.runMain` (v3 needed runMain for that).

## Cheat sheet: v3 → v4 renames you will actually hit

| v3 | v4 |
| --- | --- |
| `Context.Tag` / `Effect.Service` | `Context.Service` (`Effect.Service` is **gone**) |
| `Effect.fork` | `Effect.forkChild` |
| `Effect.forkDaemon` | `Effect.forkDetach` |
| `Effect.async` | `Effect.callback` |
| `Effect.catchAll` | `Effect.catch` |
| `Effect.catchAllCause` / `catchAllDefect` | `Effect.catchCause` / `catchDefect` |
| `Effect.zipRight` / `zipLeft` | `Effect.andThen` / `Effect.tap` |
| `Effect.either` | `Effect.result` |
| `Either` module | `Result` (`Result.succeed` / `Result.fail`) |
| `Layer.scoped` | `Layer.effect` (all layers are scoped-capable now) |
| `Mailbox` | `Queue` (Queue absorbed Mailbox: done/fail signalling built in) |
| `FiberRef` | `Context.Reference` (module `effect/References`) |
| `Scope.extend` | `Scope.provide` |
| `Stream.async*` (all 4 variants) | `Stream.callback` |
| `Stream.fromChunk(s)` | `Stream.fromArray` / `Stream.fromArrays` (Chunk de-emphasized; arrays used) |
| `Schema.TaggedError` | `Schema.TaggedErrorClass` |
| `@effect/platform/Command` | `effect/unstable/process` → `ChildProcess` |
| `@effect/platform/CommandExecutor` | `effect/unstable/process` → `ChildProcessSpawner` |
| `@effect/platform/FileSystem` | `effect/FileSystem` |
| `Runtime.runPromise(runtime)(...)` | gone — use `ManagedRuntime` methods directly |
| `UnknownException` (tryPromise default) | `Cause.UnknownError` |

Removed with no replacement: `Effect.forkAll`, `Effect.forkWithErrorHandler`.
Early v4 betas renamed `Context` → `ServiceMap`; **that was reverted** — beta.98 uses
`Context` again (ignore older blog posts/AI answers mentioning `ServiceMap`).

---

## 1. Basics: `Effect.gen`, running, the Promise boundary

Unchanged in spirit from v3. `Effect<A, E, R>` = success `A`, typed error `E`,
required services `R`.

```ts
import { Effect, Exit } from "effect"

const double = (n: number) => Effect.succeed(n * 2)

const program = Effect.gen(function* () {
  const a = yield* Effect.succeed(1)
  const b = yield* double(a)
  yield* Effect.log(`result: ${b}`)
  return b
})

// Entry-point conversion — only at the outermost layer (tool handlers):
const p: Promise<number> = Effect.runPromise(program)          // rejects on failure/defect
const pe: Promise<Exit.Exit<number, never>> = Effect.runPromiseExit(program) // never rejects
const s: number = Effect.runSync(program)                       // throws if async
const fiber = Effect.runFork(program)                           // fire-and-forget fiber
```

`runPromise` only accepts `Effect<A, E, never>` — all services must be provided first
(or use a `ManagedRuntime`, §8). `runPromiseExit` is the right choice inside tool
handlers when you want to convert failures to structured results instead of throws.

`Effect.fn` gives you named, traced effect functions (nice stack traces):

```ts
const spawnJob = Effect.fn("spawnJob")(function* (name: string) {
  yield* Effect.log(`spawning ${name}`)
  return name
})
// spawnJob("x") : Effect<string>
```

## 2. Services & Layers

`Context.Tag` and the v3 `Effect.Service` helper class are **both gone**. The single
API is `Context.Service`, in two forms:

```ts
import { Context, Effect, Layer } from "effect"

// Class-style (recommended — class value doubles as the key):
class Clock extends Context.Service<Clock, {
  readonly now: Effect.Effect<number>
}>()("app/Clock") {}

// Function-style key:
const Random = Context.Service<{ next: Effect.Effect<number> }>("app/Random")

// Yielding the key retrieves the service (keys are Effects):
const use = Effect.gen(function* () {
  const clock = yield* Clock
  return yield* clock.now
})
```

Layers work like v3 (`Layer.scoped` merged into `Layer.effect` — every `Layer.effect`
build can use scoped resources):

```ts
const ClockLive = Layer.succeed(Clock, { now: Effect.sync(() => Date.now()) })

const RandomLive = Layer.effect(
  Random,
  Effect.gen(function* () {
    yield* Effect.log("building Random")
    return { next: Effect.sync(() => Math.random()) }
  })
)

// Dependencies between layers:
class Ids extends Context.Service<Ids, { readonly nextId: Effect.Effect<string> }>()("app/Ids") {}

const IdsLive = Layer.effect(
  Ids,
  Effect.gen(function* () {
    const random = yield* Random
    return Ids.of({ nextId: Effect.map(random.next, (n) => `id-${n}`) })
  })
)

const AppLayer = Layer.mergeAll(ClockLive, IdsLive.pipe(Layer.provide(RandomLive)))

const runnable = use.pipe(Effect.provide(AppLayer)) // R = never

// One-off service injection without a layer:
const withTestClock = use.pipe(Effect.provideService(Clock, { now: Effect.succeed(0) }))
```

Also useful:

- `Context.Reference("key", { defaultValue: () => ... })` — a service **with a default**
  (this replaces `FiberRef`); no layer needed, override with `Effect.provideService`.
- **Layer memoization changed:** layers are memoized *globally across separate
  `Effect.provide` calls* by default in v4 (per-runtime MemoMap), so providing the same
  layer to two effects builds it once.

## 3. Error handling

`Data.TaggedError` survives unchanged; `Schema.TaggedError` is now
`Schema.TaggedErrorClass`. Errors are yieldable directly.

```ts
import { Data, Effect, Schema } from "effect"

class SpawnError extends Data.TaggedError("SpawnError")<{
  readonly command: string
  readonly cause: unknown
}> {}

class TimeoutError extends Data.TaggedError("TimeoutError")<{ readonly ms: number }> {}

// Schema-validated variant:
class NotFound extends Schema.TaggedErrorClass<NotFound>()("NotFound", {
  id: Schema.Number
}) {}

const risky: Effect.Effect<string, SpawnError | TimeoutError> = Effect.gen(function* () {
  if (somethingBad) return yield* new SpawnError({ command: "codex", cause: "enoent" })
  return "ok"
})

// catchTag narrows the error union:
const handled: Effect.Effect<string, TimeoutError> = risky.pipe(
  Effect.catchTag("SpawnError", (e) => Effect.succeed(`spawn failed: ${e.command}`))
)

const handledAll: Effect.Effect<string> = risky.pipe(
  Effect.catchTags({
    SpawnError: (e) => Effect.succeed(`spawn: ${e.command}`),
    TimeoutError: (e) => Effect.succeed(`timeout ${e.ms}ms`)
  })
)
```

Renames: `catchAll` → `Effect.catch`, `catchAllCause` → `catchCause`,
`catchAllDefect` → `catchDefect`, `tapErrorCause` → `tapCause`, `Effect.either` →
`Effect.result` (returns `Result`, the renamed `Either`). `Effect.match`,
`Effect.exit`, `Effect.orDie`, `Effect.mapError`, `Effect.tapError` all still exist.
The `Cause` data structure was **flattened** (no nested `Sequential`/`Parallel` trees;
a cause is now a flat list of failures — simpler to render in job status output).

## 4. Promise / async / callback interop

```ts
import { Cause, Data, Effect } from "effect"

// Promise that "can't" reject — rejection becomes a defect:
const a = Effect.promise(() => Promise.resolve(42))

// Promise that may reject — default error type is Cause.UnknownError (v3: UnknownException):
const b = Effect.tryPromise((signal) => fetch("https://x", { signal }))

// Typed error:
class HttpError extends Data.TaggedError("HttpError")<{ cause: unknown }> {}
const c = Effect.tryPromise({
  try: (signal) => fetch("https://x", { signal }),
  catch: (cause) => new HttpError({ cause })
})
```

Both forms receive an `AbortSignal` that fires on fiber interruption — pass it to SDKs
(claude SDK, fetch, etc.) so interrupting a subagent fiber cancels the underlying call.

Callback APIs — `Effect.async` is now **`Effect.callback`**:

```ts
// signature: Effect.callback<A, E, R>((resume, signal) => void | cleanupEffect)
const waitForExit = (child: import("node:child_process").ChildProcess) =>
  Effect.callback<number>((resume) => {
    child.once("exit", (code) => resume(Effect.succeed(code ?? -1)))
  })

// cleanup on interruption via the AbortSignal:
const sleepy = Effect.callback<number>((resume, signal) => {
  const t = setTimeout(() => resume(Effect.succeed(1)), 1000)
  signal.addEventListener("abort", () => clearTimeout(t))
})
```

## 5. Scopes & resource management

Same shape as v3. Relevant rename: `Scope.extend` → `Scope.provide`.

```ts
import { Effect, Exit, Scope } from "effect"

const managedProc = Effect.acquireRelease(
  acquireEffect,                            // acquire (uninterruptible)
  (proc, exit) => Effect.sync(() => proc.kill()) // release, gets the Exit
)

// Scoped region: release runs when the region ends
const useIt = Effect.scoped(
  Effect.gen(function* () {
    const proc = yield* managedProc
    return proc.pid
  })
)

// addFinalizer:
Effect.scoped(Effect.gen(function* () {
  yield* Effect.addFinalizer((exit) => Effect.log(`closing, ok=${Exit.isSuccess(exit)}`))
}))
```

**Key pattern for background subagents** — a manually-controlled scope so the process
outlives the spawning tool call, and killing the job = closing the scope:

```ts
const startJob = Effect.gen(function* () {
  const scope = yield* Scope.make()
  const handle = yield* Scope.provide(managedProc, scope) // resource lives in `scope`
  // store `scope` in your job registry; later, from any fiber:
  // yield* Scope.close(scope, Exit.void)   // runs finalizers -> kills process
  return { handle, scope }
})
```

`Effect.acquireUseRelease(acquire, use, release)` for one-shot bracketing.

## 6. Child processes & FileSystem (the important part)

The v3 `@effect/platform` `Command`/`CommandExecutor` modules were redesigned into
**`effect/unstable/process`** with `ChildProcess` (command builder) and
`ChildProcessSpawner` (the service). The Node implementation comes from
`@effect/platform-node`.

Import gotcha: `import { ChildProcessSpawner } from "effect/unstable/process"` gives you
the **module namespace**, not the service class. Import the class from the submodule:

```ts
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { NodeServices, NodeFileSystem } from "@effect/platform-node"
```

`NodeServices.layer` provides everything at once:
`ChildProcessSpawner | Crypto | FileSystem | Path | Stdio | Terminal`.

### Building commands

```ts
// Template literal form:
const cmd1 = ChildProcess.make`echo hello`
// Options + template:
const cmd2 = ChildProcess.make({ cwd: "/tmp" })`ls -la`
// Array form (best for dynamic args — no shell parsing):
const cmd = ChildProcess.make("codex", ["exec", "--json", prompt], {
  cwd: workDir,
  env: { CODEX_API_KEY: key },   // merged over process.env when extendEnv: true
  extendEnv: true,
  stdin: "pipe",                 // "pipe" | "inherit" | "ignore" | a Stream<Uint8Array>
  stdout: "pipe",                // "pipe" | "inherit" | "ignore" | a Sink
  stderr: "pipe"
})
// pipelines: cmdA.pipe(ChildProcess.pipeTo(cmdB, { from: "stderr" }))
// modifiers: ChildProcess.setCwd, ChildProcess.setEnv, ChildProcess.prefix
```

Note `detached` defaults to **true on non-Windows** — the child gets its own process
group (good: killing it kills the group).

### Running: two styles

**Style A — via the spawner service (simple, non-interactive):**

```ts
const simple = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner
  const text  = yield* spawner.string(cmd)                    // full stdout as string
  const lines = yield* spawner.lines(cmd)                     // string[]
  const code  = yield* spawner.exitCode(cmd)                  // ExitCode (branded number)
  const lineStream = spawner.streamLines(cmd, { includeStderr: true }) // Stream<string>
})
```

**Style B — the Command IS an Effect.** Yielding a command spawns it and returns a
`ChildProcessHandle`, with the process lifetime tied to the ambient `Scope`
(`Command extends Effect<ChildProcessHandle, PlatformError, ChildProcessSpawner | Scope>`):

```ts
import { Effect, Stream } from "effect"

const streaming = Effect.scoped(
  Effect.gen(function* () {
    const handle = yield* cmd                 // <-- spawns; killed when scope closes
    handle.pid                                // ProcessId (branded number)

    // stdout is Stream<Uint8Array, PlatformError>; decode + split lines:
    yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => Effect.log(`out: ${line}`))
    )

    // stdin is a Sink<void, Uint8Array>; write by running a stream into it:
    yield* Stream.fromArray([new TextEncoder().encode("hello\n")]).pipe(
      Stream.run(handle.stdin)
    )

    // handle.stderr, handle.all (stdout+stderr interleaved) also available
    const code = yield* handle.exitCode       // waits for exit
    const running = yield* handle.isRunning
    yield* handle.kill({ killSignal: "SIGTERM", forceKillAfter: "5 seconds" })
    return code
  })
)
```

Verified at runtime: interrupting a fiber that spawned a process inside its scope
(e.g. `Fiber.interrupt` on a fiber running `Effect.scoped(...)` around `sleep 30`)
kills the child process. This is the backbone of subagent cancellation.

There's also `handle.unref` for letting the parent exit independently, and
`additionalFds` for extra file descriptor channels (fd3+).

### FileSystem / Path (now core)

```ts
import { Effect, FileSystem, Path } from "effect"

const files = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const content = yield* fs.readFileString("/tmp/in.txt")
  yield* fs.writeFileString(path.join("/tmp", "out.txt"), content)
})
// provide NodeFileSystem.layer, or NodeServices.layer for everything
```

## 7. Concurrency toolbox for a job manager

All verified compiling + running:

```ts
import {
  Cause, Deferred, Effect, Fiber, FiberMap, PubSub, Queue, Ref, Stream, Exit
} from "effect"

const forking = Effect.gen(function* () {
  const f1 = yield* Effect.forkChild(work)   // v3 fork  — dies with parent
  const f2 = yield* Effect.forkScoped(work)  // tied to ambient Scope
  const f3 = yield* Effect.forkDetach(work)  // v3 forkDaemon — outlives parent ✅ for background jobs
  // all fork variants accept { startImmediately?: boolean, uninterruptible?: boolean | "inherit" }

  const r: number = yield* Fiber.join(f1)                  // propagates failure
  const exit: Exit.Exit<number> = yield* Fiber.await(f3)   // failure as data
  yield* Fiber.interrupt(f2)
  // fiber.pollUnsafe() -> Exit | undefined for sync status checks
})
```

**Deferred** — one-shot completion signal (job finished):

```ts
const done = yield* Deferred.make<Result, JobError>()
yield* Effect.forkDetach(job.pipe(Effect.exit, Effect.flatMap((e) => Deferred.done(done, e))))
const result = yield* Deferred.await(done)   // keeps Node process alive in v4, no runMain needed
```

**Ref** — shared job-table state: `Ref.make({})`, `Ref.update`, `Ref.get`, `Ref.set`.
(`SynchronizedRef` for effectful updates.)

**Queue** — absorbed v3's `Mailbox`: it can be ended/failed, and converts to a Stream.
To use `Queue.end`, the error type must include `Cause.Done`:

```ts
const q = yield* Queue.make<string, Cause.Done>()   // capacity/strategy via options
yield* Queue.offer(q, "line")
yield* Queue.offerAll(q, ["a", "b"])
yield* Queue.end(q)                                 // signal "no more items"
const asStream = Stream.fromQueue(q)                // ends when queue ends
// Queue.take / takeAll / takeN / poll for direct consumption
```

**PubSub** — broadcast (e.g. multiple watchers of one job's output):

```ts
const ps = yield* PubSub.unbounded<string>()
const sub = yield* PubSub.subscribe(ps)      // scoped acquisition
yield* PubSub.publish(ps, "event")
const msg = yield* PubSub.take(sub)          // function call, not sub.take
// Stream.fromPubSub(ps) for stream consumption
```

**FiberMap / FiberSet / FiberHandle** — keyed fiber registries, ideal for a subagent
manager (auto-interrupts everything when its scope closes; adding under an existing key
interrupts the old fiber):

```ts
const jobsDemo = Effect.scoped(Effect.gen(function* () {
  const jobs = yield* FiberMap.make<string>()          // FiberMap<string> (keys)
  yield* FiberMap.run(jobs, "job-1", work)             // fork into the map
  const fiber = yield* FiberMap.get(jobs, "job-1")
  yield* FiberMap.remove(jobs, "job-1")                // interrupts it
}))
```

**Stream** essentials for process output: `Stream.decodeText()`, `Stream.splitLines`,
`Stream.runForEach`, `Stream.runCollect`, `Stream.run(sink)`, `Stream.fromQueue`,
`Stream.fromPubSub`, `Stream.toAsyncIterable`, `Stream.callback` (v3 `Stream.async`),
`Stream.fromArray` (v3 `fromChunk` — v4 uses plain arrays, Chunk is de-emphasized).
Also `Stream.mkString` to collect into one string.

Combinators: `Effect.all([...], { concurrency: n })`, `Effect.race`,
`Effect.timeout("5 seconds")` (fails with `Cause.TimeoutError`, tag `"TimeoutError"`),
`Semaphore.make(n)` (moved out of `Effect.makeSemaphore`), `Latch.make()`.

## 8. ManagedRuntime — the entry-point pattern for the extension

v3's `Runtime.runPromise(runtime)(effect)` API is gone; `effect/Runtime` now only holds
`runMain` plumbing. **`ManagedRuntime` is the way** to share layers across async entry
points:

```ts
import { Context, Effect, Layer, ManagedRuntime } from "effect"
import { NodeServices } from "@effect/platform-node"

class JobStore extends Context.Service<JobStore, {
  readonly list: Effect.Effect<Array<string>>
}>()("app/JobStore") {}

const JobStoreLive = Layer.sync(JobStore, () => ({ list: Effect.succeed([]) }))

const AppLayer = Layer.mergeAll(JobStoreLive, NodeServices.layer)

// Build ONCE at extension activation. Layers are built lazily on first run.
const runtime = ManagedRuntime.make(AppLayer)

// pi tool handler — the only place we touch Promises:
export async function handleToolCall() {
  return await runtime.runPromise(
    Effect.gen(function* () {
      const store = yield* JobStore
      return yield* store.list
    })
  )
}

// fire-and-forget background work from a sync/async context:
const fiber = runtime.runFork(backgroundEffect)

// extension deactivation — closes the runtime scope, runs ALL finalizers
// (i.e. kills any still-scoped child processes):
export async function shutdown() {
  await runtime.dispose()
}
```

`ManagedRuntime` also exposes `runSync`, `runSyncExit`, `runPromiseExit`, `runCallback`,
a `memoMap` (share layer memoization between multiple runtimes), and `.scope`.
Prefer `runPromiseExit` in tool handlers if you want to map typed failures to
tool-result errors instead of catching thrown `Cause` wrappers.

---

## Architecture sketch for subagents

```
ManagedRuntime.make(Layer.mergeAll(NodeServices.layer, SubagentManagerLive))
        │  built once at extension init; dispose() on shutdown
        ▼
SubagentManager service (Context.Service):
  - Ref<HashMap<JobId, JobEntry>>            job table
  - start(cmd):  Scope.make() → Scope.provide(ChildProcess handle, scope)
                 → Effect.forkDetach(pump stdout → Queue<string, Cause.Done>)
                 → Deferred<ExitCode> completed on exit
  - status(id):  Deferred.isDone / handle.isRunning / Ref lookup
  - output(id):  drain Queue (takeAll) or Stream.fromQueue for tailing
  - kill(id):    Scope.close(scope, Exit.void)  → finalizer kills the process
Tool handlers: async fns calling runtime.runPromise(Effect.gen(...))
```

## Surprises & gotchas (learned the hard way)

1. **`effect/unstable/process` exports module namespaces.** The
   `ChildProcessSpawner` class must be imported from
   `"effect/unstable/process/ChildProcessSpawner"` (or use
   `ChildProcessSpawner.ChildProcessSpawner` off the namespace).
2. **`Effect.fork` does not exist** — code (or an LLM) writing v3-style `Effect.fork`
   fails to compile. Use `forkChild` / `forkScoped` / `forkDetach` / `forkIn`.
3. **`Queue.end` needs `Cause.Done` in the queue's error type** —
   `Queue.make<A>()` defaults to `E = never` and won't accept `end`.
4. **Early-beta content mentioning `ServiceMap` is stale** — it was renamed back to
   `Context` during the beta. Similarly, some AI-generated content mentions APIs that
   never shipped.
5. **`Either` is `Result`**, `Effect.either` is `Effect.result`.
6. **`Data.TaggedError` errors are yieldable** — `yield* new SpawnError({...})` fails
   the effect directly, no `Effect.fail` wrapper needed (works in v3 too, but idiomatic
   in v4 docs).
7. **Chunk → Array**: stream element groups are plain arrays (`Stream.fromArray`,
   `runCollect` returns `Array<A>`), not `Chunk`.
8. `tryPromise` default error is `Cause.UnknownError` (was `UnknownException`).
9. `unstable/*` modules can break between v4 minors — pin exact versions
   (`4.0.0-beta.98`) and keep `effect` and `@effect/platform-node` in lockstep.
10. Scratch workspace with all verified test files: `/tmp/effect-v4-scratch`
    (`test1-basics.ts` … `test8-runtime.ts`, `smoke.mts` executed successfully).

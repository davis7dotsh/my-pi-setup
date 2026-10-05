# Effect 4 notes for the subagents extension

These notes describe the stable Effect APIs used by this extension. They are verified against `effect@4.0.0`. Exact signatures should be checked in `node_modules/effect/src` before introducing an unfamiliar API.

## Modules in use

The extension imports from the main `effect` package:

- `Cause`
- `Context`
- `Data`
- `Duration`
- `Effect`
- `Exit`
- `Fiber`
- `Layer`
- `ManagedRuntime`
- `Queue`
- `Ref`
- `Scope`
- `Stream`

No separate Effect platform package is required by the current implementation. Node file-system and process integration stays at explicit Node SDK boundaries.

## Service definition

```ts
class BackendRegistry extends Context.Service<
  BackendRegistry,
  ReadonlyMap<BackendName, SubagentBackend>
>()("subagents/BackendRegistry") {}
```

Provide implementations with `Layer.sync`, `Layer.effect`, or another layer constructor. Build the application layer once rather than repeatedly providing services to individual operations.

## Managed runtime

`ManagedRuntime.make(layer)` owns the extension's Effect services. Pi tool and command handlers call `runtime.runPromise(effect)` at the async boundary. `runtime.dispose()` releases the layer and all manager-owned scopes.

The runtime is lazy in `index.ts` because Pi can load an extension without starting a session. It is disposed from `session_shutdown` and recreated after reload.

## Typed failures

Domain failures use tagged data errors:

```ts
class SendError extends Data.TaggedError("SendError")<{
  readonly message: string;
}> {}
```

Use `Effect.try` and `Effect.tryPromise` to translate expected synchronous and asynchronous failures. Keep error messages bounded before storing or rendering them.

## Scopes and finalizers

Backend `spawn` effects require `Scope.Scope`. The manager creates a child scope for each subagent and closes it when the subagent is removed, cancelled beyond its interrupt bound, or the runtime is disposed.

Register finalizers as soon as a resource is successfully acquired. A resource that fails before finalizer registration must clean itself up in the acquisition branch.

Finalizers must:

- tolerate repeated calls;
- stop accepting new work;
- abort active work;
- close queues and streams;
- release SDK sessions or child processes;
- avoid replacing the original operation result with cleanup failures.

## Queue-backed event streams

Each backend translates native events into `SubagentEvent` values:

```ts
const queue = yield* Queue.make<SubagentEvent, Cause.Done>();
const events = Stream.fromQueue(queue);
```

Producers use `Queue.offerUnsafe` only where the queue lifetime is already controlled by the scoped backend. Finalizers call `Queue.endUnsafe` after the producer has stopped.

## Fibers

The manager forks event consumers and cleanup tasks with the manager's services and scope. Track detached cleanup fibers so runtime disposal can interrupt or await them.

Prefer structured concurrency. A detached fiber is justified only when the caller must return while cleanup continues independently, and the runtime still owns that fiber.

## Interruption

`runTool` races a tool effect against Pi's `AbortSignal`. The interrupt message becomes a typed domain error at the promise boundary.

Interruption semantics differ by operation:

- spawn interruption releases any partially created session;
- wait interruption stops waiting but leaves children running;
- cancel interruption stops waiting for cancellation, while backend teardown remains manager-owned;
- runtime disposal interrupts all owned work and closes child scopes.

## Duration and time bounds

Use `Duration` with Effect timeout operators for Effect-native work. Native SDK calls that already expose promises may use a small promise race helper when the cleanup must continue outside the interrupted caller.

Every external interrupt or shutdown handshake has a finite bound. A backend that does not acknowledge cancellation is force-disposed so the manager cannot remain permanently occupied.

## State

The manager owns mutable session state. Effect primitives coordinate asynchronous ownership, while the synchronous `SubagentReadModel` exposes immutable snapshots to Pi's render path.

Do not mutate snapshots from UI code. Manager updates notify subscribers after the state transition so the TUI reads a coherent view.

## Stream consumption

Consume each backend event stream exactly once. The manager is responsible for applying events in order, updating the snapshot, settling the run once, and invoking the settlement hook.

A terminal event is idempotent: native lifecycle events, prompt rejection, interruption fallback, and process exit can race, but only the first settlement changes the run.

## Stable verification commands

```bash
npm install --ignore-scripts
npm run check
npm test
```

The default tests are deterministic. Live provider tests are documented separately in `../README.md` and require explicit opt-in.

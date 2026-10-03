# Building this Pi extension with Effect 4

This extension is verified with:

- `effect@4.0.0`
- `@effect/tsgo@0.48.0`
- `typescript@7.0.2`
- Pi packages at `1.0.0`

Use the installed source under `node_modules/effect/src` as the authority for exact Effect 4 signatures.

## Package setup

The runtime dependency is pinned to stable Effect 4:

```json
{
  "dependencies": {
    "effect": "4.0.0"
  },
  "devDependencies": {
    "@effect/tsgo": "0.48.0",
    "typescript": "^7.0.2"
  }
}
```

Pi packages are host-provided peers. They are also pinned as development dependencies in this directory so isolated checks resolve Pi `1.0.0` without relying on an ancestor installation.

Run installation without lifecycle scripts, then typecheck explicitly:

```bash
npm install --ignore-scripts
npm run check
```

## Boundary rule

Keep the Effect graph inside the backend and manager layers. Convert to promises only at Pi's async extension boundary:

```ts
const manager = await runtime.runPromise(SubagentManager);
const snapshot = await runTool(runtime, manager.spawn(harness, task), {
  signal,
  interruptMessage: "Subagent spawn aborted.",
});
```

Pure formatting, schema construction, rendering, and small synchronous lookups remain plain TypeScript.

## Services and layers

Define services with `Context.Service` and construct implementations with `Layer`:

```ts
class BackendRegistry extends Context.Service<
  BackendRegistry,
  ReadonlyMap<BackendName, SubagentBackend>
>()("subagents/BackendRegistry") {}

const BackendRegistryLive = Layer.sync(BackendRegistry, () => backends);
```

Compose the live layer once and create one `ManagedRuntime` for the extension session. Dispose it during `session_shutdown`.

## Errors as values

Backend operations expose typed errors in the Effect error channel. Use tagged Effect data errors for local domain failures:

```ts
class SpawnError extends Data.TaggedError("SpawnError")<{
  readonly message: string;
}> {}
```

Translate rejected promises at the integration boundary:

```ts
Effect.tryPromise({
  try: () => startExternalSession(),
  catch: (error) => new SpawnError({ message: boundedError(error) }),
});
```

Unexpected programmer errors may remain defects. User-visible spawn, send, cancellation, and capacity failures should stay typed.

## Resource ownership

Acquire backend sessions inside a scope and register cleanup immediately after acquisition:

```ts
const session = yield* openSession(task);

yield* Effect.addFinalizer(() =>
  Effect.promise(async () => {
    await stopSession(session);
  }),
);
```

Cleanup must be idempotent. Session shutdown, cancellation, process exit, and runtime disposal can converge on the same resource.

## Concurrency and cancellation

- Use scoped fibers for manager-owned background work.
- Pass Pi's `AbortSignal` into `runTool` at tool boundaries.
- Interrupting a wait must not silently terminate the child unless the operation is cancellation.
- Bound backend interrupt and shutdown handshakes; force-release resources after the bound.
- Never start child processes or long-lived work in the extension factory.

## Queues and streams

Backends normalize native events through an Effect queue and expose a stream:

```ts
const events = yield* Queue.make<SubagentEvent, Cause.Done>();
const stream = Stream.fromQueue(events);
```

End the queue during finalization. Keep native SDK and protocol message shapes inside the backend adapter so the manager and UI consume one domain event union.

## Testing

The default suite uses scripted stub backends and pure parser tests. It must be deterministic and credential-free:

```bash
npm test
```

Credential-dependent Claude and Codex tests require explicit opt-in. See `../README.md`; do not add them to ordinary CI runs.

## Upgrade checklist

- Pin the requested stable Effect version.
- Keep all installed Effect tooling on the tested compatible versions.
- Install with `npm install --ignore-scripts`.
- Inspect changed APIs in `node_modules/effect/src`.
- Run `npm run check` and `npm test`.
- Verify cleanup on success, failure, interruption, and runtime disposal.
- Keep live provider tests opt-in.

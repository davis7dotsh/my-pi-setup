# Background terminals

This extension starts and manages long-running, non-interactive shell commands for Pi 1.0.0.

## Behavior

- `bg_start` starts a command with stdin closed and returns a terminal id immediately.
- `bg_status` returns the current state and tail-truncated stdout and stderr.
- `bg_list` lists running and settled terminals.
- `bg_kill` stops complete process trees with graceful termination followed by forced termination when needed.
- `/ps` opens an interactive terminal picker and output viewer in TUI mode.
- Running-process status is also exposed as a compact widget. RPC clients receive plain widget lines; TUI clients receive a themed component.
- A settled terminal sends one follow-up message unless a status or kill call already consumed that result.

## Lifecycle

The extension creates one lazy `ManagedRuntime` per Pi session. `TerminalManager` owns process scopes, output capture, subscriptions, and cleanup.

Long-lived resources start only when a tool or command first needs the manager. On `session_shutdown`, the extension:

1. stops result delivery and UI subscriptions;
2. clears its widget;
3. disposes the runtime;
4. terminates remaining process trees;
5. flushes and removes session-scoped spill files.

Cleanup is idempotent and bounded so reloads and session replacement cannot hang indefinitely.

## Output handling

Each process has independent stdout and stderr buffers.

- In-memory output keeps a bounded tail for tools and the TUI.
- Larger output spills to owner-only temporary files with a per-stream safety limit.
- Model-facing responses use Pi's truncation helpers and point to a full log only while that session-owned file exists.
- Raw process output is sanitized only when rendered so captured logs remain faithful while terminal control sequences cannot affect Pi's UI.

Do not treat process output as safe terminal markup. It may contain repository-controlled text, ANSI sequences, or credentials printed by the command itself.

## Package boundaries

Runtime dependencies imported from the extension are declared locally:

- `effect@4.0.0`

Pi-provided packages are peer dependencies and must not be bundled:

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `typebox`

Development uses TypeScript 7 and the aligned Effect TypeScript tooling declared in `package.json`.

## Verification

Run from `extensions/background-terminals`:

```sh
npm install --ignore-scripts
npm run check
npm test
```

The test suite covers process settlement, process-tree termination, kill races, runtime disposal, output bounds and spilling, result delivery, prompt formatting, sanitization, wrapping, and dashboard selection.

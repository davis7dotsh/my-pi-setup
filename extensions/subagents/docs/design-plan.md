# Subagents extension architecture

## Purpose

The extension lets the parent Pi session delegate self-contained background work to one of three backends:

- Pi through an in-process SDK session
- Claude Code through the Claude Agent SDK
- Codex through a scoped app-server process

All backends implement one Effect service interface and emit one normalized event model. The parent sees the same spawn, wait, check, cancel, list, and takeover behavior regardless of backend.

## User-facing behavior

### Model-facing tools

- `subagent_spawn` starts a child and returns immediately.
- `subagent_wait` waits for selected model-origin children and returns bounded results.
- `subagent_cancel` interrupts selected children and waits for settlement.
- `subagent_check` returns recent activity for one child.
- `subagent_list` summarizes tracked model-origin children.

At most four children run at once across all backends.

### Interactive commands

- `/subagents` opens the picker and takeover view.
- `/btw` starts a Pi side session whose result is visible to the user but excluded from model-facing tools and context.

Interactive takeover is TUI-only. Tool execution remains available in non-interactive Pi modes.

## Domain model

`src/domain.ts` defines:

- backend names and capabilities;
- spawn input and inherited parent context;
- normalized transcript parts and backend events;
- snapshots used by tools and UI;
- typed manager and backend errors.

A backend emits lifecycle, assistant, tool, usage, metadata, and queue events. The manager applies them in order and exposes immutable snapshots through a synchronous read model.

## Backend contract

Each `SubagentBackend` provides:

- `available`: a cheap Effect capability check;
- `spawn`: a scoped acquisition returning a `SubagentSession`;
- capability flags for steering, model selection, and reasoning effort.

Each `SubagentSession` provides:

- current metadata;
- a normalized event stream;
- `send` for another turn or steering;
- `interrupt` for the active run.

Backend-specific SDK and protocol shapes do not escape their adapter.

## Pi backend

The Pi backend:

- creates an `AgentSession` with `createAgentSession`;
- uses a persistent `SessionManager` for the child working directory;
- loads resources through `DefaultResourceLoader` and `SettingsManager`;
- applies project trust independently for an alternate child directory;
- excludes orchestration and user-interaction tools from headless children;
- binds extensions in print mode;
- translates `AgentSessionEvent` values into normalized events;
- inherits the parent model and thinking level when no explicit hint is supplied;
- aborts and disposes the session during scoped cleanup.

The backend waits for `agent_settled`, not only `agent_end`, because Pi can continue automatically after a low-level run.

## Claude backend

The Claude backend:

- uses streaming-input mode from the Claude Agent SDK;
- keeps one SDK query for a persistent child conversation;
- disables the SDK's native subagent tools so all child orchestration remains under this extension's global cap;
- translates assistant, user, tool, result, metadata, and usage messages;
- records the backend-provided model and session metadata;
- interrupts through the SDK and abort controller;
- inherits the configured Claude default model unless the caller provides a hint.

The extension does not embed credentials or endpoints. The installed Claude tooling owns authentication and configuration.

## Codex backend

The Codex backend:

- resolves the Codex executable from `PATH`;
- starts one app-server process per scoped child session;
- communicates through line-delimited JSON-RPC;
- initializes a thread, starts turns, and translates notifications;
- queries model capabilities only when a reasoning effort needs clamping;
- tracks the backend-reported model, token usage, context window, thread id, and rollout path;
- interrupts the active turn and force-terminates an unresponsive process during cleanup;
- inherits the configured Codex default model unless the caller provides a hint.

The extension does not embed credentials or endpoints. The installed Codex tooling owns authentication and configuration.

## Manager

`src/manager.ts` owns:

- the global concurrency cap;
- one scope and event-consumer fiber per child;
- snapshot transitions;
- one terminal settlement per run;
- wait consumption and deferred result delivery;
- cancellation and bounded cleanup;
- pruning of settled entries;
- read-model subscriptions for the TUI.

Model-origin ids and `/btw` ids use separate counters so user side sessions never appear in model-facing tools.

## Result delivery

A model-origin result has two collection paths:

- `subagent_wait` consumes and returns it directly;
- otherwise, the extension defers it until the parent reaches `agent_settled`, then sends a follow-up custom message.

A later wait can consume a deferred result before it is delivered. `/btw` results use `appendEntry`, so they are persisted and rendered without entering model context.

All model-facing output is byte- and line-bounded. Truncated output points to the backend session file when one is available.

## UI

The takeover UI reads snapshots synchronously and never owns backend resources. It renders:

- backend, model label, status, elapsed time, and context utilization;
- finalized transcript parts;
- streaming assistant text and thinking;
- live tool activity;
- queued steering and follow-up messages.

Rendering uses Pi TUI width helpers and sanitizes terminal control characters from backend output.

## Lifecycle

The extension factory only registers behavior. It does not start processes, timers, or sessions.

The Effect runtime is created lazily on first use. `session_shutdown` clears deferred delivery, removes UI status, disposes the runtime, and releases all child scopes. Cleanup is idempotent because reload, cancellation, process exit, and normal shutdown can overlap.

## Dependencies

The extension targets:

- Pi `1.0.0`
- Effect `4.0.0`
- the pinned stable Claude Agent SDK version in `package.json`

Pi libraries and `typebox` are host-provided peers. Development pins make this directory independently typecheckable.

## Verification

Deterministic verification:

```bash
npm install --ignore-scripts
npm run check
npm test
```

Credential-dependent Claude and Codex tests require explicit opt-in and are documented in `../README.md`.

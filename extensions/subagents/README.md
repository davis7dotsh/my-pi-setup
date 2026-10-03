# Subagents extension

This Pi extension runs background subagents through three backends:

- `pi`: an in-process Pi SDK session
- `claude`: the Claude Agent SDK and Claude Code
- `codex`: a scoped Codex app-server process

It exposes model-facing tools for spawning, waiting, checking, listing, and cancelling subagents. `/subagents` opens the interactive dashboard, and `/btw` starts a side question that stays out of the parent model context.

## Requirements

- Pi `1.0.0`
- Effect `4.0.0`
- Node.js 24 for this repository's TypeScript test runner
- Claude Code or Codex only when using the corresponding external backend

The Pi packages and `typebox` are host-provided peer dependencies. This directory pins Pi `1.0.0` as development dependencies so its isolated typecheck does not depend on the repository root installation.

## Install and verify

Run commands from this directory:

```bash
npm install --ignore-scripts
npm run check
npm test
```

`npm test` is deterministic and does not make credential-dependent model calls. The Claude and Codex test files are included, but their live cases skip unless explicitly enabled.

## Live backend tests

Live tests can consume provider quota, require installed and authenticated CLIs, modify backend session state, and take substantially longer than deterministic tests. They are never enabled by the default test command.

Explicitly opt in with:

```bash
npm run test:live
```

That script sets `SUBAGENTS_LIVE_TESTS=1` only for the live Claude and Codex test files. The tests inherit each backend's configured default model; they do not name or select a model.

To run one live file directly, set the same variable yourself:

```bash
SUBAGENTS_LIVE_TESTS=1 node --test --experimental-strip-types claude.test.ts
SUBAGENTS_LIVE_TESTS=1 node --test --experimental-strip-types codex.test.ts
```

Do not enable live tests in ordinary CI. Use a dedicated credentialed job with an external timeout if live coverage is required.

## Model selection

Omit `model` to use the configured backend default. The Pi backend inherits the parent model when available. Explicit model hints are backend-specific and should only use models already configured for that backend.

## Lifecycle

- The extension creates its Effect runtime lazily.
- Backend resources are acquired in scopes and released during session shutdown.
- Pi child sessions load normal resources with project trust resolved for the child working directory.
- Headless children cannot call the subagent orchestration tools or user-interaction tools.
- Unconsumed model-origin results are delivered to the parent after it settles.
- `/btw` results are stored as non-context custom entries.

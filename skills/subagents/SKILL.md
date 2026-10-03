---
name: subagents
description: Use when the user asks you to delegate work to subagents.
---

# Subagents

Each subagent is headless, has its own context window, cannot see the parent conversation, cannot ask the user, and cannot spawn additional subagents. Give every child a self-contained prompt with paths, constraints, and the expected report.

## Choose a harness

- **Pi** (`pi`): the default. Inherits the parent model and thinking level when omitted. Select an available model with `pi --list-models` if an override is needed; prefer `provider/model-id`.
- **Claude Code** (`claude`): requires the Claude Code CLI to be installed and authenticated. Omit the model to use the CLI's configured default, or choose a publicly available model supported by the CLI.
- **Codex** (`codex`): requires the Codex CLI to be installed and authenticated. Omit the model to use the CLI's configured default, or choose a publicly available model supported by the CLI.

Choose deliberately based on the user's request and the task. Do not assume any particular provider or subscription is available.

## Spawn and manage

Call `subagent_spawn` with a complete `prompt`, short `name`, chosen `harness`, and optional `working_dir`, `model`, and `reasoning_effort`. At most four subagents run concurrently.

Reasoning effort accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; each harness maps these to its supported settings.

- `subagent_check({ id })`: inspect progress without blocking.
- `subagent_list()`: list all runs.
- `subagent_wait({ ids })`: block only when results are required to proceed.
- `subagent_cancel({ ids })`: stop runs while preserving partial transcripts.
- `/subagents`: inspect or take over a run interactively.

Results return automatically. After spawning, continue useful parent work instead of immediately waiting.

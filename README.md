# Pipi

Pipi is a ready-to-use, isolated Pi workspace for serious coding tasks. It combines focused agents, audited pipelines, browser tools, background terminals, workflows, repository search, and a polished terminal UI without changing your regular `pi` installation.

## Why use it

- **Less context switching.** Search, implementation, review, browser debugging, and long-running commands stay in one coding environment.
- **Predictable delegation.** Choose a focused agent or a fixed pipeline instead of manually coordinating a large prompt.
- **Safer automation.** Read-only roles, bounded tools, explicit commit permission, and deterministic checks keep authority narrow.
- **Clear progress.** `/pipelines` shows active stages, agents, attempts, and status at a glance.
- **Isolated setup.** Runtime, settings, sessions, and authentication live under `~/.pipi`; regular Pi remains untouched.

## What is included

### Agents

| Agent/profile | Best for |
| --- | --- |
| Pi subagent | General delegated work |
| `luna-explore` | Read-only repository exploration |
| `luna-worker` | Scoped implementation and testing |
| `terra-audit` | Manual deep review and escalation |
| Claude or Codex subagent | Tasks that benefit from another backend |

### Pipelines

| Pipeline | Use it when you need |
| --- | --- |
| `small-feature-pipeline` | One focused implementation, parallel review, and a fix pass |
| `feature-pipeline` | A broader feature with discovery, implementation, and multi-concern audit |
| `plan-pipeline` | A repository-grounded implementation plan instead of code |
| `audit-pipeline` | A read-only initial or closure audit with no remediation |

Run `/pipelines` to inspect progress. Press `Enter` to expand a run or open the agent responsible for a stage. Status colors make running, completed, and failed work easy to scan.

Example:

```json
{
  "pipeline": "small-feature-pipeline",
  "task": "Add CSV export with tests",
  "working_dir": "/repo"
}
```

`pipeline_run` defaults to `feature-pipeline` when `pipeline` is omitted. Feature runs require Linux bubblewrap, explicit `git_commit: true`, and a clean, attached, dedicated linked Git worktree (not the primary checkout). Five discovery tracks and one discovery synthesis prepare a shared package for three parallel isolated Luna/xHIGH candidates—Minimal, Robust, and Architectural—from the same base. One Luna/xHIGH synthesis agent compares committed candidates, selects exactly one primary before writing, optionally makes bounded primary-based improvements, verifies and commits the result, promotes that exact state to the caller worktree, and cleans only its temporary worktrees. Existing independent audit/remediation then evaluates the promoted result without candidate provenance. Controller-owned candidate/synthesis refs remain inspectable; pipelines never push, rewrite history, deploy, or mutate external delivery state.

Final audits in standalone, feature, and plan contexts use the executor's repository-declared verification contract: standalone/feature executors run the noninteractive repository-wide full test suite after useful focused checks, while targeted tests never substitute for it. If a safe full suite is unavailable or cannot run, the executor records exact evidence and an unproven check. Plan final audits retain their planning-only prohibition on product implementation tests. Only feature `discover-problem` and plan `discover-goal-outcomes` receive ordinary bash for read-only `gh` lookup of referenced GitHub context; all other discovery and audit roles retain their shell boundaries.

### Everyday tools

- `rg` content search and `fd` file discovery
- background terminals for servers, watchers, and long builds
- multi-agent workflows for phased or parallel tasks
- Chrome DevTools control in disposable headless or persistent headed modes
- deterministic Codex-backed web search, fetching, patching, and bounded tasks
- MCP support through an isolated `pi-mcp-adapter`
- ask-user, copy-all, session summaries, and Git/model status UI
- GitHub Dark Default theme

### Built-in skills

| Skill | Purpose |
| --- | --- |
| `code-review` | Evidence-driven initial and closure review |
| `plan-gh-backlog` | Validate and publish structured GitHub backlogs |
| `browser-chrome` | Choose and control the appropriate Chrome mode |
| `codex-tools` | Search, fetch, patch, and delegate Codex tasks |
| `background-terminals` | Run and monitor long-lived commands |
| `subagents` | Delegate focused work to child models |

## Isolation and safety

Pipi installs beside regular Pi and uses its own runtime, settings, sessions, MCP configuration, and authentication directory under `~/.pipi`. It does not copy regular Pi secrets. Authentication sharing is opt-in.

The installer pins and validates the bundled review, backlog, and Codex-tool submodules. Pipeline roles receive only the tools needed for their job, while commit authority is explicit and limited to the persistent implementation role.

When the [official Herdr](https://github.com/herdrdev/herdr) CLI is available, Pipi installs its official Pi integration so Pipi panes appear correctly in Herdr's Agents view.

## Setup

See [SETUP.md](SETUP.md) for installation, updates, authentication, MCP configuration, and uninstall instructions.

## Notes

Pipeline runs are session-scoped and are not resumed after shutdown or reload. `feature-pipeline` enforces its dedicated linked-worktree preflight and controller-owned temporary isolation; callers remain responsible for workspace policy for the other pipeline definitions.

For implementation details, contracts, and limits, see [Hardcoded pipelines design](docs/pipelines-v1-design.md).

Additional references:

- [Local setup record and pending steps](docs/pipi-setup-record.md)
- [Subagent graph](docs/subagents-explained.html)
- [Original subagent design reference](https://github.com/davis7dotsh/my-pi-setup/blob/main/extensions/subagents/docs/design-plan.md)

![Pipi interface](assets/pi-setup.jpeg)

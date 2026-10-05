# Pi setup

A portable collection of extensions, skills, and a GitHub Dark-inspired theme for [Pi](https://pi.dev).

- Background terminals with a process dashboard and completion notifications.
- Subagents using Pi, Claude Code, or Codex, with transcript views and cancellation.
- Multiple-choice questions through the `ask_user` tool.
- File discovery and content search with `fd` and `rg`.
- Web search, scraping, and crawling through Firecrawl.
- Git status, model usage, clipboard export, and terminal UI customization.
- Global OpenAI fast mode with `/fast`, `/fast on`, `/fast off`, and `/fast status`. The toggle is saved in `~/.pi/agent/openai-fast.json` (or `PI_CODING_AGENT_DIR`) and persists across threads and restarts.
  Uses the priority service tier (higher pricing may apply), defaults off, and
  keeps the toggle global across sessions, reloads, and branch navigation.

## Setup

Requires Node.js 24 or newer. This repository targets **Pi 1.0.0** and **Effect 4.0.0**.

See [SETUP.md](SETUP.md) for installation and optional integrations.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run format:check
```

The default test suite does not require model credentials. Live backend tests are opt-in; see the subagent documentation.

Only the portable extensions listed in `extensions/.gitignore` are versioned. Credentials, sessions, model configuration, caches, backups, and additional machine-specific extensions remain local. Do not add real credentials to examples or screenshots.

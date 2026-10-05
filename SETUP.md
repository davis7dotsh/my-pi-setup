# Setup

## Install

Install Node.js 24 or newer and Pi 1.0.0:

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.0.0
```

Clone this repository into a fresh directory, then install all extension dependencies using the root npm workspace lockfile:

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Keep the checkout separate from your personal configuration and register it as a local Pi package:

```sh
pi install .
```

The package manifest exports only the included portable extensions, skills, and theme. Pi does not install dependencies for a local package, so run `npm ci --ignore-scripts` first as shown above.

Alternatively, clone directly into `~/.pi/agent` if that directory does not exist, and install dependencies there. Do not overwrite an existing setup's credentials or settings. Restart Pi or use `/reload` after changes.

## Firecrawl

The web tools require a Firecrawl API key. Follow [Firecrawl's getting-started guide](https://docs.firecrawl.dev/quickstarts/nodejs), then copy the example environment file:

```sh
cp .env.example .env
```

Replace the placeholder with your API key. Keep `.env` untracked. If the checkout is separate from `~/.pi/agent`, put the key in `~/.pi/agent/.env` or export `FIRECRAWL_API_KEY` in the environment where Pi starts. Firecrawl is optional; disable or omit the extension if you do not need web tools.

## File search

The file-search extension exposes `fd` and `rg`. It uses installed binaries (`fdfind` is also supported), then checks `~/.pi/agent/bin/`, and otherwise downloads official release binaries over HTTPS for supported macOS/Linux arm64/x64 platforms. On unsupported platforms, install both tools with your package manager.

## Subagents

Pi subagents use the configured model and credentials. Claude Code and Codex backends require their respective CLIs to be installed and authenticated. No particular model or private endpoint is required.

Credential-dependent backend tests are separate from the default test suite. See the [subagent documentation](extensions/subagents/README.md) for opt-in test instructions.

## Theme

Merge this into `~/.pi/agent/settings.json` without replacing your existing settings:

```json
{
  "theme": "github-dark-default"
}
```

## Local configuration

Keep authentication, model/provider configuration, sessions, caches, backups, and additional machine-specific extensions out of Git. The extension allowlist in `extensions/.gitignore` prevents accidental inclusion of local integrations. To publish a new portable extension, explicitly add it to that allowlist and the root workspace list.

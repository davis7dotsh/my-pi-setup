# Advisor

A global pi extension that exposes an `advisor` tool. It sends a focused question to a separately configured model with no tools or session access, then returns its answer to the calling agent.

## Configure

In pi, run `/advisor` to open pi's searchable model selector (provider, model ID, and model name), or provide one directly:

```text
/advisor anthropic/claude-opus-4-5
```

`/advisor status` shows the current model and `/advisor reset` clears it. Configuration is stored in `~/.pi/agent/extensions/advisor.json`; it contains only the provider and model ID. Credentials continue to come from pi's normal auth configuration.

## Agent tool

Agents receive the `advisor` tool. They should use it only for a focused question when they are genuinely stuck, including the facts or code needed to reason about it in `context`.

The advisor receives only the question and optional context passed to the tool. It has no tools, filesystem, shell, network, or ability to make changes.

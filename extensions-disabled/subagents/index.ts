/**
 * Subagents - spawn background pi threads from the parent agent.
 *
 * Tools (for the parent LLM):
 * - subagent_spawn: fire-and-forget spawn (prompt, title, working_dir, model,
 *   provider, reasoning_effort). Max 4 running at once.
 * - subagent_wait: block until the listed subagents settle, return results.
 * - subagent_cancel: stop one or more running subagents.
 * - subagent_check: peek at a subagent's status and recent activity.
 * - subagent_list: list all subagents.
 *
 * Unawaited subagents queue their result as a follow-up message when they
 * settle. `/subagents` opens a picker + full interactive takeover view.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getMarkdownTheme,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { formatActivityStatus } from "../shared/activity-status.ts";
import { resolveStandaloneChildProjectTrust } from "../shared/child-session.ts";
import { formatContextUtilization } from "../shared/context-utilization.ts";
import {
  activeModel,
  contextUsage,
  finalOutput,
  formatElapsed,
  latestOutput,
  MAX_RUNNING,
  type Subagent,
  SubagentManager,
  type ThinkingLevel,
} from "./manager.ts";
import {
  buildSubagentResultMessage,
  buildSubagentSpawnResult,
  buildSubagentTaskPrompt,
  SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CANCEL_TOOL_DESCRIPTION,
  SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS,
  SUBAGENT_CHECK_TOOL_DESCRIPTION,
  SUBAGENT_LIST_TOOL_DESCRIPTION,
  SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
  SUBAGENT_SPAWN_PROMPT_SNIPPET,
  SUBAGENT_SPAWN_TOOL_DESCRIPTION,
  SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS,
  SUBAGENT_WAIT_TOOL_DESCRIPTION,
} from "./prompt.ts";
import { createDeferredResultDelivery } from "./result-delivery.ts";
import { openSubagentPicker } from "./takeover.ts";

const SUBAGENT_OUTPUT_MAX_BYTES = 24 * 1024;
const WAIT_OUTPUT_MAX_BYTES = 48 * 1024;
const WAIT_PER_AGENT_MAX_BYTES = 16 * 1024;

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

function describeSubagent(sub: Subagent): string {
  const model = activeModel(sub);
  const details = [
    model ? `${model.provider}/${model.id}` : "?",
    formatContextUtilization(contextUsage(sub)),
    formatElapsed(sub),
    sub.cwd,
  ].filter(Boolean);
  return `${sub.id} [${sub.status}] "${sub.title}" (${details.join(", ")})`;
}

function truncatedOutput(
  sub: Subagent,
  maxBytes = SUBAGENT_OUTPUT_MAX_BYTES,
): string {
  const output = finalOutput(sub) || "(no output)";
  const truncation = truncateHead(output, {
    maxBytes: Math.min(maxBytes, DEFAULT_MAX_BYTES),
    maxLines: Math.min(600, DEFAULT_MAX_LINES),
  });
  let text = truncation.content;
  if (truncation.truncated) {
    text += `\n\n[Output truncated: ${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)} shown. Full transcript in session file: ${sub.session.sessionFile ?? "?"}]`;
  }
  return text;
}

function resolveModel(
  ctx: ExtensionContext,
  provider: string | undefined,
  modelId: string | undefined,
): Model<any> {
  if (!provider && !modelId) {
    if (!ctx.model)
      throw new Error("No model is currently active to inherit from.");
    return ctx.model;
  }
  if (!modelId) {
    throw new Error(
      `Provider "${provider}" given without a model. Specify model too.`,
    );
  }
  const preferredProvider = provider ?? ctx.model?.provider;
  if (preferredProvider) {
    const found = ctx.modelRegistry.find(preferredProvider, modelId);
    if (found) return found;
  }
  if (provider) {
    throw new Error(`Unknown model "${provider}/${modelId}".`);
  }
  const matches = ctx.modelRegistry.getAll().filter((m) => m.id === modelId);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Model "${modelId}" exists in multiple providers (${matches.map((m) => m.provider).join(", ")}). Specify a provider.`,
    );
  }
  throw new Error(`Unknown model "${modelId}".`);
}

export default function (pi: ExtensionAPI) {
  const manager = new SubagentManager();
  const resultDelivery = createDeferredResultDelivery<Subagent>();
  let sessionContext: ExtensionContext | undefined;
  let ui: ExtensionUIContext | undefined;

  const updateStatus = () => {
    if (!ui) return;
    const subs = manager.list();
    if (subs.length === 0) {
      ui.setStatus("subagents", undefined);
      return;
    }
    const running = subs.filter((sub) => sub.status === "running").length;
    const failed = subs.filter((sub) => sub.status === "error").length;
    const done = subs.length - running - failed;
    ui.setStatus(
      "subagents",
      formatActivityStatus(ui.theme, "subagents", { running, done, failed }),
    );
  };

  manager.addChangeListener(updateStatus);

  const deliverResult = (sub: Subagent) => {
    pi.sendMessage(
      {
        customType: "subagent-result",
        content: buildSubagentResultMessage({
          id: sub.id,
          title: sub.title,
          status: sub.status,
          errorText: sub.errorText,
          output: truncatedOutput(sub),
        }),
        display: true,
        details: { id: sub.id, title: sub.title, status: sub.status },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  const flushResults = () => {
    for (const sub of resultDelivery.drain()) deliverResult(sub);
  };

  manager.onSettled = (sub, consumed) => {
    if (consumed) {
      resultDelivery.consume([sub.id]);
      return;
    }
    // Keep the result retractable while the parent is working. A later
    // subagent_wait can consume it before agent_settled flushes follow-ups.
    resultDelivery.defer(sub);
    if (sessionContext?.isIdle()) flushResults();
  };

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx;
    if (ctx.hasUI) ui = ctx.ui;
    updateStatus();
  });

  pi.on("agent_settled", flushResults);

  pi.on("session_shutdown", async () => {
    sessionContext = undefined;
    resultDelivery.clear();
    ui?.setStatus("subagents", undefined);
    await manager.disposeAll();
  });

  // --- Tools -------------------------------------------------------------

  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn Subagent",
    description: SUBAGENT_SPAWN_TOOL_DESCRIPTION,
    promptSnippet: SUBAGENT_SPAWN_PROMPT_SNIPPET,
    promptGuidelines: SUBAGENT_SPAWN_PROMPT_GUIDELINES,
    parameters: Type.Object({
      prompt: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.prompt,
      }),
      title: Type.String({
        description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.title,
      }),
      working_dir: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.workingDir,
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.model,
        }),
      ),
      provider: Type.Optional(
        Type.String({
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.provider,
        }),
      ),
      reasoning_effort: Type.Optional(
        StringEnum(THINKING_LEVELS, {
          description: SUBAGENT_SPAWN_PARAMETER_DESCRIPTIONS.reasoningEffort,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const model = resolveModel(ctx, params.provider, params.model);
      const thinkingLevel = (params.reasoning_effort ??
        pi.getThinkingLevel()) as ThinkingLevel;

      const cwd = path.resolve(ctx.cwd, params.working_dir ?? ".");
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
        throw new Error(`working_dir is not a directory: ${cwd}`);
      }

      const title = params.title.trim().slice(0, 160) || "subagent";
      const sub = await manager.spawn({
        prompt: buildSubagentTaskPrompt(params.prompt),
        title,
        cwd,
        model,
        thinkingLevel,
        modelRegistry: ctx.modelRegistry,
        projectTrusted: resolveStandaloneChildProjectTrust({
          parentCwd: ctx.cwd,
          childCwd: cwd,
          parentTrusted: ctx.isProjectTrusted(),
        }),
      });

      return {
        content: [
          {
            type: "text",
            text: buildSubagentSpawnResult({
              id: sub.id,
              title: sub.title,
              provider: model.provider,
              model: model.id,
              cwd,
            }),
          },
        ],
        details: {
          id: sub.id,
          title: sub.title,
          cwd,
          model: `${model.provider}/${model.id}`,
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for Subagents",
    description: SUBAGENT_WAIT_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        maxItems: 64,
        description: SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");
      const known = manager.list().map((sub) => sub.id);
      const unknown = ids.filter((id) => !manager.get(id));
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      await manager.waitFor(ids, signal, (pending) => {
        onUpdate?.({
          content: [
            { type: "text", text: `Waiting for ${pending.join(", ")}...` },
          ],
          details: { pending },
        });
      });

      if (signal?.aborted)
        throw new Error("Wait aborted. Subagents keep running.");

      // Settlement may have happened before this wait began. Remove any
      // deferred automatic delivery now that the tool is returning the result.
      resultDelivery.consume(ids);

      const sections: string[] = [];
      let remainingBytes = WAIT_OUTPUT_MAX_BYTES;
      for (const id of ids) {
        const sub = manager.get(id);
        if (!sub) {
          sections.push(`## ${id}\n\n(no longer tracked)`);
          continue;
        }
        const verb = sub.status === "error" ? "failed" : "finished";
        let section = `## ${sub.id} "${sub.title}" ${verb}`;
        if (sub.errorText) section += `\nError: ${sub.errorText}`;
        const headerBytes = Buffer.byteLength(section, "utf8") + 2;
        const outputBudget = Math.max(
          512,
          Math.min(WAIT_PER_AGENT_MAX_BYTES, remainingBytes - headerBytes),
        );
        section += `\n\n${truncatedOutput(sub, outputBudget)}`;
        const sectionBytes = Buffer.byteLength(section, "utf8");
        if (sectionBytes > remainingBytes) {
          sections.push(
            `## ${sub.id} "${sub.title}"\n\n[omitted: total wait output limit reached]`,
          );
          break;
        }
        sections.push(section);
        remainingBytes -= sectionBytes;
      }

      const combined = sections.join("\n\n---\n\n");
      const bounded = truncateHead(combined, {
        maxBytes: WAIT_OUTPUT_MAX_BYTES - 128,
        maxLines: DEFAULT_MAX_LINES,
      });
      const text = bounded.truncated
        ? `${bounded.content}\n\n[wait output truncated at the total output limit]`
        : bounded.content;
      return {
        content: [{ type: "text", text }],
        details: {
          results: ids.map((id) => {
            const sub = manager.get(id);
            return { id, title: sub?.title, status: sub?.status };
          }),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel Subagents",
    description: SUBAGENT_CANCEL_TOOL_DESCRIPTION,
    parameters: Type.Object({
      ids: Type.Array(Type.String(), {
        description: SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS.ids,
      }),
    }),
    async execute(_toolCallId, params) {
      const ids = [...new Set(params.ids)];
      if (ids.length === 0)
        throw new Error("Provide at least one subagent id.");

      const known = manager.list().map((sub) => sub.id);
      const unknown = ids.filter((id) => !manager.get(id));
      if (unknown.length > 0) {
        throw new Error(
          `Unknown subagent id(s): ${unknown.join(", ")}. Known: ${known.join(", ") || "none"}.`,
        );
      }

      const running = ids
        .map((id) => manager.get(id))
        .filter((sub): sub is Subagent => sub?.status === "running");

      // Mark these results as consumed before aborting so cancellation does not
      // also enqueue duplicate automatic result messages into the parent.
      const waitForSettled = manager.waitFor(running.map((sub) => sub.id));
      await Promise.all(running.map((sub) => manager.abort(sub)));
      await waitForSettled;

      const lines = ids.map((id) => {
        const sub = manager.get(id)!;
        return running.includes(sub)
          ? `Cancelled ${sub.id} "${sub.title}".`
          : `${sub.id} "${sub.title}" was already ${sub.status}.`;
      });

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          results: ids.map((id) => {
            const sub = manager.get(id)!;
            return { id, title: sub.title, status: sub.status };
          }),
        },
      };
    },
  });

  pi.registerTool({
    name: "subagent_check",
    label: "Check Subagent",
    description: SUBAGENT_CHECK_TOOL_DESCRIPTION,
    parameters: Type.Object({
      id: Type.String({
        description: SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS.id,
      }),
    }),
    async execute(_toolCallId, params) {
      const sub = manager.get(params.id);
      if (!sub) {
        const known = manager.list().map((s) => s.id);
        throw new Error(
          `Unknown subagent id "${params.id}". Known: ${known.join(", ") || "none"}.`,
        );
      }

      const turns = sub.session.messages.filter(
        (msg) => (msg as { role?: string }).role === "assistant",
      ).length;
      let text = `${describeSubagent(sub)}\nTurns: ${turns}`;
      if (sub.errorText) text += `\nError: ${sub.errorText}`;

      const output = latestOutput(sub);
      if (output) {
        const preview = truncateHead(output, { maxBytes: 2048, maxLines: 20 });
        text += `\n\nLatest output:\n${preview.content}`;
        if (preview.truncated) text += "\n[...]";
      } else if (sub.status === "running") {
        text += "\n\n(no text output yet)";
      }

      return {
        content: [{ type: "text", text }],
        details: { id: sub.id, status: sub.status, turns },
      };
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List Subagents",
    description: SUBAGENT_LIST_TOOL_DESCRIPTION,
    parameters: Type.Object({}),
    async execute() {
      const subs = manager.list();
      const text =
        subs.length === 0
          ? "No subagents."
          : subs.map((sub) => describeSubagent(sub)).join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          subagents: subs.map((sub) => ({
            id: sub.id,
            title: sub.title,
            status: sub.status,
          })),
        },
      };
    },
  });

  // --- Result message rendering ------------------------------------------

  pi.registerMessageRenderer(
    "subagent-result",
    (message, { expanded }, theme) => {
      const details = (message.details ?? {}) as {
        id?: string;
        title?: string;
        status?: string;
      };
      const failed = details.status === "error";
      const icon = failed ? theme.fg("error", "x") : theme.fg("success", "■");
      const header =
        `${icon} ` +
        theme.fg("accent", theme.bold(`subagent ${details.id ?? "?"}`)) +
        theme.fg(
          "muted",
          ` · ${details.title ?? ""} · ${failed ? "failed" : "finished"}`,
        );

      const content =
        typeof message.content === "string" ? message.content : "";
      // Remove only the summary line. The following Error line (when present)
      // is part of the actual result and must remain visible.
      const body = content.split("\n").slice(1).join("\n").trim();

      if (expanded) {
        const md = new Markdown(`${body}`, 0, 0, getMarkdownTheme());
        const container = new Text(header, 0, 0);
        // Text can't hold children; render header + markdown via a simple approach:
        return {
          render: (width: number) => [
            ...container.render(width),
            ...md.render(width),
          ],
          invalidate: () => {
            container.invalidate();
            md.invalidate();
          },
        };
      }

      const previewLines = body.split("\n").slice(0, 8);
      let text = header;
      for (const line of previewLines)
        text += `\n${theme.fg("toolOutput", line)}`;
      if (body.split("\n").length > 8)
        text += `\n${theme.fg("dim", "... (ctrl+o to expand)")}`;
      return new Text(text, 0, 0);
    },
  );

  // --- Command ------------------------------------------------------------

  pi.registerCommand("subagents", {
    description: "List, inspect, and take over subagents",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI)
          ctx.ui.notify(
            "Subagent takeover is only available in the TUI",
            "error",
          );
        return;
      }
      if (manager.size() === 0) {
        ctx.ui.notify(
          "No subagents yet. The agent spawns them with subagent_spawn.",
          "info",
        );
        return;
      }
      await openSubagentPicker(ctx, manager);
    },
  });
}

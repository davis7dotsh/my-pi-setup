import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const STATE_TYPE = "openai-fast";

function supportsFastMode(model: ExtensionContext["model"]) {
  return (
    model?.provider === "openai" &&
    (model.api === "openai-responses" || model.api === "openai-completions")
  );
}

export default function openaiFast(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const statePath = join(agentDir, "openai-fast.json");
  let enabled = false;

  function readState(ctx: ExtensionContext) {
    try {
      const state: unknown = JSON.parse(readFileSync(statePath, "utf8"));
      if (
        typeof state !== "object" ||
        state === null ||
        !("enabled" in state) ||
        typeof state.enabled !== "boolean"
      ) {
        ctx.ui.notify("Invalid global OpenAI fast mode state; using off.", "warning");
        return false;
      }
      return state.enabled;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        ctx.ui.notify(`Could not read OpenAI fast mode state: ${String(error)}`, "warning");
      }
      return false;
    }
  }

  function saveState(nextEnabled: boolean, ctx: ExtensionContext) {
    const tempPath = `${statePath}.${randomUUID()}.tmp`;
    try {
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(tempPath, `${JSON.stringify({ enabled: nextEnabled })}\n`, { mode: 0o600 });
      renameSync(tempPath, statePath);
      return true;
    } catch (error) {
      ctx.ui.notify(`Could not save OpenAI fast mode state: ${String(error)}`, "error");
      return false;
    } finally {
      rmSync(tempPath, { force: true });
    }
  }

  function updateStatus(ctx: ExtensionContext) {
    ctx.ui.setStatus(
      STATE_TYPE,
      enabled && supportsFastMode(ctx.model) ? "fast" : undefined,
    );
  }

  function restore(ctx: ExtensionContext) {
    enabled = readState(ctx);
    updateStatus(ctx);
  }

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("model_select", (_event, ctx) => restore(ctx));

  pi.on("before_provider_request", (event, ctx) => {
    // Pick up toggles from other running Pi instances without a file watcher.
    restore(ctx);
    if (
      !supportsFastMode(ctx.model) ||
      typeof event.payload !== "object" ||
      event.payload === null ||
      Array.isArray(event.payload)
    ) {
      return;
    }

    // Priority is OpenAI's fast mode. Explicit default prevents project-level
    // service-tier defaults from keeping priority enabled after /fast off.
    return { ...event.payload, service_tier: enabled ? "priority" : "default" };
  });

  pi.registerCommand("fast", {
    description: "Toggle global OpenAI fast mode (priority tier): /fast [on|off|status]",
    getArgumentCompletions: (prefix) =>
      ["on", "off", "status"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (!["", "on", "off", "status"].includes(action)) {
        ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
        return;
      }

      restore(ctx);
      if (action !== "status") {
        const nextEnabled = action === "" ? !enabled : action === "on";
        if (!saveState(nextEnabled, ctx)) return;
        enabled = nextEnabled;
      }
      updateStatus(ctx);
      const scope = supportsFastMode(ctx.model)
        ? ""
        : " (inactive for the current provider/API)";
      ctx.ui.notify(
        `OpenAI fast mode ${enabled ? "on" : "off"} globally${scope}.${
          enabled ? " Priority requests may cost more." : ""
        }`,
        "info",
      );
    },
  });
}

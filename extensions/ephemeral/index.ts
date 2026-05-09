import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { applySelection } from "./apply.ts";
import { scanCatalog } from "./catalog.ts";
import { getCatalogManifestWarnings, readProjectState } from "./project-state.ts";
import type { CatalogData, EphemeralCategory, ProjectState } from "./types.ts";
import { pluralize } from "./util.ts";
import { showEphemeralUi } from "./ui.ts";

export default function piEphemeralExtension(pi: ExtensionAPI) {
  let lastCategory: EphemeralCategory = "skills";

  pi.on("session_start", async (_event, ctx) => {
    try {
      const { catalog, state } = await loadCatalogAndState(ctx.cwd);
      const warnings = [...catalog.warnings, ...state.warnings];
      if (warnings.length > 0 && ctx.hasUI) {
        const message = [
          `Pi Ephemeral: ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`,
          ...warnings.slice(0, 5).map((warning) => `- ${warning}`),
          ...(warnings.length > 5 ? [`- … ${warnings.length - 5} more`] : []),
        ].join("\n");
        ctx.ui.notify(message, "warning");
      }
    } catch (error) {
      if (ctx.hasUI) {
        ctx.ui.notify(`Pi Ephemeral startup check failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
  });

  pi.registerCommand("ephemeral", {
    description: "Select project-local ephemeral skills, prompts, extensions, and MCP servers",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/ephemeral requires interactive mode", "error");
        return;
      }

      let catalog: CatalogData;
      let state: ProjectState;
      try {
        ({ catalog, state } = await loadCatalogAndState(ctx.cwd));
      } catch (error) {
        ctx.ui.notify(`Pi Ephemeral failed to load: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }

      const result = await showEphemeralUi(ctx, catalog, state, lastCategory);
      lastCategory = result.lastCategory;
      if (result.action !== "apply") return;

      const currentKeys = new Set(Object.keys(state.manifest.items));
      const noChange = setsEqual(currentKeys, result.desiredKeys);
      if (noChange) {
        ctx.ui.notify("Pi Ephemeral: no staged changes to apply", "info");
        return;
      }

      try {
        const applyResult = await applySelection(ctx.cwd, catalog, state, result.desiredKeys);
        const changesApplied = applyResult.addedKeys.length + applyResult.removedKeys.length;

        if (changesApplied === 0 && applyResult.conflicts.length > 0) {
          ctx.ui.notify(
            [
              `Pi Ephemeral could not apply ${pluralize(applyResult.conflicts.length, "change")}.`,
              ...applyResult.conflicts.slice(0, 5).map((conflict) => `- ${conflict.message}`),
            ].join("\n"),
            "warning",
          );
          return;
        }

        const summary = [
          `Pi Ephemeral applied ${changesApplied} ${pluralize(changesApplied, "change")}. Run /reload to activate them.`,
          applyResult.addedKeys.length > 0 ? `Added: ${applyResult.addedKeys.length}` : undefined,
          applyResult.removedKeys.length > 0 ? `Removed: ${applyResult.removedKeys.length}` : undefined,
          applyResult.conflicts.length > 0 ? `Conflicts skipped: ${applyResult.conflicts.length}` : undefined,
          ...applyResult.conflicts.slice(0, 3).map((conflict) => `- ${conflict.message}`),
        ].filter((line): line is string => Boolean(line));

        ctx.ui.notify(summary.join("\n"), applyResult.conflicts.length > 0 ? "warning" : "info");
      } catch (error) {
        ctx.ui.notify(`Pi Ephemeral apply failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}

function setsEqual<T>(left: Set<T>, right: Set<T>) {
  return left.size === right.size && Array.from(left).every((value) => right.has(value));
}

async function loadCatalogAndState(cwd: string): Promise<{ catalog: CatalogData; state: ProjectState }> {
  const [catalog, state] = await Promise.all([
    scanCatalog(),
    readProjectState(cwd),
  ]);

  return {
    catalog,
    state: {
      ...state,
      warnings: [...state.warnings, ...getCatalogManifestWarnings(state.manifest.items, catalog)],
    },
  };
}

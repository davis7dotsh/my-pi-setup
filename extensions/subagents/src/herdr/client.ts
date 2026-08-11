import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  HerdrMirrorAdapter,
  HerdrParentIdentity,
  MirrorLaunch,
} from "./coordinator.ts";

const execFileAsync = promisify(execFile);

export type HerdrCommandRunner = (args: string[]) => Promise<string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function resolveHerdrBinary(env: NodeJS.ProcessEnv) {
  if (env.HERDR_BIN) return env.HERDR_BIN;
  const homebrewPath = "/opt/homebrew/bin/herdr";
  try {
    await access(homebrewPath);
    return homebrewPath;
  } catch {
    return "herdr";
  }
}

function parseCommandResult(stdout: string) {
  const decoded: unknown = JSON.parse(stdout);
  if (!isRecord(decoded) || !isRecord(decoded.result)) {
    throw new Error("Herdr returned an unexpected response.");
  }
  return decoded.result;
}

function parseCreatedTab(stdout: string) {
  const result = parseCommandResult(stdout);
  if (
    !isRecord(result.root_pane) ||
    typeof result.root_pane.pane_id !== "string" ||
    !isRecord(result.tab) ||
    typeof result.tab.tab_id !== "string"
  ) {
    throw new Error("Herdr did not return the created pane and tab ids.");
  }
  return {
    rootPaneId: result.root_pane.pane_id,
    tabId: result.tab.tab_id,
  };
}

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function safeLabel(text: string, fallback: string) {
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  const bounded = [...graphemeSegmenter.segment(clean)]
    .slice(0, 100)
    .map(({ segment }) => segment)
    .join("");
  return bounded || fallback;
}

export async function createHerdrMirrorAdapterFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  commandRunner?: HerdrCommandRunner,
) {
  if (env.HERDR_ENV !== "1" || !env.HERDR_PANE_ID || !env.HERDR_SOCKET_PATH) {
    return undefined;
  }

  let viewerHerdrBinary = env.HERDR_BIN ?? "herdr";
  let runHerdrCommand: HerdrCommandRunner;
  if (commandRunner) {
    runHerdrCommand = commandRunner;
  } else {
    const herdr = await resolveHerdrBinary(env);
    viewerHerdrBinary = herdr;
    runHerdrCommand = async (args) => {
      const timeout =
        args[0] === "tab" && args[1] === "create" ? 15_000 : 5_000;
      const { stdout } = await execFileAsync(herdr, args, {
        env,
        maxBuffer: 4 * 1024 * 1024,
        timeout,
      });
      return stdout;
    };
  }

  let parentLabel = `Pi ${env.HERDR_PANE_ID}`;
  let workspaceId = env.HERDR_WORKSPACE_ID;
  let parentSessionId: string | undefined;
  try {
    const result = parseCommandResult(
      await runHerdrCommand(["pane", "get", env.HERDR_PANE_ID]),
    );
    const pane = isRecord(result.pane) ? result.pane : undefined;
    if (pane) {
      workspaceId =
        typeof pane.workspace_id === "string" ? pane.workspace_id : workspaceId;
      parentLabel = safeLabel(
        typeof pane.title === "string"
          ? pane.title
          : typeof pane.terminal_title_stripped === "string"
            ? pane.terminal_title_stripped
            : "",
        parentLabel,
      );
      const agentSession = isRecord(pane.agent_session)
        ? pane.agent_session
        : undefined;
      if (typeof agentSession?.value === "string") {
        parentSessionId = path
          .basename(agentSession.value)
          .replace(/\.jsonl$/, "");
      }
    }
  } catch {
    // The env-provided workspace remains a safe fallback on older Herdr builds.
  }
  if (!workspaceId) return undefined;

  const parent: HerdrParentIdentity = {
    paneId: env.HERDR_PANE_ID,
    workspaceId,
    label: parentLabel,
    sessionId: parentSessionId,
  };

  return {
    parent,
    async createMirror(launch: MirrorLaunch) {
      const label = safeLabel(`Fable · ${launch.title}`, "Fable");
      const created = parseCreatedTab(
        await runHerdrCommand([
          "tab",
          "create",
          "--workspace",
          launch.parent.workspaceId,
          "--cwd",
          launch.cwd,
          "--label",
          label,
          "--env",
          `FABLE_MIRROR_SOCKET=${launch.socketPath}`,
          "--env",
          `FABLE_MIRROR_TOKEN=${launch.token}`,
          "--env",
          `FABLE_MIRROR_SUBAGENT_ID=${launch.subagentId}`,
          "--env",
          `FABLE_MIRROR_PARENT_PANE_ID=${launch.parent.paneId}`,
          "--env",
          `FABLE_MIRROR_PARENT_LABEL=${launch.parent.label}`,
          "--env",
          `FABLE_MIRROR_PARENT_SESSION_ID=${launch.parent.sessionId ?? ""}`,
          "--env",
          `FABLE_MIRROR_MODEL=${safeLabel(launch.model, "Fable")}`,
          "--env",
          `HERDR_BIN=${viewerHerdrBinary}`,
          "--no-focus",
        ]),
      );
      const handle = {
        paneId: created.rootPaneId,
        tabId: created.tabId,
      };
      try {
        await runHerdrCommand([
          "pane",
          "run",
          handle.paneId,
          "exec",
          process.execPath,
          "--experimental-strip-types",
          launch.viewerPath,
        ]);
      } catch (error) {
        await runHerdrCommand(["tab", "close", handle.tabId]).catch(
          () => undefined,
        );
        throw error;
      }
      return handle;
    },
    async closeMirror(handle) {
      await runHerdrCommand(["tab", "close", handle.tabId]);
    },
    async focusParent() {
      await runHerdrCommand(["agent", "focus", parent.paneId]);
    },
  } satisfies HerdrMirrorAdapter;
}

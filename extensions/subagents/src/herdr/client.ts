import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import type {
  HerdrMirrorAdapter,
  HerdrParentIdentity,
  MirrorHandle,
  MirrorLaunch,
} from "./coordinator.ts";

const execFileAsync = promisify(execFile);

interface HerdrResponse<T> {
  readonly result: T;
}

interface CreatedTabResult {
  readonly root_pane: { readonly pane_id: string };
  readonly tab: { readonly tab_id: string };
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

function parseResponse<T>(stdout: string): T {
  const decoded = JSON.parse(stdout) as HerdrResponse<T>;
  if (!decoded || typeof decoded !== "object" || !("result" in decoded)) {
    throw new Error("Herdr returned an unexpected response.");
  }
  return decoded.result;
}

function safeLabel(text: string, fallback: string) {
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean.slice(0, 100) || fallback;
}

export async function createHerdrMirrorAdapterFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HerdrMirrorAdapter | undefined> {
  if (
    env.HERDR_ENV !== "1" ||
    !env.HERDR_PANE_ID ||
    !env.HERDR_WORKSPACE_ID ||
    !env.HERDR_SOCKET_PATH
  ) {
    return undefined;
  }

  const herdr = await resolveHerdrBinary(env);
  const run = async (args: string[]) => {
    const { stdout } = await execFileAsync(herdr, args, {
      env,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout;
  };

  let parentLabel = `Pi ${env.HERDR_PANE_ID}`;
  try {
    const pane = parseResponse<{
      pane?: { terminal_title_stripped?: string; title?: string };
    }>(await run(["pane", "get", env.HERDR_PANE_ID]));
    parentLabel = safeLabel(
      pane.pane?.title ?? pane.pane?.terminal_title_stripped ?? "",
      parentLabel,
    );
  } catch {
    // Pane metadata is display-only. The stable pane id remains sufficient.
  }

  const parent: HerdrParentIdentity = {
    paneId: env.HERDR_PANE_ID,
    workspaceId: env.HERDR_WORKSPACE_ID,
    label: parentLabel,
  };

  return {
    parent,
    async createMirror(launch: MirrorLaunch): Promise<MirrorHandle> {
      const label = safeLabel(`Fable · ${launch.title}`, "Fable");
      const created = parseResponse<CreatedTabResult>(
        await run([
          "tab",
          "create",
          "--workspace",
          launch.workspaceId,
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
          `FABLE_MIRROR_PARENT_PANE_ID=${launch.parentPaneId}`,
          "--env",
          `FABLE_MIRROR_PARENT_LABEL=${launch.parentLabel}`,
          "--env",
          `FABLE_MIRROR_MODEL=${launch.model}`,
          "--no-focus",
        ]),
      );
      const handle = {
        paneId: created.root_pane.pane_id,
        tabId: created.tab.tab_id,
      };
      try {
        await run([
          "pane",
          "run",
          handle.paneId,
          "exec",
          process.execPath,
          "--experimental-strip-types",
          launch.viewerPath,
        ]);
      } catch (error) {
        await run(["tab", "close", handle.tabId]).catch(() => undefined);
        throw error;
      }
      return handle;
    },
    async closeMirror(handle) {
      await run(["tab", "close", handle.tabId]);
    },
    async focusParent() {
      await run(["agent", "focus", parent.paneId]);
    },
  };
}

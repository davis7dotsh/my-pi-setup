import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { access, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const PACKAGE_NAME = "@mariozechner/pi-coding-agent";
const TRANSIENT_PATTERNS = [
  /eai_again/i,
  /etimedout/i,
  /econnreset/i,
  /econnrefused/i,
  /socket hang up/i,
  /network/i,
  /timeout/i,
  /temporar/i,
  /too many requests/i,
  /\b429\b/,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
];

type InstallMethod = "vp" | "bun" | "npm" | "brew" | "native";

type CommandSpec = {
  command: string;
  args: string[];
  label: string;
};

async function pathExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommand(command: string, pi: ExtensionAPI) {
  const result = await pi.exec("/bin/sh", ["-lc", `command -v ${command} || true`], { timeout: 10_000 });
  return result.stdout.trim().split("\n")[0] || undefined;
}

async function currentVersion(pi: ExtensionAPI) {
  const result = await pi.exec("pi", ["--version"], { timeout: 10_000 });
  return result.stdout.trim() || result.stderr.trim() || "unknown";
}

async function detectInstallMethod(pi: ExtensionAPI): Promise<InstallMethod> {
  const piPath = await resolveCommand("pi", pi);
  const realPiPath = piPath ? await realpath(piPath).catch(() => piPath) : undefined;

  if (piPath?.includes("/.vite-plus/") || realPiPath?.includes("/.vite-plus/")) return "vp";
  if (piPath?.includes("/.bun/") || realPiPath?.includes("/.bun/")) return "bun";
  if (piPath?.includes("/Homebrew/") || piPath?.includes("/homebrew/") || realPiPath?.includes("/Homebrew/") || realPiPath?.includes("/homebrew/")) return "brew";

  if (piPath) {
    let dir = dirname(piPath);
    for (let i = 0; i < 5; i++) {
      if (await pathExists(resolve(dir, "node_modules", PACKAGE_NAME))) return "npm";
      dir = dirname(dir);
    }
  }

  if (await resolveCommand("vp", pi)) return "vp";
  if (await resolveCommand("bun", pi)) return "bun";
  if (await resolveCommand("npm", pi)) return "npm";
  if (await resolveCommand("brew", pi)) return "brew";
  return "native";
}

function commandFor(method: InstallMethod): CommandSpec | undefined {
  switch (method) {
    case "vp":
      return { command: "vp", args: ["add", "-g", `${PACKAGE_NAME}@latest`], label: `vp add -g ${PACKAGE_NAME}@latest` };
    case "bun":
      return { command: "bun", args: ["add", "-g", `${PACKAGE_NAME}@latest`], label: `bun add -g ${PACKAGE_NAME}@latest` };
    case "npm":
      return { command: "npm", args: ["install", "-g", `${PACKAGE_NAME}@latest`], label: `npm install -g ${PACKAGE_NAME}@latest` };
    case "brew":
      return { command: "/bin/sh", args: ["-lc", "brew upgrade pi-coding-agent || brew upgrade pi"], label: "brew upgrade pi-coding-agent || brew upgrade pi" };
    case "native":
      return undefined;
  }
}

function isTransient(output: string) {
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(output));
}

async function runWithRetry(pi: ExtensionAPI, spec: CommandSpec) {
  let lastOutput = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await pi.exec(spec.command, spec.args, { timeout: 180_000 });
    lastOutput = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    if (result.code === 0) return { ok: true, output: lastOutput, attempts: attempt };
    if (attempt === 3 || !isTransient(lastOutput)) return { ok: false, output: lastOutput, attempts: attempt };
    await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
  }
  return { ok: false, output: lastOutput, attempts: 3 };
}

async function updatePi(pi: ExtensionAPI, ctx: ExtensionCommandContext) {
  await ctx.waitForIdle();

  const before = await currentVersion(pi).catch(() => "unknown");
  const method = await detectInstallMethod(pi);
  const spec = commandFor(method);

  if (!spec) {
    ctx.ui.notify(`Pi ${before}; install method appears native. Please update the native binary manually.`, "warning");
    return;
  }

  ctx.ui.notify(`Updating Pi via ${method}: ${spec.label}`, "info");
  const result = await runWithRetry(pi, spec);
  const after = await currentVersion(pi).catch(() => "unknown");

  if (!result.ok) {
    ctx.ui.notify(`Pi update failed after ${result.attempts} attempt(s). ${result.output || "No output."}`, "error");
    return;
  }

  const changed = before !== after && before !== "unknown" && after !== "unknown";
  const summary = changed ? `Pi updated: ${before} → ${after}` : `Pi is up to date (${after}).`;
  ctx.ui.notify(`${summary}${result.attempts > 1 ? ` Retried ${result.attempts - 1} transient failure(s).` : ""}`, "info");
}

export default function (pi: ExtensionAPI) {
  pi.registerFlag("update", {
    description: "Update Pi using the detected install method, then report the version change",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("update", {
    description: "Update Pi using vp, bun, npm, brew, or native detection",
    handler: async (_args, ctx) => {
      await updatePi(pi, ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!pi.getFlag("update")) return;
    pi.sendUserMessage("/update", { deliverAs: "followUp" });
    ctx.ui.notify("Queued /update from --update", "info");
  });
}

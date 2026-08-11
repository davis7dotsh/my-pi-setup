import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import type { SubagentSnapshot } from "../domain.ts";
import {
  MAX_SNAPSHOT_MESSAGE_BYTES,
  MIRROR_PROTOCOL_VERSION,
  type BridgeMessage,
} from "./protocol.ts";
import { renderMirrorFrame } from "./viewer-render.ts";

const execFileAsync = promisify(execFile);

function requiredEnvironment(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      "This viewer must be launched by the Fable mirror coordinator.",
    );
  }
  return value;
}

const socketPath = requiredEnvironment("FABLE_MIRROR_SOCKET");
const token = requiredEnvironment("FABLE_MIRROR_TOKEN");
const subagentId = requiredEnvironment("FABLE_MIRROR_SUBAGENT_ID");
const paneId = requiredEnvironment("HERDR_PANE_ID");
const parentPaneId = process.env.FABLE_MIRROR_PARENT_PANE_ID ?? "parent";
const parentLabel = process.env.FABLE_MIRROR_PARENT_LABEL ?? parentPaneId;
const initialModel = process.env.FABLE_MIRROR_MODEL ?? "Fable";
const herdr = process.env.HERDR_BIN ?? "/opt/homebrew/bin/herdr";

let snapshot: SubagentSnapshot | undefined;
let notice = "Connecting to parent…";
let sequence = 0;
let lastReported = "";
let reporting = Promise.resolve();

function runHerdr(args: string[]) {
  reporting = reporting
    .then(() => execFileAsync(herdr, args, { env: process.env }))
    .then(() => undefined)
    .catch(() => undefined);
}

function reportIdentity(current: SubagentSnapshot) {
  const model = current.meta.modelLabel ?? initialModel;
  const title = `↳ ${parentLabel} · ${current.id} · ${model}`;
  process.stdout.write(`\u001b]0;${title}\u0007`);
  if (sequence === 0) {
    runHerdr([
      "pane",
      "report-agent-session",
      paneId,
      "--source",
      "sapoto:fable-mirror",
      "--agent",
      "fable",
      "--seq",
      String(++sequence),
      "--agent-session-id",
      `${parentPaneId}:${current.id}`,
      "--session-start-source",
      "parent-bridge",
    ]);
    runHerdr([
      "pane",
      "report-metadata",
      paneId,
      "--source",
      "sapoto:fable-mirror",
      "--agent",
      "fable",
      "--display-agent",
      "Fable",
      "--title",
      title,
      "--token",
      `parent=${parentPaneId}`,
      "--token",
      `subagent=${current.id}`,
      "--token",
      `model=${model}`,
      "--seq",
      String(++sequence),
    ]);
  }
  const state =
    current.status === "running"
      ? "working"
      : current.status === "done"
        ? "idle"
        : "blocked";
  const reportKey = `${state}:${current.status}:${current.errorText ?? ""}`;
  if (reportKey === lastReported) return;
  lastReported = reportKey;
  runHerdr([
    "pane",
    "report-agent",
    paneId,
    "--source",
    "sapoto:fable-mirror",
    "--agent",
    "fable",
    "--state",
    state,
    "--message",
    current.errorText ?? current.status,
    "--seq",
    String(++sequence),
    "--agent-session-id",
    `${parentPaneId}:${current.id}`,
  ]);
}

function render() {
  const columns = process.stdout.columns || 100;
  const rows = process.stdout.rows || 30;
  let lines: string[];
  if (snapshot) {
    lines = renderMirrorFrame(snapshot, {
      columns,
      rows,
      input: "[read-only mirror · use /subagents to interact]",
    });
  } else {
    lines = [
      "─".repeat(columns),
      `Fable mirror · ${subagentId} · ${notice}`,
      "─".repeat(columns),
      "Ctrl-D close mirror",
    ];
  }
  process.stdout.write(`\u001b[2J\u001b[H${lines.join("\n")}\u001b[0m`);
}

function decodeMessage(value: unknown): BridgeMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message = value as Partial<BridgeMessage>;
  if (message.version !== MIRROR_PROTOCOL_VERSION) return undefined;
  if (message.type === "snapshot" && message.snapshot?.id === subagentId) {
    return message as BridgeMessage;
  }
  if (message.type === "error" && typeof message.message === "string") {
    return message as BridgeMessage;
  }
  return undefined;
}

const socket = net.createConnection(socketPath);
let incoming = "";
socket.setEncoding("utf8");
socket.on("connect", () => {
  socket.write(
    `${JSON.stringify({ version: MIRROR_PROTOCOL_VERSION, type: "attach", token, subagentId })}\n`,
  );
});
socket.on("data", (chunk) => {
  incoming += chunk;
  if (Buffer.byteLength(incoming, "utf8") > MAX_SNAPSHOT_MESSAGE_BYTES) {
    notice = "Parent sent an oversized message";
    render();
    socket.destroy();
    return;
  }
  while (true) {
    const newline = incoming.indexOf("\n");
    if (newline < 0) break;
    const line = incoming.slice(0, newline);
    incoming = incoming.slice(newline + 1);
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      notice = "Parent sent malformed data";
      render();
      continue;
    }
    const message = decodeMessage(decoded);
    if (!message) {
      notice = "Parent sent an invalid protocol message";
    } else if (message.type === "error") {
      notice = message.message;
    } else {
      snapshot = message.snapshot;
      notice = "Connected";
      reportIdentity(snapshot);
    }
    render();
  }
});
socket.on("error", (error) => {
  notice = `Mirror disconnected: ${error.message}`;
  render();
});
socket.on("close", () => {
  notice = "Parent bridge closed; this mirror will close";
  render();
  process.exitCode = 0;
  setTimeout(() => process.exit(), 750).unref();
});

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (data: Buffer) => {
    const text = data.toString("utf8");
    if (text === "\u0004" || text === "\u0003") {
      socket.destroy();
      process.exit(0);
    }
  });
}
process.stdout.on("resize", render);
process.on("exit", () => {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
});
render();

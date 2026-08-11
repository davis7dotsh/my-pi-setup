import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import type { SubagentSnapshot } from "../domain.ts";
import {
  MAX_SNAPSHOT_MESSAGE_BYTES,
  MIRROR_PROTOCOL_VERSION,
  parseBridgeMessage,
} from "./protocol.ts";
import { consumeViewerInput, type ViewerEscapeState } from "./viewer-input.ts";
import { renderMirrorFrame, sanitizeTerminalText } from "./viewer-render.ts";

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
const parentSessionId =
  process.env.FABLE_MIRROR_PARENT_SESSION_ID || parentPaneId;
const initialModel = process.env.FABLE_MIRROR_MODEL ?? "Fable";
const herdr = process.env.HERDR_BIN ?? "herdr";
const reportEnvironment = { ...process.env };
delete reportEnvironment.FABLE_MIRROR_TOKEN;
delete reportEnvironment.FABLE_MIRROR_SOCKET;

let snapshot: SubagentSnapshot | undefined;
let notice = "Connecting to parent…";
let input = "";
let inputEscapeState: ViewerEscapeState = "none";
let requestSequence = 0;
let sequence = 0;
let lastReported = "";
let reporting = Promise.resolve();

function runHerdr(args: string[]) {
  reporting = reporting
    .then(() =>
      execFileAsync(herdr, args, {
        env: reportEnvironment,
        timeout: 5_000,
      }),
    )
    .then(() => undefined)
    .catch(() => undefined);
}

function reportIdentity(current: SubagentSnapshot) {
  const model = sanitizeTerminalText(
    current.meta.modelLabel ?? initialModel,
  ).trim();
  const childId = sanitizeTerminalText(current.id).trim();
  const safeParentLabel = sanitizeTerminalText(parentLabel).trim();
  const safeParentPane = sanitizeTerminalText(parentPaneId).trim();
  const safeParentSession = sanitizeTerminalText(parentSessionId).trim();
  const title = `↳ ${safeParentLabel} · ${childId} · ${model}`;
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
      `${safeParentSession}:${childId}`,
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
      `parent=${safeParentPane}`,
      "--token",
      `parent_session=${safeParentSession}`,
      "--token",
      `subagent=${childId}`,
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
    sanitizeTerminalText(current.errorText ?? current.status),
    "--seq",
    String(++sequence),
    "--agent-session-id",
    `${safeParentSession}:${childId}`,
  ]);
}

function render() {
  const columns = process.stdout.columns || 100;
  const rows = process.stdout.rows || 30;
  let lines: string[];
  if (snapshot) {
    lines = renderMirrorFrame(snapshot, { columns, rows, input, notice });
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

let socket: net.Socket | undefined;
let reconnectAttempts = 0;
let closing = false;
let fatalProtocolError = false;

function closeViewer(message: string) {
  notice = message;
  render();
  process.exitCode = 0;
  setTimeout(() => process.exit(), 750).unref();
}

function connect() {
  if (closing) return;
  let incoming = "";
  const current = net.createConnection(socketPath);
  socket = current;
  current.setEncoding("utf8");
  current.on("connect", () => {
    current.write(
      `${JSON.stringify({ version: MIRROR_PROTOCOL_VERSION, type: "attach", token, subagentId })}\n`,
    );
  });
  current.on("data", (chunk) => {
    incoming += chunk;
    while (true) {
      const newline = incoming.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(incoming, "utf8") > MAX_SNAPSHOT_MESSAGE_BYTES) {
          fatalProtocolError = true;
          notice = "Parent sent an oversized message";
          render();
          current.destroy();
        }
        break;
      }
      const line = incoming.slice(0, newline);
      incoming = incoming.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_SNAPSHOT_MESSAGE_BYTES) {
        fatalProtocolError = true;
        notice = "Parent sent an oversized message";
        render();
        current.destroy();
        return;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch {
        fatalProtocolError = true;
        notice = "Parent sent malformed data";
        render();
        current.destroy();
        return;
      }
      const message = parseBridgeMessage(decoded);
      if (
        !message ||
        (message.type === "snapshot" && message.snapshot.id !== subagentId)
      ) {
        fatalProtocolError = true;
        notice = "Parent sent an invalid protocol message";
        render();
        current.destroy();
        return;
      }
      if (message.type === "error") {
        fatalProtocolError = true;
        notice = message.message;
        render();
        current.destroy();
        return;
      }
      if (message.type === "actionResult") {
        notice = message.ok
          ? "Action sent"
          : (message.error ?? "Action failed");
      } else {
        snapshot = message.snapshot;
        reconnectAttempts = 0;
        notice = "Connected";
        reportIdentity(snapshot);
      }
      render();
    }
  });
  current.on("error", (error) => {
    notice = `Mirror disconnected: ${error.message}`;
    render();
  });
  current.on("close", () => {
    if (socket === current) socket = undefined;
    if (closing || fatalProtocolError) {
      closeViewer(
        fatalProtocolError
          ? `${notice}; this mirror will close`
          : "Mirror closed",
      );
      return;
    }
    reconnectAttempts++;
    if (reconnectAttempts > 5) {
      closeViewer("Parent bridge stayed unavailable; this mirror will close");
      return;
    }
    const delay = Math.min(2_000, 250 * 2 ** (reconnectAttempts - 1));
    notice = `Parent bridge disconnected; reconnecting (${reconnectAttempts}/5)…`;
    render();
    setTimeout(connect, delay);
  });
}

async function sendAction(
  action: "send" | "abort" | "focus-parent",
  text?: string,
) {
  const active = socket;
  if (!active || active.destroyed) {
    notice = "Parent bridge is disconnected; action was not sent";
    render();
    return;
  }
  const requestId = `viewer-${++requestSequence}`;
  const line = `${JSON.stringify({
    version: MIRROR_PROTOCOL_VERSION,
    type: "action",
    requestId,
    action,
    ...(action === "send" ? { text } : {}),
  })}\n`;
  await new Promise<void>((resolve) => active.write(line, () => resolve()));
  notice = action === "focus-parent" ? "Focusing parent…" : "Sending action…";
  render();
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  let inputQueue = Promise.resolve();
  process.stdin.on("data", (text: string) => {
    inputQueue = inputQueue.then(async () => {
      const consumed = consumeViewerInput(input, text, inputEscapeState);
      input = consumed.input;
      inputEscapeState = consumed.escapeState;
      for (const command of consumed.commands) {
        if (command.action === "close") {
          closing = true;
          const active = socket;
          if (active && !active.destroyed) {
            await new Promise<void>((resolve) => active.end(resolve));
          } else {
            closeViewer("Mirror closed");
          }
          return;
        }
        if (command.action === "send") {
          await sendAction("send", command.text);
        } else {
          await sendAction(command.action);
        }
      }
      render();
    });
  });
}
connect();
process.stdout.on("resize", render);
process.on("exit", () => {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
});
render();

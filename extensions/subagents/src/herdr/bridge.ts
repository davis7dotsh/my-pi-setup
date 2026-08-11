import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { chmod, mkdir, rm, unlink } from "node:fs/promises";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import type { SubagentReadModel } from "../manager.ts";
import {
  encodeBridgeMessage,
  MAX_VIEWER_MESSAGE_BYTES,
  MIRROR_PROTOCOL_VERSION,
  parseViewerMessage,
  type BridgeMessage,
} from "./protocol.ts";

export interface MirrorBridgeEndpoint {
  readonly socketPath: string;
  /** Mint a capability valid only for this parent and subagent id. */
  credentialFor(subagentId: string): string;
}

export interface MirrorBridge extends MirrorBridgeEndpoint {
  close(): Promise<void>;
}

export interface MirrorBridgeActions {
  send(subagentId: string, text: string): Promise<void>;
  abort(subagentId: string): Promise<void>;
  focusParent(): Promise<void>;
}

function tokensMatch(actual: string, expected: string) {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function errorMessage(
  code: Extract<BridgeMessage, { type: "error" }>["code"],
  message: string,
): BridgeMessage {
  return { version: MIRROR_PROTOCOL_VERSION, type: "error", code, message };
}

export async function startMirrorBridge(
  view: SubagentReadModel,
  options: {
    readonly baseDir?: string;
    readonly actions?: MirrorBridgeActions;
    readonly authTimeoutMs?: number;
    readonly maxClients?: number;
    readonly maxPendingActions?: number;
  } = {},
): Promise<MirrorBridge> {
  const ownsDirectory = options.baseDir === undefined;
  const directory =
    options.baseDir ??
    path.join(
      os.tmpdir(),
      `pi-fable-mirror-${process.pid}-${randomBytes(8).toString("hex")}`,
    );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const socketPath = path.join(directory, "bridge.sock");
  const parentCredential = randomBytes(32);
  const credentialFor = (subagentId: string) =>
    createHmac("sha256", parentCredential)
      .update(subagentId, "utf8")
      .digest("base64url");
  const sockets = new Set<Socket>();
  const authTimeoutMs = options.authTimeoutMs ?? 5_000;
  const maxClients = options.maxClients ?? 16;
  const maxPendingActions = options.maxPendingActions ?? 32;
  const server = net.createServer((socket) => {
    if (sockets.size >= maxClients) {
      socket.end(
        encodeBridgeMessage(
          errorMessage("unsupported", "Too many mirror clients."),
        ),
      );
      return;
    }
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let attachedSubagentId: string | undefined;
    let unsubscribe: (() => void) | undefined;
    let pendingSnapshot: string | undefined;
    let snapshotTimer: ReturnType<typeof setTimeout> | undefined;
    let waitingForDrain = false;
    let pendingActions = 0;
    let actionQueue = Promise.resolve();

    const write = (message: BridgeMessage) => {
      if (socket.destroyed) return;
      let line: string;
      try {
        line = encodeBridgeMessage(message);
      } catch {
        line = encodeBridgeMessage(
          errorMessage("oversized", "Snapshot exceeds the bridge limit."),
        );
      }
      if (waitingForDrain && message.type === "snapshot") {
        pendingSnapshot = line;
        return;
      }
      waitingForDrain = !socket.write(line);
    };

    const sendSnapshot = (subagentId: string) => {
      const snapshot = view.get(subagentId);
      if (!snapshot) {
        write(errorMessage("not_found", "Subagent is no longer tracked."));
        return;
      }
      write({
        version: MIRROR_PROTOCOL_VERSION,
        type: "snapshot",
        snapshot,
      });
    };

    const scheduleSnapshot = (subagentId: string) => {
      if (snapshotTimer) return;
      snapshotTimer = setTimeout(() => {
        snapshotTimer = undefined;
        sendSnapshot(subagentId);
      }, 50);
    };

    const failAndClose = (
      code: Extract<BridgeMessage, { type: "error" }>["code"],
      message: string,
    ) => {
      write(errorMessage(code, message));
      socket.end();
    };

    const writeActionResult = (
      requestId: string,
      ok: boolean,
      error?: string,
    ) => {
      write({
        version: MIRROR_PROTOCOL_VERSION,
        type: "actionResult",
        requestId,
        ok,
        ...(error === undefined ? {} : { error }),
      });
    };

    const handleAction = (
      subagentId: string,
      message: Extract<
        ReturnType<typeof parseViewerMessage>,
        { type: "action" }
      >,
    ) => {
      if (pendingActions >= maxPendingActions) {
        failAndClose("unsupported", "Too many queued mirror actions.");
        return;
      }
      pendingActions++;
      actionQueue = actionQueue
        .then(async () => {
          if (socket.destroyed) return;
          if (!options.actions) {
            writeActionResult(
              message.requestId,
              false,
              "This mirror is read-only.",
            );
            return;
          }
          try {
            if (message.action === "send") {
              await options.actions.send(subagentId, message.text);
            } else if (message.action === "abort") {
              await options.actions.abort(subagentId);
            } else {
              await options.actions.focusParent();
            }
            writeActionResult(message.requestId, true);
          } catch (error) {
            writeActionResult(
              message.requestId,
              false,
              (error instanceof Error ? error.message : String(error)).slice(
                0,
                4_096,
              ),
            );
          }
        })
        .finally(() => {
          pendingActions--;
        });
    };

    socket.setTimeout(authTimeoutMs, () => {
      failAndClose("unauthorized", "Viewer did not authenticate in time.");
    });

    socket.on("drain", () => {
      waitingForDrain = false;
      if (pendingSnapshot) {
        const line = pendingSnapshot;
        pendingSnapshot = undefined;
        waitingForDrain = !socket.write(line);
      }
    });

    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_VIEWER_MESSAGE_BYTES) {
        failAndClose("oversized", "Viewer message exceeds the bridge limit.");
        return;
      }
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let decoded: unknown;
        try {
          decoded = JSON.parse(line);
        } catch {
          failAndClose("malformed", "Expected one JSON message per line.");
          return;
        }
        const message = parseViewerMessage(decoded);
        if (!message) {
          failAndClose("malformed", "Invalid mirror protocol message.");
          return;
        }
        if (!attachedSubagentId) {
          if (message.type !== "attach") {
            failAndClose("unauthorized", "Attach before sending actions.");
            return;
          }
          if (!tokensMatch(message.token, credentialFor(message.subagentId))) {
            failAndClose("unauthorized", "Mirror credential was rejected.");
            return;
          }
          if (!view.get(message.subagentId)) {
            failAndClose("not_found", "Unknown subagent.");
            return;
          }
          const subagentId = message.subagentId;
          attachedSubagentId = subagentId;
          socket.setTimeout(0);
          sendSnapshot(subagentId);
          unsubscribe = view.subscribeTo(subagentId, () =>
            scheduleSnapshot(subagentId),
          );
        } else if (message.type === "action") {
          handleAction(attachedSubagentId, message);
        } else {
          failAndClose("malformed", "Viewer is already attached.");
          return;
        }
      }
    });

    const cleanup = () => {
      unsubscribe?.();
      unsubscribe = undefined;
      if (snapshotTimer) clearTimeout(snapshotTimer);
      snapshotTimer = undefined;
      sockets.delete(socket);
    };
    socket.once("close", cleanup);
    socket.once("error", cleanup);
  });

  let ownsSocket = false;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.off("error", reject);
        ownsSocket = true;
        resolve();
      });
    });
    await chmod(socketPath, 0o600);
  } catch (error) {
    if (server.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (ownsSocket) await unlink(socketPath).catch(() => undefined);
    if (ownsDirectory) await rm(directory, { recursive: true, force: true });
    throw error;
  }

  let closed = false;
  return {
    socketPath,
    credentialFor,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(socketPath).catch(() => undefined);
      if (ownsDirectory) await rm(directory, { recursive: true, force: true });
    },
  };
}

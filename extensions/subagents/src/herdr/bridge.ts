import { timingSafeEqual, randomBytes } from "node:crypto";
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
  readonly token: string;
}

export interface MirrorBridge extends MirrorBridgeEndpoint {
  close(): Promise<void>;
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
  options: { readonly baseDir?: string } = {},
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
  const token = randomBytes(32).toString("base64url");
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let attached = false;
    let unsubscribe: (() => void) | undefined;
    let pendingSnapshot: string | undefined;
    let waitingForDrain = false;

    const write = (message: BridgeMessage) => {
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

    socket.on("drain", () => {
      waitingForDrain = false;
      if (pendingSnapshot) {
        const line = pendingSnapshot;
        pendingSnapshot = undefined;
        waitingForDrain = !socket.write(line);
      }
    });

    socket.on("data", (chunk) => {
      if (
        buffer.length + Buffer.byteLength(chunk, "utf8") >
        MAX_VIEWER_MESSAGE_BYTES
      ) {
        write(
          errorMessage("oversized", "Viewer message exceeds the bridge limit."),
        );
        socket.end();
        return;
      }
      buffer += chunk;
      while (!attached) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let decoded: unknown;
        try {
          decoded = JSON.parse(line);
        } catch {
          write(
            errorMessage("malformed", "Expected one JSON message per line."),
          );
          socket.end();
          return;
        }
        const message = parseViewerMessage(decoded);
        if (!message) {
          write(errorMessage("malformed", "Invalid mirror protocol message."));
          socket.end();
          return;
        }
        if (!tokensMatch(message.token, token)) {
          write(
            errorMessage("unauthorized", "Mirror credential was rejected."),
          );
          socket.end();
          return;
        }
        if (!view.get(message.subagentId)) {
          write(errorMessage("not_found", "Unknown subagent."));
          socket.end();
          return;
        }
        attached = true;
        sendSnapshot(message.subagentId);
        unsubscribe = view.subscribeTo(message.subagentId, () =>
          sendSnapshot(message.subagentId),
        );
        // Read-only protocol v1 ignores any bytes after the attach line.
        buffer = "";
      }
    });

    const cleanup = () => {
      unsubscribe?.();
      unsubscribe = undefined;
      sockets.delete(socket);
    };
    socket.once("close", cleanup);
    socket.once("error", cleanup);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600);

  let closed = false;
  return {
    socketPath,
    token,
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

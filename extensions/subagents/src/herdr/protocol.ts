import type { SubagentSnapshot } from "../domain.ts";

export const MIRROR_PROTOCOL_VERSION = 1;
export const MAX_VIEWER_MESSAGE_BYTES = 64 * 1024;
export const MAX_SNAPSHOT_MESSAGE_BYTES = 48 * 1024 * 1024;

export interface AttachMessage {
  readonly version: 1;
  readonly type: "attach";
  readonly token: string;
  readonly subagentId: string;
}

export interface SnapshotMessage {
  readonly version: 1;
  readonly type: "snapshot";
  readonly snapshot: SubagentSnapshot;
}

export interface ProtocolErrorMessage {
  readonly version: 1;
  readonly type: "error";
  readonly code: "malformed" | "unauthorized" | "not_found" | "oversized";
  readonly message: string;
}

export type ViewerMessage = AttachMessage;
export type BridgeMessage = SnapshotMessage | ProtocolErrorMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseViewerMessage(value: unknown): ViewerMessage | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.version !== MIRROR_PROTOCOL_VERSION ||
    value.type !== "attach" ||
    typeof value.token !== "string" ||
    typeof value.subagentId !== "string" ||
    value.token.length < 1 ||
    value.token.length > 256 ||
    value.subagentId.length < 1 ||
    value.subagentId.length > 160
  ) {
    return undefined;
  }
  return {
    version: MIRROR_PROTOCOL_VERSION,
    type: "attach",
    token: value.token,
    subagentId: value.subagentId,
  };
}

export function encodeBridgeMessage(message: BridgeMessage) {
  const line = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_SNAPSHOT_MESSAGE_BYTES) {
    throw new Error("Normalized subagent snapshot exceeds the bridge limit.");
  }
  return line;
}

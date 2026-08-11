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

export type ActionMessage =
  | {
      readonly version: 1;
      readonly type: "action";
      readonly requestId: string;
      readonly action: "send";
      readonly text: string;
    }
  | {
      readonly version: 1;
      readonly type: "action";
      readonly requestId: string;
      readonly action: "abort" | "focus-parent";
    };

export interface SnapshotMessage {
  readonly version: 1;
  readonly type: "snapshot";
  readonly snapshot: SubagentSnapshot;
}

export interface ActionResultMessage {
  readonly version: 1;
  readonly type: "actionResult";
  readonly requestId: string;
  readonly ok: boolean;
  readonly error?: string;
}

export interface ProtocolErrorMessage {
  readonly version: 1;
  readonly type: "error";
  readonly code:
    "malformed" | "unauthorized" | "not_found" | "oversized" | "unsupported";
  readonly message: string;
}

export type ViewerMessage = AttachMessage | ActionMessage;
export type BridgeMessage =
  SnapshotMessage | ActionResultMessage | ProtocolErrorMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown) {
  return value === undefined || typeof value === "string";
}

function isOptionalNumber(value: unknown) {
  return value === undefined || typeof value === "number";
}

function isTranscriptPart(value: unknown) {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "text") return typeof value.text === "string";
  if (value.type === "thinking") {
    return (
      typeof value.text === "string" &&
      (value.redacted === undefined || typeof value.redacted === "boolean")
    );
  }
  return (
    value.type === "toolCall" &&
    typeof value.toolId === "string" &&
    typeof value.name === "string" &&
    isOptionalString(value.argsPreview)
  );
}

function isTranscriptItem(value: unknown) {
  if (!isRecord(value)) return false;
  if (value.kind === "user") return typeof value.text === "string";
  if (value.kind === "assistant") {
    return Array.isArray(value.parts) && value.parts.every(isTranscriptPart);
  }
  return (
    value.kind === "toolResult" &&
    typeof value.toolId === "string" &&
    typeof value.name === "string" &&
    typeof value.isError === "boolean" &&
    isOptionalString(value.outputPreview)
  );
}

function isSubagentSnapshot(value: unknown): value is SubagentSnapshot {
  if (!isRecord(value) || !isRecord(value.meta) || !isRecord(value.usage)) {
    return false;
  }
  const validLiveAssistant =
    value.liveAssistant === undefined ||
    (isRecord(value.liveAssistant) &&
      typeof value.liveAssistant.text === "string" &&
      typeof value.liveAssistant.thinking === "string");
  const validLiveTools =
    Array.isArray(value.liveTools) &&
    value.liveTools.every(
      (tool) =>
        isRecord(tool) &&
        typeof tool.toolId === "string" &&
        typeof tool.name === "string" &&
        isOptionalString(tool.argsPreview) &&
        isOptionalString(tool.outputPreview) &&
        (tool.done === undefined || typeof tool.done === "boolean") &&
        (tool.isError === undefined || typeof tool.isError === "boolean"),
    );
  const validQueue =
    Array.isArray(value.queued) &&
    value.queued.every(
      (message) =>
        isRecord(message) &&
        typeof message.text === "string" &&
        (message.kind === "steer" || message.kind === "follow-up"),
    );
  return (
    typeof value.id === "string" &&
    (value.origin === "model" || value.origin === "btw") &&
    (value.backend === "pi" ||
      value.backend === "claude" ||
      value.backend === "codex") &&
    typeof value.title === "string" &&
    typeof value.prompt === "string" &&
    typeof value.cwd === "string" &&
    (value.status === "running" ||
      value.status === "done" ||
      value.status === "error") &&
    typeof value.createdAt === "number" &&
    isOptionalNumber(value.settledAt) &&
    isOptionalString(value.errorText) &&
    value.meta.backend === value.backend &&
    isOptionalString(value.meta.modelLabel) &&
    isOptionalNumber(value.meta.contextWindow) &&
    isOptionalString(value.meta.sessionFilePath) &&
    isOptionalString(value.meta.nativeSessionId) &&
    isOptionalNumber(value.usage.tokens) &&
    isOptionalNumber(value.usage.contextWindow) &&
    Array.isArray(value.transcript) &&
    value.transcript.every(isTranscriptItem) &&
    validLiveAssistant &&
    validLiveTools &&
    validQueue &&
    typeof value.finalText === "string" &&
    typeof value.turns === "number"
  );
}

export function parseViewerMessage(value: unknown): ViewerMessage | undefined {
  if (!isRecord(value) || value.version !== MIRROR_PROTOCOL_VERSION) {
    return undefined;
  }
  if (value.type === "attach") {
    if (
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
  if (
    value.type !== "action" ||
    typeof value.requestId !== "string" ||
    value.requestId.length < 1 ||
    value.requestId.length > 128 ||
    (value.action !== "send" &&
      value.action !== "abort" &&
      value.action !== "focus-parent")
  ) {
    return undefined;
  }
  if (value.action === "send") {
    if (
      typeof value.text !== "string" ||
      value.text.trim().length === 0 ||
      Buffer.byteLength(value.text, "utf8") > 32 * 1024
    ) {
      return undefined;
    }
    return {
      version: MIRROR_PROTOCOL_VERSION,
      type: "action",
      requestId: value.requestId,
      action: "send",
      text: value.text,
    };
  }
  return {
    version: MIRROR_PROTOCOL_VERSION,
    type: "action",
    requestId: value.requestId,
    action: value.action,
  };
}

export function parseBridgeMessage(value: unknown): BridgeMessage | undefined {
  if (!isRecord(value) || value.version !== MIRROR_PROTOCOL_VERSION) {
    return undefined;
  }
  if (value.type === "snapshot" && isSubagentSnapshot(value.snapshot)) {
    return {
      version: MIRROR_PROTOCOL_VERSION,
      type: "snapshot",
      snapshot: value.snapshot,
    };
  }
  if (
    value.type === "actionResult" &&
    typeof value.requestId === "string" &&
    typeof value.ok === "boolean" &&
    isOptionalString(value.error)
  ) {
    return {
      version: MIRROR_PROTOCOL_VERSION,
      type: "actionResult",
      requestId: value.requestId,
      ok: value.ok,
      ...(value.error === undefined ? {} : { error: value.error }),
    };
  }
  const isErrorCode = (code: unknown): code is ProtocolErrorMessage["code"] =>
    code === "malformed" ||
    code === "unauthorized" ||
    code === "not_found" ||
    code === "oversized" ||
    code === "unsupported";
  if (
    value.type === "error" &&
    isErrorCode(value.code) &&
    typeof value.message === "string"
  ) {
    return {
      version: MIRROR_PROTOCOL_VERSION,
      type: "error",
      code: value.code,
      message: value.message,
    };
  }
  return undefined;
}

export function encodeBridgeMessage(message: BridgeMessage) {
  const line = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_SNAPSHOT_MESSAGE_BYTES) {
    throw new Error("Normalized subagent snapshot exceeds the bridge limit.");
  }
  return line;
}

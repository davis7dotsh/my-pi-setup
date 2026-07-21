import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const TOOL_ARGUMENT_MAX_BYTES = 2_000;
export const TOOL_RESULT_MAX_BYTES = 5_000;
export const TRANSCRIPT_MAX_BYTES = 48_000;

const SECRET_KEY_PATTERN =
  /(?:api[_-]?key|access[_-]?key|authorization|cookie|credential|password|passwd|private[_-]?key|secret|token)/i;

export interface RunMarker {
  readonly baselineLeafId: string | null;
}

export function createRunBoundary() {
  let pending: RunMarker | undefined;

  return {
    begin(baselineLeafId: string | null) {
      pending = { baselineLeafId };
    },
    settle() {
      const run = pending;
      pending = undefined;
      return run;
    },
    reset() {
      pending = undefined;
    },
  };
}

export function getRunEntries(
  branch: readonly SessionEntry[],
  baselineLeafId: string | null,
) {
  if (baselineLeafId === null) return [...branch];
  const baselineIndex = branch.findIndex(
    (entry) => entry.id === baselineLeafId,
  );
  return baselineIndex === -1 ? [] : branch.slice(baselineIndex + 1);
}

function truncateUtf8(text: string, maxBytes: number) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, midpoint), "utf8") <= maxBytes) {
      low = midpoint;
    } else {
      high = midpoint - 1;
    }
  }

  let end = low;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function capped(text: string, maxBytes: number, notice: string) {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffix = `\n[${notice}]`;
  return `${truncateUtf8(text, maxBytes - Buffer.byteLength(suffix, "utf8"))}${suffix}`;
}

export function redactSecrets(text: string) {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(
      /\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,})\b/g,
      "[REDACTED]",
    )
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?key|authorization|cookie|credential|password|passwd|private[_-]?key|secret|token)["']?\s*[:=]\s*)(["']?)[^\s,;}]+\2/gi,
      "$1[REDACTED]",
    )
    .replace(
      /([?&](?:api[_-]?key|access[_-]?token|key|secret|token)=)[^&#\s]+/gi,
      "$1[REDACTED]",
    );
}

function sanitizeValue(value: unknown, key?: string, depth = 0): unknown {
  if (key && SECRET_KEY_PATTERN.test(key)) return "[REDACTED]";
  if (depth >= 6) return "[nested value omitted]";
  if (typeof value === "string") return redactSecrets(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "function" || typeof value === "symbol") {
    return `[${typeof value} omitted]`;
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, 30)
      .map((item) => sanitizeValue(item, undefined, depth + 1));
    if (value.length > items.length) items.push("[additional items omitted]");
    return items;
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        sanitizeValue(entryValue, entryKey, depth + 1),
      ]),
    );
  }
  return value;
}

function serializeToolArguments(value: unknown) {
  try {
    return JSON.stringify(sanitizeValue(value), null, 2) ?? "(no arguments)";
  } catch {
    return "[tool arguments could not be serialized]";
  }
}

function textContent(content: unknown) {
  if (typeof content === "string") return redactSecrets(content);
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
      ) {
        return [redactSecrets(block.text)];
      }
      return [];
    })
    .join("\n");
}

function serializeMessage(entry: Extract<SessionEntry, { type: "message" }>) {
  const { message } = entry;

  if (message.role === "user") {
    const text = textContent(message.content);
    return text ? `USER\n${text}` : "";
  }

  if (message.role === "assistant") {
    const sections: string[] = [];
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => redactSecrets(block.text))
      .join("\n");
    if (text) sections.push(`ASSISTANT\n${text}`);

    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      const args = capped(
        redactSecrets(serializeToolArguments(block.arguments)),
        TOOL_ARGUMENT_MAX_BYTES,
        "tool arguments capped",
      );
      sections.push(`TOOL CALL ${block.name}\n${args}`);
    }
    return sections.join("\n\n");
  }

  if (message.role === "toolResult") {
    const text = capped(
      textContent(message.content),
      TOOL_RESULT_MAX_BYTES,
      "tool result capped",
    );
    return `TOOL RESULT ${message.toolName}${message.isError ? " (error)" : ""}\n${text || "(no text output)"}`;
  }

  if (message.role === "bashExecution") {
    const command = capped(
      redactSecrets(message.command),
      TOOL_ARGUMENT_MAX_BYTES,
      "command capped",
    );
    const output = capped(
      redactSecrets(message.output),
      TOOL_RESULT_MAX_BYTES,
      "command output capped",
    );
    return `USER SHELL${message.exitCode === undefined ? "" : ` (exit ${message.exitCode})`}\n${command}\n${output}`;
  }

  if (message.role === "custom") {
    if (message.customType === "summary-recap") return "";
    const text = textContent(message.content);
    return text ? `EXTENSION ${message.customType}\n${text}` : "";
  }

  return "";
}

export function serializeRunTranscript(
  entries: readonly SessionEntry[],
  maxBytes = TRANSCRIPT_MAX_BYTES,
) {
  const sections = entries.flatMap((entry) => {
    if (entry.type === "message") {
      const section = serializeMessage(entry);
      return section ? [section] : [];
    }
    if (
      entry.type === "custom_message" &&
      entry.customType !== "summary-recap"
    ) {
      const text = textContent(entry.content);
      return text ? [`EXTENSION ${entry.customType}\n${text}`] : [];
    }
    return [];
  });

  const transcript = sections.join("\n\n---\n\n") || "(no textual run output)";
  if (Buffer.byteLength(transcript, "utf8") <= maxBytes) return transcript;

  const marker = "\n\n[... transcript capped; middle omitted ...]\n\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const headBytes = Math.floor((maxBytes - markerBytes) * 0.58);
  const tailBytes = maxBytes - markerBytes - headBytes;
  const head = truncateUtf8(transcript, headBytes);
  const reversedTail = truncateUtf8(
    [...transcript].reverse().join(""),
    tailBytes,
  );
  const tail = [...reversedTail].reverse().join("");
  return `${head}${marker}${tail}`;
}

export function buildFallbackRecap(entries: readonly SessionEntry[]) {
  const toolNames: string[] = [];
  let finalAssistantText = "";

  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "assistant")
      continue;
    for (const block of entry.message.content) {
      if (block.type === "toolCall") toolNames.push(block.name);
      if (block.type === "text" && block.text.trim()) {
        finalAssistantText = redactSecrets(block.text.trim());
      }
    }
  }

  const tools = [...new Set(toolNames)];
  const activity =
    tools.length > 0
      ? ` The run used ${toolNames.length} tool call${toolNames.length === 1 ? "" : "s"} across ${tools.join(", ")}.`
      : "";
  const result = finalAssistantText
    ? ` ${capped(finalAssistantText.replace(/\s+/g, " "), 700, "final response capped")}`
    : "";

  return {
    recap: `The main-agent run completed.${activity}${result}`.trim(),
    next: "Review the completed work above and continue if anything remains.",
  };
}

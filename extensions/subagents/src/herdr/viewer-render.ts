import type { SubagentSnapshot, TranscriptPart } from "../domain.ts";

function clean(text: string) {
  return text
    .replace(
      // eslint-disable-next-line no-control-regex
      /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
      "",
    )
    .replaceAll("\t", "  ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

function wrap(text: string, width: number) {
  const lines: string[] = [];
  for (const sourceLine of clean(text).split("\n")) {
    let remaining = sourceLine;
    if (!remaining) {
      lines.push("");
      continue;
    }
    while (remaining.length > width) {
      let split = remaining.lastIndexOf(" ", width);
      if (split < Math.floor(width / 2)) split = width;
      lines.push(remaining.slice(0, split));
      remaining = remaining.slice(split).trimStart();
    }
    lines.push(remaining);
  }
  return lines;
}

function partLines(part: TranscriptPart, width: number) {
  if (part.type === "toolCall") {
    return wrap(
      `→ ${part.name}${part.argsPreview && part.argsPreview !== "{}" ? ` ${part.argsPreview}` : ""}`,
      width,
    );
  }
  const prefix = part.type === "thinking" ? "~ " : "";
  const text =
    part.type === "thinking" && part.redacted
      ? "[redacted reasoning]"
      : part.text;
  return wrap(`${prefix}${text}`, width);
}

function utilization(snapshot: SubagentSnapshot) {
  const tokens = snapshot.usage.tokens;
  const window = snapshot.usage.contextWindow;
  if (tokens === undefined || window === undefined || window <= 0) return "";
  return `${Math.max(0, Math.min(100, Math.round((tokens / window) * 100)))}% context`;
}

function status(snapshot: SubagentSnapshot) {
  if (snapshot.status === "error") return "failed";
  return snapshot.status;
}

export function renderMirrorFrame(
  snapshot: SubagentSnapshot,
  options: {
    readonly columns: number;
    readonly rows: number;
    readonly input: string;
  },
) {
  const width = Math.max(20, options.columns);
  const divider = "─".repeat(width);
  const headerDetails = [
    status(snapshot),
    snapshot.backend,
    snapshot.meta.modelLabel ?? "?",
    utilization(snapshot),
  ].filter(Boolean);
  const lines = [
    divider,
    `${snapshot.id} · ${snapshot.title} · ${headerDetails.join(" · ")}`.slice(
      0,
      width,
    ),
    divider,
  ];

  if (snapshot.errorText) lines.push(`error: ${clean(snapshot.errorText)}`);
  for (const item of snapshot.transcript) {
    if (item.kind === "user") {
      lines.push(...wrap(`> ${item.text}`, width));
    } else if (item.kind === "assistant") {
      for (const part of item.parts) lines.push(...partLines(part, width));
    } else {
      lines.push(
        ...wrap(
          `← ${item.name}${item.isError ? " error" : ""}: ${item.outputPreview ?? "(no output)"}`,
          width,
        ),
      );
    }
  }
  if (snapshot.liveAssistant?.thinking) {
    lines.push(...wrap(`~ ${snapshot.liveAssistant.thinking}`, width));
  }
  if (snapshot.liveAssistant?.text) {
    lines.push(...wrap(snapshot.liveAssistant.text, width));
  }
  for (const tool of snapshot.liveTools) {
    lines.push(
      ...wrap(
        `${tool.name} · ${tool.done ? (tool.isError ? "error" : "done") : "running"}${tool.outputPreview ? ` · ${tool.outputPreview}` : ""}`,
        width,
      ),
    );
  }
  for (const queued of snapshot.queued) {
    lines.push(...wrap(`> [queued ${queued.kind}] ${queued.text}`, width));
  }

  const footer = [
    divider,
    `> ${clean(options.input)}`.slice(0, width),
    "Enter send · Ctrl-X abort · Ctrl-P parent · Ctrl-D close mirror".slice(
      0,
      width,
    ),
  ];
  const bodyCapacity = Math.max(1, options.rows - footer.length - 3);
  const body = lines.slice(3);
  return [...lines.slice(0, 3), ...body.slice(-bodyCapacity), ...footer];
}

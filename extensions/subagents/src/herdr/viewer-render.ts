import type { SubagentSnapshot, TranscriptPart } from "../domain.ts";

export function sanitizeTerminalText(text: string) {
  return text
    .replace(
      // eslint-disable-next-line no-control-regex
      /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
      "",
    )
    .replaceAll("\t", "  ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

const clean = sanitizeTerminalText;

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function graphemes(text: string) {
  return [...graphemeSegmenter.segment(text)].map(({ segment }) => segment);
}

function graphemeWidth(grapheme: string) {
  if (/^\p{Mark}+$/u.test(grapheme)) return 0;
  if (/\p{Extended_Pictographic}/u.test(grapheme)) return 2;
  const point = grapheme.codePointAt(0) ?? 0;
  return (point >= 0x1100 && point <= 0x115f) ||
    (point >= 0x2e80 && point <= 0xa4cf) ||
    (point >= 0xac00 && point <= 0xd7a3) ||
    (point >= 0xf900 && point <= 0xfaff) ||
    (point >= 0xfe10 && point <= 0xfe6f) ||
    (point >= 0xff00 && point <= 0xff60) ||
    (point >= 0xffe0 && point <= 0xffe6)
    ? 2
    : 1;
}

function displayWidth(text: string) {
  return graphemes(text).reduce(
    (total, grapheme) => total + graphemeWidth(grapheme),
    0,
  );
}

function truncateDisplay(text: string, width: number) {
  let used = 0;
  const kept: string[] = [];
  for (const grapheme of graphemes(clean(text))) {
    const next = used + graphemeWidth(grapheme);
    if (next > width) break;
    kept.push(grapheme);
    used = next;
  }
  return kept.join("");
}

function wrap(text: string, width: number) {
  const lines: string[] = [];
  for (const sourceLine of clean(text).split("\n")) {
    let remaining = graphemes(sourceLine);
    if (remaining.length === 0) {
      lines.push("");
      continue;
    }
    while (displayWidth(remaining.join("")) > width) {
      let used = 0;
      let count = 0;
      while (count < remaining.length) {
        const next = used + graphemeWidth(remaining[count]);
        if (next > width) break;
        used = next;
        count++;
      }
      let lastSpace = -1;
      for (let index = 0; index < count; index++) {
        if (/^\s$/u.test(remaining[index])) lastSpace = index;
      }
      const split = lastSpace >= Math.floor(count / 2) ? lastSpace : count;
      lines.push(remaining.slice(0, split).join("").trimEnd());
      remaining = remaining.slice(split);
      while (remaining[0] && /^\s$/u.test(remaining[0])) remaining.shift();
    }
    lines.push(remaining.join(""));
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
    readonly notice?: string;
  },
) {
  const width = Math.max(20, options.columns);
  const divider = "─".repeat(width);
  const headerDetails = [
    status(snapshot),
    snapshot.backend,
    snapshot.meta.modelLabel ?? "?",
    utilization(snapshot),
  ]
    .map(clean)
    .filter(Boolean);
  const lines = [
    divider,
    truncateDisplay(
      `${clean(snapshot.id)} · ${clean(snapshot.title)} · ${headerDetails.join(" · ")}`,
      width,
    ),
    divider,
  ];

  const pinnedCapacity = Math.max(1, Math.min(3, options.rows - 6));
  const pinned = snapshot.errorText
    ? wrap(`error: ${snapshot.errorText}`, width).slice(0, pinnedCapacity)
    : [];
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
    truncateDisplay(`> ${options.input}`, width),
    truncateDisplay(
      [
        options.notice,
        "Enter send · Ctrl-X abort · Ctrl-P parent · Ctrl-D close mirror",
      ]
        .filter(Boolean)
        .join(" · "),
      width,
    ),
  ];
  const bodyCapacity = Math.max(
    0,
    options.rows - footer.length - 3 - pinned.length,
  );
  const body = lines.slice(3);
  const visibleBody = bodyCapacity > 0 ? body.slice(-bodyCapacity) : [];
  return [...lines.slice(0, 3), ...pinned, ...visibleBody, ...footer];
}

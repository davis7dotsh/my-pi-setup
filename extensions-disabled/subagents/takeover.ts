/**
 * Takeover UI for subagents:
 * - SubagentDashboard: full popup (overlay) with an agent list on the left and
 *   live details/transcript of the selected agent on the right.
 * - TakeoverView: full interactive view of one subagent session with an input
 *   line to steer/continue it.
 */

import type {
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type {
  AgentSessionEvent,
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI } from "@earendil-works/pi-tui";
import {
  Input,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { formatContextUtilization } from "../shared/context-utilization.ts";
import {
  activeModel,
  contextUsage,
  formatElapsed,
  messageRole,
  type Subagent,
  type SubagentManager,
} from "./manager.ts";

function configuredKeys(
  keybindings: KeybindingsManager,
  binding: Parameters<KeybindingsManager["getKeys"]>[0],
) {
  return keybindings.getKeys(binding).join("/") || "unbound";
}

function statusGlyph(sub: Subagent, theme: Theme): string {
  switch (sub.status) {
    case "running":
      return theme.fg("warning", "■");
    case "done":
      return theme.fg("success", "■");
    case "error":
      return theme.fg("error", "■");
  }
}

function statusWord(sub: Subagent, theme: Theme): string {
  switch (sub.status) {
    case "running":
      return theme.fg("warning", "running");
    case "done":
      return theme.fg("success", "done");
    case "error":
      return theme.fg("error", "failed");
  }
}

// --- Shared transcript rendering -------------------------------------------

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/**
 * Strip raw ANSI codes, expand tabs, and drop control chars from message text.
 * Terminal-expanded tabs (and stray escapes) make lines wider than the width
 * we declare to the TUI, which desyncs the renderer and smears the overlay.
 */
function sanitizeText(text: string): string {
  return text
    .replace(ANSI_PATTERN, "")
    .replaceAll("\t", "  ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

function liveToolPreview(value: unknown): string | undefined {
  if (typeof value === "string") {
    return sanitizeText(value)
      .split("\n")
      .find((line) => line.trim())
      ?.trim();
  }
  if (!value || typeof value !== "object") return undefined;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as { type?: unknown; text?: unknown };
    if (record.type !== "text" || typeof record.text !== "string") continue;
    const firstLine = sanitizeText(record.text)
      .split("\n")
      .find((line) => line.trim());
    if (firstLine) return firstLine.trim();
  }
  return undefined;
}

function renderUserMessage(
  theme: Theme,
  msg: UserMessage,
  width: number,
  out: string[],
) {
  const text = sanitizeText(
    typeof msg.content === "string"
      ? msg.content
      : msg.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
  );
  if (!text.trim()) return;
  const wrapped = wrapTextWithAnsi(text.trim(), Math.max(10, width - 2));
  for (let i = 0; i < wrapped.length; i++) {
    const prefix = i === 0 ? theme.fg("accent", "> ") : "  ";
    out.push(
      truncateToWidth(prefix + theme.fg("userMessageText", wrapped[i]), width),
    );
  }
}

function renderAssistantMessage(
  theme: Theme,
  msg: AssistantMessage,
  width: number,
  out: string[],
) {
  for (const part of msg.content) {
    if (part.type === "text") {
      const text = sanitizeText(part.text).trim();
      if (!text) continue;
      out.push(...wrapTextWithAnsi(text, width));
    } else if (part.type === "thinking") {
      const reasoning = part.redacted
        ? "[redacted reasoning]"
        : sanitizeText(part.thinking).trim();
      if (!reasoning) continue;
      const prefix = theme.fg("dim", "~ ");
      const wrapped = wrapTextWithAnsi(reasoning, Math.max(10, width - 2));
      for (let i = 0; i < wrapped.length; i++) {
        out.push(
          truncateToWidth(
            (i === 0 ? prefix : "  ") +
              theme.fg("muted", theme.italic(wrapped[i])),
            width,
          ),
        );
      }
    } else if (part.type === "toolCall") {
      let preview = "";
      try {
        preview = sanitizeText(JSON.stringify(part.arguments));
      } catch {
        preview = "";
      }
      const line =
        theme.fg("muted", "→ ") +
        theme.fg("toolTitle", part.name) +
        (preview && preview !== "{}" ? theme.fg("dim", ` ${preview}`) : "");
      out.push(truncateToWidth(line, width));
    }
  }
}

function renderToolResultMessage(
  theme: Theme,
  msg: ToolResultMessage,
  width: number,
  out: string[],
) {
  const text = sanitizeText(
    msg.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
  );
  const firstLine = text.split("\n").find((line) => line.trim()) ?? "";
  const label = msg.isError
    ? theme.fg("error", "  error: ")
    : theme.fg("dim", "  output: ");
  out.push(
    truncateToWidth(label + theme.fg("dim", firstLine || "(no output)"), width),
  );
}

interface LiveToolEvent {
  id: string;
  name: string;
  args: Record<string, unknown>;
  preview?: string;
  done?: boolean;
  isError?: boolean;
}

interface LiveTranscriptState {
  assistant?: AssistantMessage;
  tools?: readonly LiveToolEvent[];
}

/** Render a subagent's conversation as plain lines, wrapped to `width`. */
export function buildTranscriptLines(
  sub: Subagent,
  width: number,
  theme: Theme,
  live?: LiveTranscriptState,
): string[] {
  const messages: unknown[] = [...sub.session.messages];
  const streaming = live?.assistant ?? sub.session.agent.state.streamingMessage;
  if (streaming) {
    const timestamp = (streaming as { timestamp?: number }).timestamp;
    const alreadyPersisted = messages.some(
      (message) =>
        message === streaming ||
        (timestamp !== undefined &&
          messageRole(message) === "assistant" &&
          (message as { timestamp?: number }).timestamp === timestamp),
    );
    if (!alreadyPersisted) messages.push(streaming);
  }

  const out: string[] = [];
  for (const msg of messages) {
    const before = out.length;
    const role = messageRole(msg);
    if (role === "user") {
      renderUserMessage(theme, msg as UserMessage, width, out);
    } else if (role === "assistant") {
      renderAssistantMessage(theme, msg as AssistantMessage, width, out);
    } else if (role === "toolResult") {
      renderToolResultMessage(theme, msg as ToolResultMessage, width, out);
    }
    if (out.length > before) out.push("");
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();

  // Tool execution updates are not represented in session.messages until the
  // final tool result arrives. Render their live state while this view is open.
  for (const tool of live?.tools ?? []) {
    if (out.length > 0) out.push("");
    const marker = tool.done
      ? tool.isError
        ? theme.fg("error", "error")
        : theme.fg("success", "done")
      : theme.fg("warning", "running");
    let line = `${theme.fg("toolTitle", tool.name)} · ${marker}`;
    if (tool.preview) line += theme.fg("dim", ` · ${tool.preview}`);
    out.push(truncateToWidth(line, width));
  }

  // Steering/follow-up messages are not added to session.messages until the
  // agent reaches a delivery point. Show them immediately so Enter visibly
  // acknowledges the user's input instead of appearing to do nothing.
  const queued = [
    ...sub.session
      .getSteeringMessages()
      .map((text) => ({ text, kind: "steer" })),
    ...sub.session
      .getFollowUpMessages()
      .map((text) => ({ text, kind: "follow-up" })),
  ];
  for (const message of queued) {
    if (out.length > 0) out.push("");
    const prefix = theme.fg("warning", `> [queued ${message.kind}] `);
    const wrapped = wrapTextWithAnsi(
      sanitizeText(message.text),
      Math.max(10, width - visibleWidth(prefix)),
    );
    for (let i = 0; i < wrapped.length; i++) {
      out.push(
        truncateToWidth(
          (i === 0 ? prefix : " ".repeat(visibleWidth(prefix))) +
            theme.fg("muted", wrapped[i]),
          width,
        ),
      );
    }
  }

  return out;
}

// --- Entry point -------------------------------------------------------------

export async function openSubagentPicker(
  ctx: ExtensionCommandContext,
  manager: SubagentManager,
) {
  while (true) {
    if (manager.size() === 0) {
      ctx.ui.notify("No subagents", "info");
      return;
    }

    const picked = await ctx.ui.custom<string | null>(
      (tui, theme, keybindings, done) =>
        new SubagentDashboard(tui, theme, keybindings, manager, done),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
      },
    );

    if (!picked) return;
    const sub = manager.get(picked);
    if (!sub) continue;

    await ctx.ui.custom<null>(
      (tui, theme, keybindings, done) =>
        new TakeoverView(tui, theme, keybindings, sub, manager, done),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
      },
    );
    // After leaving the takeover view, fall back to the dashboard.
  }
}

// --- Dashboard (fullscreen overlay) -------------------------------------------

class SubagentDashboard implements Component {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private manager: SubagentManager;
  private done: (value: string | null) => void;

  private selected = 0;
  private closed = false;
  private ticker: ReturnType<typeof setInterval>;
  private unsubChange: () => void;

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    manager: SubagentManager,
    done: (value: string | null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.manager = manager;
    this.done = done;
    // Elapsed times, token counts, and statuses tick along at 1Hz.
    this.ticker = setInterval(() => this.tui.requestRender(), 1000);
    this.unsubChange = manager.addChangeListener(() =>
      this.tui.requestRender(),
    );
  }

  private subs(): Subagent[] {
    return this.manager.list();
  }

  private clampSelection() {
    const count = this.subs().length;
    if (this.selected >= count) this.selected = Math.max(0, count - 1);
    if (this.selected < 0) this.selected = 0;
  }

  private close(result: string | null) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ticker);
    this.unsubChange();
    this.done(result);
  }

  handleInput(data: string): void {
    this.clampSelection();
    const subs = this.subs();

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close(null);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const sub = subs[this.selected];
      if (sub) this.close(sub.id);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      if (subs.length > 0) {
        this.selected = (this.selected - 1 + subs.length) % subs.length;
        this.tui.requestRender();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      if (subs.length > 0) {
        this.selected = (this.selected + 1) % subs.length;
        this.tui.requestRender();
      }
      return;
    }
    if (data === "x") {
      const sub = subs[this.selected];
      if (sub && sub.status === "running") void this.manager.abort(sub);
      return;
    }
  }

  private pad(text: string, width: number): string {
    const truncated = truncateToWidth(text, width);
    return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  }

  private borderSegment(width: number, title: string): string {
    const theme = this.theme;
    const label = title
      ? ` ${truncateToWidth(title, Math.max(0, width - 3))} `
      : "";
    const labelWidth = visibleWidth(label);
    return (
      theme.fg("border", "─") +
      (label ? theme.fg("text", label) : "") +
      theme.fg("border", "─".repeat(Math.max(0, width - 1 - labelWidth)))
    );
  }

  render(width: number): string[] {
    const theme = this.theme;
    this.clampSelection();
    const subs = this.subs();

    const rows = this.tui.terminal.rows || 30;
    // Match the workflows dashboard: render exactly terminal rows - 1 so the
    // overlay covers the header, chat, editor, and extra footer lines while
    // leaving pi's final footer row visible.
    const bodyHeight = Math.max(6, rows - 5);
    const innerWidth = width - 2;

    const lines: string[] = [];

    // Header: title left, count right
    const headerLeft = theme.fg("accent", theme.bold("Subagents"));
    const headerRight = theme.fg(
      "muted",
      `${subs.length} agent${subs.length === 1 ? "" : "s"}`,
    );
    const headerPad = Math.max(
      1,
      width - visibleWidth(headerLeft) - visibleWidth(headerRight) - 4,
    );
    lines.push(
      truncateToWidth(
        `  ${headerLeft}${" ".repeat(headerPad)}${headerRight}  `,
        width,
      ),
    );

    // Top border with panel title
    const settled = subs.filter((s) => s.status !== "running").length;
    lines.push(
      theme.fg("border", "╭") +
        this.borderSegment(innerWidth, `agents · ${settled}/${subs.length}`) +
        theme.fg("border", "╮"),
    );

    // Rows
    const divider = theme.fg("border", "│");
    const rowLines = this.renderRows(subs, innerWidth, bodyHeight);
    for (let i = 0; i < bodyHeight; i++) {
      lines.push(divider + this.pad(rowLines[i] ?? "", innerWidth) + divider);
    }

    // Bottom border
    lines.push(
      theme.fg("border", "╰") +
        theme.fg("border", "─".repeat(innerWidth)) +
        theme.fg("border", "╯"),
    );

    // Hints
    lines.push(
      truncateToWidth(
        theme.fg(
          "dim",
          `  ${configuredKeys(this.keybindings, "tui.select.up")}/${configuredKeys(this.keybindings, "tui.select.down")}/jk select · ${configuredKeys(this.keybindings, "tui.select.confirm")} take over · x abort · ${configuredKeys(this.keybindings, "tui.select.cancel")} close`,
        ),
        width,
      ),
    );

    return lines;
  }

  private renderRows(
    subs: Subagent[],
    width: number,
    height: number,
  ): string[] {
    const theme = this.theme;
    const out: string[] = [];

    // Scroll window around selection
    let start = 0;
    if (subs.length > height) {
      start = Math.min(
        Math.max(0, this.selected - Math.floor(height / 2)),
        subs.length - height,
      );
    }
    const visible = subs.slice(start, start + height);

    for (let i = 0; i < visible.length; i++) {
      const sub = visible[i];
      const index = start + i;
      const isSelected = index === this.selected;

      // Left: marker, status square, title, dim id
      const marker = isSelected ? theme.fg("accent", "❯") : " ";
      const title = isSelected
        ? theme.fg("accent", sub.title)
        : theme.fg("text", sub.title);
      const left = ` ${marker} ${statusGlyph(sub, theme)} ${title} ${theme.fg("dim", sub.id)}`;

      // Right: model · current context utilization · elapsed · status
      const model = activeModel(sub);
      const utilization = formatContextUtilization(contextUsage(sub));
      const dot = theme.fg("dim", " · ");
      const rightParts = [
        theme.fg("muted", model?.id ?? "?"),
        ...(utilization ? [theme.fg("muted", utilization)] : []),
        theme.fg("muted", formatElapsed(sub)),
        statusWord(sub, theme),
      ];
      const right = `${rightParts.join(dot)} `;

      const rightWidth = visibleWidth(right);
      const leftMax = Math.max(0, width - rightWidth - 2);
      const leftTruncated = truncateToWidth(left, leftMax);
      const gap = Math.max(2, width - visibleWidth(leftTruncated) - rightWidth);
      out.push(truncateToWidth(leftTruncated + " ".repeat(gap) + right, width));
    }

    if (start > 0) {
      out[0] = truncateToWidth(theme.fg("dim", `   ... ${start} more`), width);
    }
    if (start + height < subs.length) {
      out[out.length - 1] = truncateToWidth(
        theme.fg("dim", `   ... ${subs.length - start - height} more`),
        width,
      );
    }
    return out;
  }

  invalidate(): void {}
}

// --- Takeover view -----------------------------------------------------------

const TRANSCRIPT_SCROLL_STEP = 6;

class TakeoverView implements Component, Focusable {
  private tui: TUI;
  private theme: Theme;
  private keybindings: KeybindingsManager;
  private sub: Subagent;
  private manager: SubagentManager;
  private done: (value: null) => void;

  private input = new Input();
  /** Scroll offset in lines from the bottom of the transcript. 0 = pinned to bottom. */
  private scrollOffset = 0;
  private unsubscribe: () => void;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private liveAssistant?: AssistantMessage;
  private liveTools = new Map<string, LiveToolEvent>();
  private closed = false;

  private _focused = false;
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    sub: Subagent,
    manager: SubagentManager,
    done: (value: null) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.sub = sub;
    this.manager = manager;
    this.done = done;
    this.unsubscribe = sub.session.subscribe((event) =>
      this.handleSessionEvent(event),
    );
    this.input.onSubmit = (value: string) => {
      const text = value.trim();
      if (!text) return;
      this.input.setValue("");
      this.manager.send(this.sub, text);
      this.scrollOffset = 0;
      this.tui.requestRender();
    };
  }

  private handleSessionEvent(event: AgentSessionEvent) {
    switch (event.type) {
      case "message_start":
      case "message_update":
        if (messageRole(event.message) === "assistant") {
          this.liveAssistant = event.message as AssistantMessage;
        }
        break;
      case "message_end":
        if (messageRole(event.message) === "assistant") {
          this.liveAssistant = event.message as AssistantMessage;
        } else if (messageRole(event.message) === "toolResult") {
          this.liveTools.delete(
            (event.message as ToolResultMessage).toolCallId,
          );
        }
        break;
      case "tool_execution_start":
        this.liveTools.set(event.toolCallId, {
          id: event.toolCallId,
          name: event.toolName,
          args: event.args as Record<string, unknown>,
        });
        break;
      case "tool_execution_update": {
        const current = this.liveTools.get(event.toolCallId);
        this.liveTools.set(event.toolCallId, {
          id: event.toolCallId,
          name: event.toolName,
          args: event.args as Record<string, unknown>,
          preview: liveToolPreview(event.partialResult) ?? current?.preview,
        });
        break;
      }
      case "tool_execution_end": {
        const current = this.liveTools.get(event.toolCallId);
        this.liveTools.set(event.toolCallId, {
          id: event.toolCallId,
          name: event.toolName,
          args: current?.args ?? {},
          preview: liveToolPreview(event.result) ?? current?.preview,
          done: true,
          isError: event.isError,
        });
        break;
      }
      case "agent_settled":
        this.liveAssistant = undefined;
        this.liveTools.clear();
        break;
    }
    this.scheduleRender();
  }

  private scheduleRender() {
    if (this.renderTimer) return;
    // Streaming can emit an event per token. Limit terminal repaints so opening
    // the inspector cannot starve input handling or make the child look frozen.
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.closed) this.tui.requestRender();
    }, 50);
  }

  private close() {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.liveAssistant = undefined;
    this.liveTools.clear();
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    this.done(null);
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "app.clear")) {
      if (this.sub.status === "running") void this.manager.abort(this.sub);
      return;
    }
    if (
      this.keybindings.matches(data, "app.interrupt") ||
      this.keybindings.matches(data, "tui.select.cancel")
    ) {
      this.close();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorUp")) {
      this.scrollOffset += TRANSCRIPT_SCROLL_STEP;
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.cursorDown")) {
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset - TRANSCRIPT_SCROLL_STEP,
      );
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageUp")) {
      this.scrollOffset += this.viewportHeight();
      this.tui.requestRender();
      return;
    }
    if (this.keybindings.matches(data, "tui.editor.pageDown")) {
      this.scrollOffset = Math.max(
        0,
        this.scrollOffset - this.viewportHeight(),
      );
      this.tui.requestRender();
      return;
    }
    this.input.handleInput(data);
    this.tui.requestRender();
  }

  private viewportHeight(): number {
    const rows = this.tui.terminal.rows || 30;
    // The complete view renders viewport + 7 chrome rows. Using rows - 8
    // makes the overlay exactly terminal rows - 1, matching /workflows.
    return Math.max(6, rows - 8);
  }

  render(width: number): string[] {
    const theme = this.theme;
    const border = theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
    const lines: string[] = [];

    lines.push(border);
    const model = activeModel(this.sub);
    const utilization = formatContextUtilization(contextUsage(this.sub));
    const header =
      `${statusGlyph(this.sub, theme)} ` +
      theme.fg("accent", theme.bold(`${this.sub.id} · ${this.sub.title}`)) +
      theme.fg("muted", ` · ${this.sub.status} · ${formatElapsed(this.sub)}`) +
      theme.fg("dim", ` · ${model ? `${model.provider}/${model.id}` : "?"}`) +
      (utilization ? theme.fg("dim", ` · ${utilization}`) : "");
    lines.push(truncateToWidth(header, width));
    lines.push(border);

    // Fixed-height transcript viewport. Error and scroll status consume rows
    // inside the viewport so streaming/scrolling never changes overlay height.
    const transcript = buildTranscriptLines(this.sub, width, theme, {
      assistant: this.liveAssistant,
      tools: [...this.liveTools.values()],
    });
    const viewport = this.viewportHeight();
    const errorRows = this.sub.errorText ? 1 : 0;
    const scrollRows = this.scrollOffset > 0 ? 1 : 0;
    const transcriptCapacity = Math.max(1, viewport - errorRows - scrollRows);
    const maxOffset = Math.max(0, transcript.length - transcriptCapacity);
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;

    const body: string[] = [];
    if (this.sub.errorText) {
      body.push(
        truncateToWidth(
          theme.fg("error", `error: ${this.sub.errorText}`),
          width,
        ),
      );
    }

    const capacity = Math.max(
      1,
      viewport - body.length - (this.scrollOffset > 0 ? 1 : 0),
    );
    const end = transcript.length - this.scrollOffset;
    const visible = transcript.slice(Math.max(0, end - capacity), end);
    if (visible.length === 0) body.push(theme.fg("dim", "(no output yet)"));
    else body.push(...visible);

    if (this.scrollOffset > 0) {
      body.push(
        truncateToWidth(
          theme.fg("dim", `... ${this.scrollOffset} lines below · ↓/pgdn`),
          width,
        ),
      );
    }
    while (body.length < viewport) body.push("");
    lines.push(...body.slice(0, viewport));

    lines.push(border);
    lines.push(...this.input.render(width));
    lines.push(
      truncateToWidth(
        theme.fg(
          "dim",
          `${configuredKeys(this.keybindings, "tui.input.submit")} send · ${configuredKeys(this.keybindings, "app.interrupt")} back · ${configuredKeys(this.keybindings, "app.clear")} abort run · ${configuredKeys(this.keybindings, "tui.editor.cursorUp")}/${configuredKeys(this.keybindings, "tui.editor.cursorDown")} scroll · ${configuredKeys(this.keybindings, "tui.editor.pageUp")}/${configuredKeys(this.keybindings, "tui.editor.pageDown")} page`,
        ),
        width,
      ),
    );
    lines.push(border);
    return lines;
  }

  invalidate(): void {
    this.input.invalidate();
  }
}

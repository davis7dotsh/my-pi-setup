/**
 * Output rendering for the /ps detail view: turns a captured stream's text
 * into sanitized, wrapped display lines. Sanitization happens here — at
 * render time, never at capture time — because raw ANSI/control characters
 * desync the TUI renderer and smear the overlay.
 */

import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

// OSC strings (window titles, hyperlinks, etc.) end in BEL or ST. Strip them
// before the generic escape/control pass so their payload never becomes
// visible text after only the leading ESC byte is removed.
// eslint-disable-next-line no-control-regex
const OSC_PATTERN =
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// Standards-shaped CSI matcher: parameters are deliberately unbounded; a
// five-digit cursor movement is still one control sequence, not visible text.
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// Remaining two-byte/charset escape forms (for example ESC ( 0).
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

/**
 * Strip raw ANSI codes, expand tabs, and drop control chars. Terminal-expanded
 * tabs (and stray escapes) make lines wider than the width we declare to the
 * TUI, which desyncs the renderer.
 */
export function sanitizeText(text: string) {
  return text
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replaceAll("\t", "  ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

/** Split, sanitize, and wrap a stream's text into display lines. */
export function buildOutputLines(text: string, width: number) {
  const safeWidth = Math.max(10, width);
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    // Carriage-return progress lines (npm, cargo): keep only the final state.
    const segments = raw.split("\r");
    const finalSegment = segments.at(-1) ?? "";
    const lastSegment =
      finalSegment || [...segments].reverse().find((segment) => segment) || "";
    const clean = sanitizeText(lastSegment);
    if (clean.length === 0) {
      out.push("");
      continue;
    }
    out.push(...wrapTextWithAnsi(clean, safeWidth));
  }
  // Drop one trailing empty line from a trailing "\n" so the tail pin sits
  // on the last real output line.
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * Cache of wrapped lines keyed by (buffer version, width): a chatty process
 * bumps the version per chunk, but renders between chunks (1Hz elapsed ticks,
 * scrolling) must not re-wrap megabytes.
 */
export function createOutputLineCache() {
  let key: string | undefined;
  let lines: string[] = [];
  return {
    get(text: string, version: number, width: number) {
      const nextKey = `${version}:${width}`;
      if (key !== nextKey) {
        key = nextKey;
        lines = buildOutputLines(text, width);
      }
      return lines;
    },
  };
}

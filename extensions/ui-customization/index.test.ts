import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { columns, formatTokens, sanitizeTerminalLabel } from "./index.ts";

test("terminal labels discard control and hyperlink escape sequences", () => {
  assert.equal(
    sanitizeTerminalLabel(
      "\u001b]8;;https://example.com\u0007project\u001b]8;;\u0007\n",
    ),
    "project",
  );
  assert.equal(sanitizeTerminalLabel("\u001b[31mbranch\u001b[0m"), "branch");
});

test("dashboard formatting remains bounded at narrow widths", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1_500), "2k");
  assert.equal(formatTokens(1_250_000), "1.3m");

  const line = columns("working-directory", "provider/model", 12);
  assert.ok(visibleWidth(line) <= 12);
});

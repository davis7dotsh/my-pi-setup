import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { emptyModelInfoState } from "../shared/dashboard-state.ts";
import {
  columns,
  formatModelLabel,
  formatTokens,
  sanitizeTerminalLabel,
} from "./index.ts";

test("terminal labels discard control and hyperlink escape sequences", () => {
  assert.equal(
    sanitizeTerminalLabel(
      "\u001b]8;;https://example.com\u0007project\u001b]8;;\u0007\n",
    ),
    "project",
  );
  assert.equal(sanitizeTerminalLabel("\u001b[31mbranch\u001b[0m"), "branch");
});

test("fast mode appears subtly beside the model only when enabled", () => {
  const model = {
    ...emptyModelInfoState(),
    provider: "openai",
    modelId: "gpt-6.1-sol",
    thinking: "high",
  };
  assert.equal(
    formatModelLabel(model, true),
    "openai/gpt-6.1-sol · high · fast",
  );
  assert.equal(formatModelLabel(model, false), "openai/gpt-6.1-sol · high");
  assert.equal(
    formatModelLabel({ ...model, provider: "other" }, true),
    "other/gpt-6.1-sol · high",
  );
});

test("dashboard formatting remains bounded at narrow widths", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1_500), "2k");
  assert.equal(formatTokens(1_250_000), "1.3m");

  const line = columns("working-directory", "provider/model", 12);
  assert.ok(visibleWidth(line) <= 12);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeTerminalText } from "./src/changed-files-view.ts";

test("repository text cannot inject terminal control sequences", () => {
  const input =
    "before\u001b]52;c;Y2xpcGJvYXJk\u0007after\u001b[31mred\u001b[0m\u0001";
  assert.equal(sanitizeTerminalText(input), "beforeafterred");
});

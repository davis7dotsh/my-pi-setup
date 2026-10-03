import assert from "node:assert/strict";
import test from "node:test";
import { buildTranscriptSections, textFromContent } from "./index.ts";

test("textFromContent normalizes supported message blocks", () => {
  assert.equal(textFromContent("plain text"), "plain text");
  assert.equal(
    textFromContent([
      { type: "text", text: "first" },
      { type: "image", data: "ignored", mimeType: "image/png" },
      { type: "thinking", thinking: "not copied" },
      { type: "text", text: "second" },
    ]),
    "first\n[image]\nsecond",
  );
  assert.equal(textFromContent({ type: "text", text: "not an array" }), "");
});

test("buildTranscriptSections labels and omits empty messages", () => {
  assert.deepEqual(
    buildTranscriptSections([
      { role: "user", content: "  hello  " },
      { role: "assistant", content: [{ type: "text", text: "world" }] },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "hidden" }],
      },
    ]),
    ["USER:\nhello", "ASSISTANT:\nworld"],
  );
});

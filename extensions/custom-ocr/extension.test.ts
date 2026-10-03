import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import customOcr from "./index.ts";

test("registers the parse-file tool, /private-image, and bounded lifecycle hooks", () => {
  const events = new Set<string>();
  const commands = new Set<string>();
  const tools = new Set<string>();
  let toolExecutionMode: string | undefined;

  const api = {
    on: (event: string) => events.add(event),
    registerCommand: (name: string) => commands.add(name),
    registerTool: (definition: { name: string; executionMode?: string }) => {
      tools.add(definition.name);
      toolExecutionMode = definition.executionMode;
    },
    appendEntry: () => {},
  } as unknown as ExtensionAPI;

  customOcr(api);

  assert.deepEqual(tools, new Set(["parse-file"]));
  assert.equal(toolExecutionMode, "sequential");
  assert.deepEqual(commands, new Set(["private-image"]));
  assert.deepEqual(
    events,
    new Set(["session_start", "session_tree", "session_shutdown"]),
  );
});

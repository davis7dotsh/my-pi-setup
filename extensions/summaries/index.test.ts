import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import summariesExtension from "./index.ts";

test("registers only the recap renderer, command, and bounded lifecycle hooks", () => {
  const events = new Set<string>();
  const renderers = new Set<string>();
  const commands = new Set<string>();
  const api = {
    on: (event: string) => events.add(event),
    registerEntryRenderer: (customType: string) => renderers.add(customType),
    registerCommand: (name: string) => commands.add(name),
  } as unknown as ExtensionAPI;

  summariesExtension(api);

  assert.deepEqual(
    events,
    new Set([
      "session_start",
      "before_agent_start",
      "agent_settled",
      "session_shutdown",
    ]),
  );
  assert.deepEqual(renderers, new Set(["summary-recap"]));
  assert.deepEqual(commands, new Set(["summary-model"]));
});

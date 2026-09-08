import assert from "node:assert/strict";
import test from "node:test";
import {
  MODE_ENTRY_TYPE,
  parsePrivateImageArgs,
  readModeFromBranch,
} from "./src/mode.ts";

const modeEntry = (mode: string) => ({
  type: "custom",
  customType: MODE_ENTRY_TYPE,
  data: { mode },
});

test("readModeFromBranch defaults to luna", () => {
  assert.equal(readModeFromBranch([]), "luna");
  assert.equal(
    readModeFromBranch([
      { type: "message" },
      { type: "custom", customType: "other" },
    ]),
    "luna",
  );
});

test("readModeFromBranch returns the most recent mode entry", () => {
  assert.equal(readModeFromBranch([modeEntry("private")]), "private");
  assert.equal(
    readModeFromBranch([modeEntry("private"), modeEntry("luna")]),
    "luna",
  );
  assert.equal(
    readModeFromBranch([modeEntry("luna"), modeEntry("private")]),
    "private",
  );
});

test("readModeFromBranch ignores malformed entries", () => {
  assert.equal(
    readModeFromBranch([
      modeEntry("private"),
      { type: "custom", customType: MODE_ENTRY_TYPE, data: { mode: "bogus" } },
      { type: "custom", customType: MODE_ENTRY_TYPE, data: undefined },
    ]),
    "private",
  );
});

test("parsePrivateImageArgs toggles with no argument", () => {
  assert.deepEqual(parsePrivateImageArgs("", "luna"), {
    action: "set",
    mode: "private",
  });
  assert.deepEqual(parsePrivateImageArgs(undefined, "private"), {
    action: "set",
    mode: "luna",
  });
});

test("parsePrivateImageArgs handles on/off/status", () => {
  assert.deepEqual(parsePrivateImageArgs("on", "luna"), {
    action: "set",
    mode: "private",
  });
  assert.deepEqual(parsePrivateImageArgs(" ON ", "private"), {
    action: "set",
    mode: "private",
  });
  assert.deepEqual(parsePrivateImageArgs("off", "private"), {
    action: "set",
    mode: "luna",
  });
  assert.deepEqual(parsePrivateImageArgs("status", "luna"), {
    action: "status",
  });
});

test("parsePrivateImageArgs rejects unknown arguments", () => {
  const result = parsePrivateImageArgs("maybe", "luna");
  assert.equal(result.action, "error");
});

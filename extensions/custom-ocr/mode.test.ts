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

test("readModeFromBranch defaults to hosted mode", () => {
  assert.equal(readModeFromBranch([]), "hosted");
  assert.equal(
    readModeFromBranch([
      { type: "message" },
      { type: "custom", customType: "other" },
    ]),
    "hosted",
  );
});

test("readModeFromBranch returns the most recent mode entry", () => {
  assert.equal(readModeFromBranch([modeEntry("private")]), "private");
  assert.equal(
    readModeFromBranch([modeEntry("private"), modeEntry("hosted")]),
    "hosted",
  );
  assert.equal(
    readModeFromBranch([modeEntry("hosted"), modeEntry("private")]),
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
  assert.deepEqual(parsePrivateImageArgs("", "hosted"), {
    action: "set",
    mode: "private",
  });
  assert.deepEqual(parsePrivateImageArgs(undefined, "private"), {
    action: "set",
    mode: "hosted",
  });
});

test("parsePrivateImageArgs handles on/off/status", () => {
  assert.deepEqual(parsePrivateImageArgs("on", "hosted"), {
    action: "set",
    mode: "private",
  });
  assert.deepEqual(parsePrivateImageArgs(" ON ", "private"), {
    action: "set",
    mode: "private",
  });
  assert.deepEqual(parsePrivateImageArgs("off", "private"), {
    action: "set",
    mode: "hosted",
  });
  assert.deepEqual(parsePrivateImageArgs("status", "hosted"), {
    action: "status",
  });
});

test("parsePrivateImageArgs rejects unknown arguments", () => {
  const result = parsePrivateImageArgs("maybe", "hosted");
  assert.equal(result.action, "error");
});

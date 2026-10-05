import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyGitInfoState,
  emptyModelInfoState,
  isGitInfoState,
  isModelInfoState,
} from "./dashboard-state.ts";

test("dashboard defaults satisfy their channel validators", () => {
  assert.equal(isModelInfoState(emptyModelInfoState()), true);
  assert.equal(isGitInfoState(emptyGitInfoState()), true);
});

test("dashboard channel validators reject incomplete payloads", () => {
  assert.equal(isModelInfoState({ modelId: "example-model" }), false);
  assert.equal(
    isGitInfoState({
      isRepository: true,
      branch: "main",
      changedFiles: 1,
      pullRequest: { number: 1, url: "https://example.com/pr/1" },
    }),
    false,
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { calculateTokensPerSecond, estimateContentTokens } from "./index.ts";

test("content token estimates use the documented four-character heuristic", () => {
  assert.equal(estimateContentTokens(0), 0);
  assert.equal(estimateContentTokens(1), 1);
  assert.equal(estimateContentTokens(8), 2);
  assert.equal(estimateContentTokens(9), 3);
});

test("token rates require positive tokens and elapsed time", () => {
  assert.equal(calculateTokensPerSecond(20, 2_000), 10);
  assert.equal(calculateTokensPerSecond(0, 2_000), null);
  assert.equal(calculateTokensPerSecond(20, 0), null);
});

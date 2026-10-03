import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_HOSTED_MODEL_ID,
  DEFAULT_HOSTED_PROVIDER,
  formatHostedModel,
  getHostedModelSelection,
} from "./src/provider-parser.ts";

test("hosted parser defaults to the public stable GPT-4.1 model", () => {
  const selection = getHostedModelSelection({});

  assert.deepEqual(selection, {
    provider: "openai",
    modelId: "gpt-4.1",
  });
  assert.equal(DEFAULT_HOSTED_PROVIDER, "openai");
  assert.equal(DEFAULT_HOSTED_MODEL_ID, "gpt-4.1");
  assert.equal(formatHostedModel(selection), "openai/gpt-4.1");
});

test("hosted parser model selection is configurable and trims values", () => {
  const selection = getHostedModelSelection({
    CUSTOM_OCR_PROVIDER: "  openrouter ",
    CUSTOM_OCR_MODEL: " google/gemini-2.5-pro ",
  });

  assert.deepEqual(selection, {
    provider: "openrouter",
    modelId: "google/gemini-2.5-pro",
  });
});

test("blank hosted parser overrides fall back to the stable default", () => {
  assert.deepEqual(
    getHostedModelSelection({
      CUSTOM_OCR_PROVIDER: " ",
      CUSTOM_OCR_MODEL: "",
    }),
    {
      provider: DEFAULT_HOSTED_PROVIDER,
      modelId: DEFAULT_HOSTED_MODEL_ID,
    },
  );
});

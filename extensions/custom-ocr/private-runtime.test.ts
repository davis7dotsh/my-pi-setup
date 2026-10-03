import assert from "node:assert/strict";
import test from "node:test";
import {
  DEEPSEEK_OCR_MODEL,
  MODELS_DIR,
  QWEN_FUSION_MODEL,
  buildWorkerEnv,
  installInstructions,
  modelInstallPath,
  parseWorkerEvent,
} from "./src/private-runtime.ts";

test("buildWorkerEnv forces offline operation and carries the token", () => {
  const env = buildWorkerEnv("secret-token");
  assert.equal(env.CUSTOM_OCR_TOKEN, "secret-token");
  assert.equal(env.HF_HUB_OFFLINE, "1");
  assert.equal(env.TRANSFORMERS_OFFLINE, "1");
  assert.equal(env.HF_DATASETS_OFFLINE, "1");
  assert.equal(env.HF_HUB_DISABLE_TELEMETRY, "1");
});

test("modelInstallPath places snapshots in the durable cache", () => {
  const path = modelInstallPath(DEEPSEEK_OCR_MODEL);
  assert.ok(path.startsWith(MODELS_DIR));
  assert.ok(path.endsWith("DeepSeek-OCR-2-4bit"));
});

test("installInstructions names each missing model and its target path", () => {
  const text = installInstructions([DEEPSEEK_OCR_MODEL, QWEN_FUSION_MODEL]);
  assert.match(text, /hf download mlx-community\/DeepSeek-OCR-2-4bit/);
  assert.match(text, /hf download mlx-community\/Qwen3\.5-4B-MLX-4bit/);
  assert.match(text, /never touches the network/);
});

test("parseWorkerEvent parses the worker stdout protocol", () => {
  assert.deepEqual(parseWorkerEvent('{"event":"listening","port":50123}'), {
    event: "listening",
    port: 50123,
  });
  assert.deepEqual(parseWorkerEvent('{"event":"loaded"}'), { event: "loaded" });
  assert.deepEqual(parseWorkerEvent('{"event":"error","message":"boom"}'), {
    event: "error",
    message: "boom",
  });
});

test("parseWorkerEvent ignores noise", () => {
  assert.equal(parseWorkerEvent("not json"), undefined);
  assert.equal(parseWorkerEvent('"just a string"'), undefined);
  assert.equal(parseWorkerEvent('{"event":"listening"}'), undefined);
  assert.equal(parseWorkerEvent('{"other":"thing"}'), undefined);
});

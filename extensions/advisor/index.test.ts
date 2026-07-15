import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  loadConfig,
  processAdvisorResponse,
  resetConfig,
  saveConfig,
} from "./index.ts";

async function withTemporaryConfig(run: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "pi-advisor-test-"));
  try {
    await run(join(directory, "advisor.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("loads a missing advisor configuration as unconfigured", async () => {
  await withTemporaryConfig(async (path) => {
    assert.equal(await loadConfig(path), undefined);
  });
});

test("rejects malformed and incomplete advisor configurations with recovery guidance", async () => {
  await withTemporaryConfig(async (path) => {
    await writeFile(path, "{not json", "utf8");
    await assert.rejects(loadConfig(path), /invalid JSON.*\/advisor reset/);

    await writeFile(path, JSON.stringify({ provider: "anthropic" }), "utf8");
    await assert.rejects(
      loadConfig(path),
      /non-empty provider and model fields.*\/advisor reset/,
    );
  });
});

test("concurrent saves leave one complete configuration and no temporary files", async () => {
  await withTemporaryConfig(async (path) => {
    const configurations = [
      { provider: "anthropic", model: "claude-opus" },
      { provider: "openai", model: "gpt" },
    ];

    await Promise.all(configurations.map((config) => saveConfig(config, path)));

    const saved = await loadConfig(path);
    assert.ok(
      configurations.some(
        (config) =>
          config.provider === saved?.provider && config.model === saved.model,
      ),
    );
    assert.deepEqual(await readdir(join(path, "..")), ["advisor.json"]);
  });
});

test("reset waits for an earlier save before clearing the configuration", async () => {
  await withTemporaryConfig(async (path) => {
    const saving = saveConfig(
      { provider: "anthropic", model: "claude-opus" },
      path,
    );
    const resetting = resetConfig(path);

    await Promise.all([saving, resetting]);

    assert.equal(await loadConfig(path), undefined);
    assert.deepEqual(await readdir(join(path, "..")), []);
  });
});

test("surfaces provider failures instead of returning partial error output", () => {
  assert.throws(
    () =>
      processAdvisorResponse({
        content: [{ type: "text", text: "partial answer" }],
        errorMessage: "rate limited",
        stopReason: "error",
      }),
    /Advisor request failed: rate limited/,
  );
});

test("marks model- and tool-truncated responses as incomplete", () => {
  const lengthLimited = processAdvisorResponse({
    content: [{ type: "text", text: "partial answer" }],
    stopReason: "length",
  });
  assert.match(lengthLimited.output, /reached its output limit/);

  const toolLimited = processAdvisorResponse({
    content: [{ type: "text", text: "a".repeat(60_000) }],
    stopReason: "stop",
  });
  assert.equal(toolLimited.truncated, true);
  assert.match(toolLimited.output, /truncated by the tool/);
});

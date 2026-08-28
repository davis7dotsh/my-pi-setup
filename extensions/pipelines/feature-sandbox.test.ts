import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createFeatureToolBoundary } from "./feature-sandbox.ts";

const context = { cwd: "/" } as unknown as ExtensionContext;

function tool(
  boundary: ReturnType<typeof createFeatureToolBoundary>,
  name: string,
) {
  const selected = boundary.tools.find((item) => item.name === name);
  assert.ok(selected, name);
  return selected as ToolDefinition;
}

async function execute(selected: ToolDefinition, params: unknown) {
  return selected.execute("test", params, undefined, undefined, context);
}

test("candidate tools cannot read or mutate sibling worktrees and bash sees only its assigned writable root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pipi-feature-sandbox-"));
  const candidateA = path.join(root, "candidate-minimal");
  const candidateB = path.join(root, "candidate-robust");
  fs.mkdirSync(candidateA);
  fs.mkdirSync(candidateB);
  fs.writeFileSync(path.join(candidateA, "own.txt"), "own\n");
  fs.writeFileSync(path.join(candidateB, "secret.txt"), "secret\n");
  try {
    const boundary = createFeatureToolBoundary({
      cwd: candidateA,
      mode: "candidate",
    });
    assert.deepEqual(boundary.initialActiveTools, [
      "read",
      "bash",
      "edit",
      "write",
      "pipeline_feature_commit",
    ]);
    await assert.rejects(
      execute(tool(boundary, "read"), {
        path: path.join(candidateB, "secret.txt"),
      }),
      /denied outside the controller-assigned scope/,
    );
    await execute(tool(boundary, "bash"), {
      command:
        "printf changed > own.txt; printf leaked > ../candidate-robust/leak.txt || true",
    });
    assert.equal(
      fs.readFileSync(path.join(candidateA, "own.txt"), "utf8"),
      "changed",
    );
    assert.equal(fs.existsSync(path.join(candidateB, "leak.txt")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("selection tools are read-only across candidates until the controller enables augmentation", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "pipi-feature-selection-"),
  );
  const candidate = path.join(root, "candidate-minimal");
  const synthesis = path.join(root, "synthesis");
  fs.mkdirSync(candidate);
  fs.mkdirSync(synthesis);
  fs.writeFileSync(path.join(candidate, "candidate.txt"), "candidate\n");
  try {
    const boundary = createFeatureToolBoundary({
      cwd: synthesis,
      mode: "selection",
    });
    assert.deepEqual(boundary.initialActiveTools, ["read", "bash"]);
    const readResult = await execute(tool(boundary, "read"), {
      path: path.join(candidate, "candidate.txt"),
    });
    assert.match(
      readResult.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
      /candidate/,
    );
    await execute(tool(boundary, "bash"), {
      command: "printf illegal > ../candidate-minimal/illegal.txt || true",
    });
    assert.equal(fs.existsSync(path.join(candidate, "illegal.txt")), false);
    await assert.rejects(
      execute(tool(boundary, "write"), {
        path: path.join(synthesis, "before.txt"),
        content: "before",
      }),
      /Selection phase is read-only/,
    );

    boundary.enableAugmentation();
    await execute(tool(boundary, "write"), {
      path: path.join(synthesis, "after.txt"),
      content: "after",
    });
    assert.equal(
      fs.readFileSync(path.join(synthesis, "after.txt"), "utf8"),
      "after",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

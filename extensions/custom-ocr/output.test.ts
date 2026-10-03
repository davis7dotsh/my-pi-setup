import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_SAVED_RESULTS,
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_LINES,
  mergePageResults,
  saveFullResult,
  truncateOutput,
} from "./src/output.ts";

test("mergePageResults returns single-page text unwrapped", () => {
  assert.equal(mergePageResults([{ page: 1, text: " hello \n" }]), "hello");
});

test("mergePageResults orders pages and adds headings", () => {
  const merged = mergePageResults([
    { page: 3, text: "three" },
    { page: 1, text: "one" },
    { page: 2, text: "two" },
  ]);
  assert.equal(
    merged,
    "## Page 1\n\none\n\n## Page 2\n\ntwo\n\n## Page 3\n\nthree",
  );
});

test("truncateOutput passes small output through", () => {
  const result = truncateOutput("short\ntext");
  assert.equal(result.truncated, false);
  assert.equal(result.text, "short\ntext");
});

test("truncateOutput enforces the byte limit on whole lines", () => {
  const line = "x".repeat(1000);
  const input = Array.from({ length: 100 }, () => line).join("\n");
  const result = truncateOutput(input);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.text, "utf8") <= OUTPUT_MAX_BYTES);
  assert.ok(result.text.endsWith(line));
});

test("truncateOutput enforces the line limit", () => {
  const input = Array.from(
    { length: OUTPUT_MAX_LINES + 500 },
    (_, i) => `${i}`,
  ).join("\n");
  const result = truncateOutput(input);
  assert.equal(result.truncated, true);
  assert.equal(result.text.split("\n").length, OUTPUT_MAX_LINES);
});

test("truncateOutput reserves room for a required suffix", () => {
  const suffix = "\n\n[full result saved to /tmp/full.md]";
  const input = Array.from(
    { length: OUTPUT_MAX_LINES + 100 },
    (_, i) => `line ${i}`,
  ).join("\n");
  const result = truncateOutput(input, suffix);
  const combined = `${result.text}${suffix}`;

  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(combined, "utf8") <= OUTPUT_MAX_BYTES);
  assert.ok(combined.split("\n").length <= OUTPUT_MAX_LINES);
  assert.ok(combined.endsWith(suffix));
});

test("saveFullResult retains only the newest owner-only results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "custom-ocr-results-test-"));
  try {
    await Promise.all(
      Array.from({ length: MAX_SAVED_RESULTS + 2 }, (_, index) =>
        writeFile(
          join(directory, `parse-${String(index).padStart(4, "0")}.md`),
          `${index}`,
        ),
      ),
    );
    await writeFile(join(directory, "unrelated.txt"), "keep");

    const path = await saveFullResult("full transcription", directory);
    const files = await readdir(directory);
    const results = files.filter((name) => /^parse-.*\.md$/.test(name));

    assert.equal(results.length, MAX_SAVED_RESULTS);
    assert.ok(!results.includes("parse-0000.md"));
    assert.ok(files.includes("unrelated.txt"));
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

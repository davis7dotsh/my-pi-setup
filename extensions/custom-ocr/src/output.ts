/**
 * Deterministic result formatting: page-ordered merging plus truncation at
 * Pi's tool output limits (50 KB / 2,000 lines). When output is truncated the
 * full result is saved to an owner-only file under ~/.cache/custom-ocr.
 */
import { chmod, mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const OUTPUT_MAX_BYTES = 50_000;
export const OUTPUT_MAX_LINES = 2_000;

export const RESULTS_DIR = join(homedir(), ".cache", "custom-ocr", "results");
export const MAX_SAVED_RESULTS = 100;

export interface PageResult {
  readonly page: number;
  readonly text: string;
}

/** Merge per-page results deterministically in page order. */
export function mergePageResults(results: readonly PageResult[]) {
  const ordered = [...results].sort((a, b) => a.page - b.page);
  if (ordered.length === 1) return ordered[0]!.text.trim();
  return ordered
    .map((result) => `## Page ${result.page}\n\n${result.text.trim()}`)
    .join("\n\n");
}

/** Truncate to the byte/line limits, keeping whole lines and suffix capacity. */
export function truncateOutput(text: string, reservedSuffix = "") {
  const suffixBytes = Buffer.byteLength(reservedSuffix, "utf8");
  const suffixNewlines = reservedSuffix.split("\n").length - 1;
  if (suffixBytes > OUTPUT_MAX_BYTES || suffixNewlines + 1 > OUTPUT_MAX_LINES) {
    throw new RangeError(
      "The reserved output suffix exceeds Pi's tool limits.",
    );
  }

  const lines = text.split("\n");
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const nextLineCount = kept.length + 1 + suffixNewlines;
    const lineBytes =
      Buffer.byteLength(line, "utf8") + (kept.length > 0 ? 1 : 0);
    if (
      nextLineCount > OUTPUT_MAX_LINES ||
      bytes + lineBytes + suffixBytes > OUTPUT_MAX_BYTES
    ) {
      return { text: kept.join("\n"), truncated: true };
    }
    kept.push(line);
    bytes += lineBytes;
  }
  return { text, truncated: false };
}

async function makeRoomForSavedResult(resultsDir: string) {
  const files = (await readdir(resultsDir))
    .filter((name) => /^parse-.*\.md$/.test(name))
    .sort();
  const stale = files.slice(
    0,
    Math.max(0, files.length - MAX_SAVED_RESULTS + 1),
  );
  await Promise.all(
    stale.map(async (name) => {
      try {
        await unlink(join(resultsDir, name));
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          throw error;
        }
      }
    }),
  );
}

/** Save the full result to an owner-only (0600) file and return its path. */
export async function saveFullResult(text: string, resultsDir = RESULTS_DIR) {
  await mkdir(resultsDir, { recursive: true, mode: 0o700 });
  await chmod(resultsDir, 0o700);
  await makeRoomForSavedResult(resultsDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(
    resultsDir,
    `parse-${stamp}-${Math.random().toString(36).slice(2, 8)}.md`,
  );
  await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
  return path;
}

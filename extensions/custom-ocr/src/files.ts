/**
 * File resolution, validation, page selection, and preprocessing.
 *
 * Pure helpers (path normalization, magic-byte sniffing, page ranges,
 * manifest parsing) are exported for tests. Filesystem access and the
 * Python rasterization step run inside Effect with typed failures.
 */
import { Data, Effect } from "effect";
import { open, stat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { runCommand, type CommandRunner } from "./runtime.ts";

export const MAX_PAGES = 20;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const RENDER_MAX_SIDE = 2048;
const RENDER_TIMEOUT_MS = 180_000;
const SNIFF_BYTES = 16;

export type SupportedKind = "png" | "jpeg" | "webp" | "gif" | "tiff" | "pdf";

export interface ResolvedFile {
  readonly path: string;
  readonly kind: SupportedKind;
  readonly size: number;
}

export interface PageRange {
  readonly start: number;
  readonly end: number;
}

export interface RenderManifest {
  readonly pages: readonly { readonly page: number; readonly path: string }[];
  readonly totalPages: number;
  readonly warnings: readonly string[];
}

export class FileValidationError extends Data.TaggedError(
  "FileValidationError",
)<{ readonly message: string }> {}

export class RenderError extends Data.TaggedError("RenderError")<{
  readonly message: string;
}> {}

/** Strip a leading `@`, expand `~`, and resolve against the working directory. */
export function normalizeRequestPath(rawPath: string, cwd: string) {
  let path = rawPath.trim();
  if (path.startsWith("@")) path = path.slice(1);
  if (path === "~") path = homedir();
  else if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

export function looksLikeUrl(rawPath: string) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath.trim());
}

/** Detect the file type from magic bytes. Extensions are never trusted. */
export function sniffKind(bytes: Uint8Array): SupportedKind | undefined {
  const startsWith = (prefix: number[], offset = 0) =>
    prefix.every((byte, index) => bytes[offset + index] === byte);
  if (startsWith([0x25, 0x50, 0x44, 0x46])) return "pdf"; // %PDF
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "png";
  if (startsWith([0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return "gif"; // GIF8
  if (
    startsWith([0x52, 0x49, 0x46, 0x46]) &&
    startsWith([0x57, 0x45, 0x42, 0x50], 8)
  )
    return "webp"; // RIFF....WEBP
  if (
    startsWith([0x49, 0x49, 0x2a, 0x00]) ||
    startsWith([0x4d, 0x4d, 0x00, 0x2a])
  )
    return "tiff";
  return undefined;
}

/**
 * Normalize an optional page range. Without a range the first 1–20 pages are
 * processed. Explicit ranges must be ascending and span at most 20 pages.
 */
export function normalizePageRange(pages?: PageRange) {
  if (!pages) return { start: 1, end: MAX_PAGES };
  if (!Number.isInteger(pages.start) || !Number.isInteger(pages.end)) {
    throw new FileValidationError({
      message: "Page range values must be integers.",
    });
  }
  if (pages.start < 1 || pages.end < 1) {
    throw new FileValidationError({
      message: "Page numbers start at 1.",
    });
  }
  if (pages.end < pages.start) {
    throw new FileValidationError({
      message: `Invalid page range: end (${pages.end}) is before start (${pages.start}).`,
    });
  }
  const span = pages.end - pages.start + 1;
  if (span > MAX_PAGES) {
    throw new FileValidationError({
      message: `Page range spans ${span} pages; the maximum is ${MAX_PAGES} pages per call.`,
    });
  }
  return pages;
}

function formatBytes(size: number) {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${size} B`;
}

const sniffFile = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      const handle = await open(path, "r");
      try {
        const buffer = new Uint8Array(SNIFF_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
    catch: (cause) =>
      new FileValidationError({
        message: `Could not read file: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

/**
 * Resolve and validate a user-supplied path: strip `@`, expand `~`, resolve
 * relative to cwd, canonicalize with realpath, and verify type and size.
 */
export const resolveFile = (rawPath: string, cwd: string) =>
  Effect.gen(function* () {
    if (looksLikeUrl(rawPath)) {
      return yield* new FileValidationError({
        message: `"${rawPath}" looks like a URL. parse-file only accepts local file paths.`,
      });
    }
    const normalized = normalizeRequestPath(rawPath, cwd);
    const canonical = yield* Effect.tryPromise({
      try: () => realpath(normalized),
      catch: () =>
        new FileValidationError({
          message: `File not found: ${normalized}`,
        }),
    });

    const stats = yield* Effect.tryPromise({
      try: () => stat(canonical),
      catch: (cause) =>
        new FileValidationError({
          message: `Could not inspect file: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });
    if (stats.isDirectory()) {
      return yield* new FileValidationError({
        message: `${normalized} is a directory. Point parse-file at a single image or PDF.`,
      });
    }
    if (!stats.isFile()) {
      return yield* new FileValidationError({
        message: `${normalized} is not a regular file.`,
      });
    }
    if (stats.size === 0) {
      return yield* new FileValidationError({
        message: `${normalized} is empty.`,
      });
    }
    if (stats.size > MAX_FILE_BYTES) {
      return yield* new FileValidationError({
        message: `${normalized} is ${formatBytes(stats.size)}; the maximum supported size is ${formatBytes(MAX_FILE_BYTES)}.`,
      });
    }

    const bytes = yield* sniffFile(canonical);
    const kind = sniffKind(bytes);
    if (!kind) {
      return yield* new FileValidationError({
        message: `${canonical} is not a supported file type. Supported: PNG, JPEG, WebP, GIF, TIFF, PDF.`,
      });
    }

    return { path: canonical, kind, size: stats.size } satisfies ResolvedFile;
  });

/** Parse the JSON manifest emitted by python/render-file.py. */
export function parseRenderManifest(stdout: string) {
  const lines = stdout.trim().split("\n");
  const last = lines.at(-1) ?? "";
  let value: unknown;
  try {
    value = JSON.parse(last);
  } catch {
    throw new RenderError({
      message: `Renderer produced invalid output: ${last.slice(0, 200)}`,
    });
  }
  if (typeof value !== "object" || value === null) {
    throw new RenderError({ message: "Renderer produced invalid output." });
  }
  const manifest = value as {
    pages?: unknown;
    total_pages?: unknown;
    warnings?: unknown;
    error?: unknown;
  };
  if (typeof manifest.error === "string") {
    throw new RenderError({ message: manifest.error });
  }
  if (!Array.isArray(manifest.pages) || manifest.pages.length === 0) {
    throw new RenderError({ message: "Renderer produced no pages." });
  }
  const pages = manifest.pages.map((entry: unknown) => {
    const page = entry as { page?: unknown; path?: unknown };
    if (typeof page.page !== "number" || typeof page.path !== "string") {
      throw new RenderError({ message: "Renderer manifest is malformed." });
    }
    return { page: page.page, path: page.path };
  });
  return {
    pages,
    totalPages:
      typeof manifest.total_pages === "number"
        ? manifest.total_pages
        : pages.length,
    warnings: Array.isArray(manifest.warnings)
      ? manifest.warnings.filter(
          (warning): warning is string => typeof warning === "string",
        )
      : [],
  } satisfies RenderManifest;
}

function rendererReportedError(stdout: string) {
  const last = stdout.trim().split("\n").at(-1) ?? "";
  try {
    const value: unknown = JSON.parse(last);
    if (
      typeof value === "object" &&
      value !== null &&
      "error" in value &&
      typeof value.error === "string"
    ) {
      return value.error;
    }
  } catch {
    // Fall through to stderr/stdout diagnostics.
  }
  return undefined;
}

/**
 * Rasterize the selected pages to normalized PNGs via the local Python
 * renderer (PyMuPDF + Pillow). Runs entirely on this machine.
 */
export const renderFile = (options: {
  readonly file: ResolvedFile;
  readonly range: PageRange;
  readonly outDir: string;
  readonly pythonDir: string;
}): Effect.Effect<RenderManifest, RenderError, CommandRunner> =>
  Effect.gen(function* () {
    const result = yield* runCommand(
      "uv",
      [
        "run",
        "--quiet",
        "--project",
        options.pythonDir,
        "python",
        join(options.pythonDir, "render-file.py"),
        "--input",
        options.file.path,
        "--start",
        String(options.range.start),
        "--end",
        String(options.range.end),
        "--outdir",
        options.outDir,
        "--max-side",
        String(RENDER_MAX_SIDE),
      ],
      options.pythonDir,
      RENDER_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      const detail =
        rendererReportedError(result.stdout) ||
        result.stderr.trim().split("\n").slice(-4).join("\n") ||
        result.stdout.trim().slice(-400) ||
        `exit code ${result.code}`;
      return yield* new RenderError({
        message: `Failed to render ${options.file.path}: ${detail}`,
      });
    }
    return yield* Effect.try({
      try: () => parseRenderManifest(result.stdout),
      catch: (cause) =>
        cause instanceof RenderError
          ? cause
          : new RenderError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
    });
  });

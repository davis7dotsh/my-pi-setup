/**
 * Pure CLI argument construction for the fd and rg tools.
 *
 * Everything here is synchronous and side-effect free so the exact argv
 * passed to pi.exec can be asserted in tests. Patterns are always placed
 * after a `--` separator so user-controlled input can never be parsed as a
 * flag, and paths are normalized (leading `@`, `~` expansion) before use.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export const FD_DEFAULT_LIMIT = 1000;
export const FD_MAX_LIMIT = 10_000;
export const FD_MAX_DEPTH_LIMIT = 64;
export const RG_DEFAULT_COUNT_LIMIT = 100;
export const RG_MAX_COUNT_LIMIT = 1000;
export const RG_MAX_CONTEXT = 20;

/** Some models prefix path arguments with @; built-in tools strip it, so do we. */
export function normalizeSearchPath(raw: string) {
  let path = raw.trim();
  if (path.startsWith("@")) path = path.slice(1);
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function optionalPath(raw: string | undefined) {
  if (raw === undefined) return undefined;
  const normalized = normalizeSearchPath(raw);
  return normalized === "" ? undefined : normalized;
}

export type FdEntryType = "file" | "directory" | "symlink";

export interface FdToolParams {
  pattern?: string;
  path?: string;
  type?: FdEntryType;
  extension?: string;
  glob?: boolean;
  hidden?: boolean;
  max_depth?: number;
  limit?: number;
}

const FD_TYPE_FLAGS: Record<FdEntryType, string> = {
  file: "f",
  directory: "d",
  symlink: "l",
};

export function buildFdArgs(params: FdToolParams) {
  const args = ["--color=never"];
  if (params.hidden) args.push("--hidden");
  if (params.glob) args.push("--glob");
  if (params.type) args.push("--type", FD_TYPE_FLAGS[params.type]);
  if (params.extension) {
    args.push("--extension", params.extension.replace(/^\.+/, ""));
  }
  if (params.max_depth !== undefined) {
    args.push(
      "--max-depth",
      String(clamp(params.max_depth, 1, FD_MAX_DEPTH_LIMIT)),
    );
  }
  args.push(
    "--max-results",
    String(clamp(params.limit ?? FD_DEFAULT_LIMIT, 1, FD_MAX_LIMIT)),
  );
  // An empty pattern matches everything, which keeps `path` usable without a pattern.
  args.push("--", params.pattern ?? "");
  const path = optionalPath(params.path);
  if (path) args.push(path);
  return args;
}

export interface RgToolParams {
  pattern: string;
  path?: string;
  glob?: string;
  file_type?: string;
  case_sensitive?: boolean;
  fixed_strings?: boolean;
  hidden?: boolean;
  context?: number;
  limit?: number;
}

export function buildRgArgs(params: RgToolParams) {
  const args = [
    "--line-number",
    "--color=never",
    "--no-heading",
    "--with-filename",
  ];
  if (params.case_sensitive === true) args.push("--case-sensitive");
  else if (params.case_sensitive === false) args.push("--ignore-case");
  else args.push("--smart-case");
  if (params.fixed_strings) args.push("--fixed-strings");
  if (params.hidden) args.push("--hidden");
  if (params.context !== undefined) {
    args.push("--context", String(clamp(params.context, 0, RG_MAX_CONTEXT)));
  }
  if (params.glob) args.push("--glob", params.glob);
  if (params.file_type) args.push("--type", params.file_type);
  args.push(
    "--max-count",
    String(
      clamp(params.limit ?? RG_DEFAULT_COUNT_LIMIT, 1, RG_MAX_COUNT_LIMIT),
    ),
  );
  args.push("--", params.pattern);
  const path = optionalPath(params.path);
  if (path) args.push(path);
  return args;
}

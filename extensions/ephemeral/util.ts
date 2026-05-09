import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import type { CatalogItem, EphemeralCategory, JsonObject, JsonValue, ProjectMcpServerConfig, ProjectPaths } from "./types.ts";

export const CATALOG_ROOT = join(homedir(), ".pi", "ephemeral");
export const MANIFEST_VERSION = 1 as const;

const fingerprintInFlight = new Map<string, Promise<string>>();

export function getProjectPaths(cwd: string): ProjectPaths {
  const projectPiDir = resolve(cwd, ".pi");
  return {
    manifestPath: join(projectPiDir, "ephemeral.json"),
    settingsPath: join(projectPiDir, "settings.json"),
    projectMcpPath: join(projectPiDir, "mcp.json"),
  };
}

export function categoryLabel(category: EphemeralCategory): string {
  switch (category) {
    case "skills":
      return "skills";
    case "prompts":
      return "prompts";
    case "extensions":
      return "extensions";
    case "mcp":
      return "mcp";
  }
}

export function resourceKey(type: CatalogItem["type"], id: string): string {
  return `${type}:${id}`;
}

export function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

export function shortenPath(filePath: string, cwd: string): string {
  const absolute = resolve(filePath);
  const root = resolve(cwd);
  if (absolute === root) return ".";
  if (absolute.startsWith(`${root}/`)) {
    return `./${relative(root, absolute)}`;
  }
  return absolute;
}

export function summarizeMcpServer(serverName: string, serverConfig: ProjectMcpServerConfig): string {
  if (typeof serverConfig.url === "string" && serverConfig.url) {
    return `${serverName} → ${serverConfig.url}`;
  }

  if (typeof serverConfig.command === "string" && serverConfig.command) {
    const args = Array.isArray(serverConfig.args)
      ? serverConfig.args.filter((value): value is string => typeof value === "string")
      : [];
    return `${serverName} → ${[serverConfig.command, ...args].join(" ")}`;
  }

  return serverName;
}

export function parseMarkdownFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  if (!text.startsWith("---\n")) {
    return { frontmatter: {}, body: text };
  }

  const endIndex = text.indexOf("\n---\n", 4);
  if (endIndex === -1) {
    return { frontmatter: {}, body: text };
  }

  const rawFrontmatter = text.slice(4, endIndex).split(/\r?\n/);
  const frontmatter: Record<string, string> = {};
  for (const line of rawFrontmatter) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    frontmatter[match[1]!] = stripQuotes(match[2]!.trim());
  }

  return {
    frontmatter,
    body: text.slice(endIndex + 5),
  };
}

function stripQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

export function getFirstNonEmptyLine(text: string): string {
  return text
    .split(/\r?\n/)
    .flatMap((line) => {
      const trimmed = line.trim();
      return trimmed ? [trimmed] : [];
    })[0] ?? "";
}

export function uniqueSorted<T>(values: Iterable<T>, sorter?: (left: T, right: T) => number): T[] {
  const unique = Array.from(new Set(values));
  return sorter ? unique.sort(sorter) : unique;
}

export function computeFingerprint(path: string): Promise<string> {
  const targetPath = resolve(path);
  const existing = fingerprintInFlight.get(targetPath);
  if (existing) return existing;

  const pending = hashPath(targetPath).finally(() => fingerprintInFlight.delete(targetPath));
  fingerprintInFlight.set(targetPath, pending);
  return pending;
}

async function hashPath(targetPath: string): Promise<string> {
  const hash = createHash("sha256");
  const stats = await stat(targetPath);

  if (stats.isDirectory()) {
    hash.update(`dir:${basename(targetPath)}\n`);
    const children = await readdir(targetPath);
    children.sort((left, right) => left.localeCompare(right));
    const childHashes = await Promise.all(children.map((child) => hashPath(join(targetPath, child))));
    for (const childHash of childHashes) {
      hash.update(childHash);
    }
    return hash.digest("hex");
  }

  hash.update(`file:${basename(targetPath)}:${stats.size}\n`);
  hash.update(await readFile(targetPath));
  return hash.digest("hex");
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;

  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return true;
    case "object":
      if (Array.isArray(value)) {
        return value.every((entry) => isJsonValue(entry));
      }
      return isJsonObject(value);
    default:
      return false;
  }
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.values(value as Record<string, unknown>).every((entry) => isJsonValue(entry));
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function listImmediateDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const directories: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        directories.push(join(root, entry.name));
      }
    }
    return directories.sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

export async function listImmediateFiles(root: string, predicate?: (fileName: string) => boolean): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (predicate && !predicate(entry.name)) continue;
      files.push(join(root, entry.name));
    }
    return files.sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

export async function getDirectoryEntryNames(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root);
    return entries.sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

export function prettyJson(value: unknown): string {
  return ensureTrailingNewline(JSON.stringify(value, null, 2));
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function resolveProjectPath(cwd: string, ...parts: string[]): string {
  return resolve(cwd, ...parts);
}

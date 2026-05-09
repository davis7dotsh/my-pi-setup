import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { CatalogData, CatalogItem, ManifestEntry, ProjectMcpJson, ProjectSettingsJson, ProjectState } from "./types.ts";
import { readManifest } from "./manifest.ts";
import { readProjectMcp } from "./mcp.ts";
import { getProjectPaths, isJsonObject, pathExists, resolveProjectPath } from "./util.ts";

export async function readProjectState(cwd: string, catalog?: CatalogData): Promise<ProjectState> {
  const paths = getProjectPaths(cwd);

  const [manifest, settingsResult, mcpResult] = await Promise.all([
    readManifest(paths.manifestPath),
    loadProjectSettings(paths.settingsPath),
    loadProjectMcp(paths.projectMcpPath),
  ]);

  const [manifestWarnings, catalogWarnings] = await Promise.all([
    computeManifestWarnings(cwd, manifest.items, settingsResult.value, mcpResult.value),
    Promise.resolve(catalog ? getCatalogManifestWarnings(manifest.items, catalog) : []),
  ]);

  const warnings = [
    ...(settingsResult.error ? [`settings.json error: ${settingsResult.error}`] : []),
    ...(mcpResult.error ? [`mcp.json error: ${mcpResult.error}`] : []),
    ...manifestWarnings,
    ...catalogWarnings,
  ];

  return {
    cwd,
    paths,
    manifest,
    settingsJson: settingsResult.value,
    settingsError: settingsResult.error,
    mcpJson: mcpResult.value,
    mcpError: mcpResult.error,
    warnings,
  };
}

export function getManagedEntriesByCategory(state: ProjectState, catalog?: CatalogData): Record<CatalogItem["category"], Array<{ key: string; label: string }>> {
  const grouped: Record<CatalogItem["category"], Array<{ key: string; label: string }>> = {
    skills: [],
    prompts: [],
    extensions: [],
    mcp: [],
  };

  for (const entry of Object.values(state.manifest.items)) {
    const label = catalog?.byKey.get(entry.key)?.label ?? entry.label ?? entry.id;
    grouped[entry.category].push({ key: entry.key, label });
  }

  for (const category of Object.keys(grouped) as Array<keyof typeof grouped>) {
    grouped[category].sort((left, right) => left.label.localeCompare(right.label));
  }

  return grouped;
}

export function getLiveWarnings(state: ProjectState, catalog: CatalogData, desiredKeys: Set<string>): string[] {
  const warnings = [...state.warnings, ...catalog.warnings];
  for (const item of catalog.items) {
    const isManaged = Boolean(state.manifest.items[item.key]);
    const shouldBeEnabled = desiredKeys.has(item.key);
    if (!shouldBeEnabled || isManaged) continue;

    const conflict = getInstallConflict(item, state);
    if (conflict) warnings.push(conflict);
  }

  return uniqueStrings(warnings);
}

export function getInstallConflict(item: CatalogItem, state: ProjectState): string | undefined {
  const managedEntry = state.manifest.items[item.key];
  if (managedEntry) return undefined;

  switch (item.type) {
    case "skill": {
      const targetPath = resolveProjectPath(state.cwd, ".pi", "skills", item.id);
      return targetExistsUnmanaged(targetPath, state) ? `skill '${item.label}' conflicts with local path ${targetPath}` : undefined;
    }
    case "prompt": {
      const targetPath = resolveProjectPath(state.cwd, ".pi", "prompts", item.fileName);
      return targetExistsUnmanaged(targetPath, state) ? `prompt '${item.label}' conflicts with local path ${targetPath}` : undefined;
    }
    case "extension": {
      if (item.extensionKind === "single-file") {
        const targetPath = resolveProjectPath(state.cwd, ".pi", "extensions", item.entryName);
        return targetExistsUnmanaged(targetPath, state)
          ? `extension '${item.label}' conflicts with local path ${targetPath}`
          : undefined;
      }

      if (state.settingsError) {
        return `extension '${item.label}' cannot be installed because .pi/settings.json is invalid`;
      }

      const targetPath = resolveProjectPath(state.cwd, ".pi", "ephemeral", "extensions", item.entryName);
      return targetExistsUnmanaged(targetPath, state)
        ? `extension '${item.label}' conflicts with local path ${targetPath}`
        : undefined;
    }
    case "mcp": {
      if (state.mcpError) {
        return `mcp '${item.label}' cannot be installed because .pi/mcp.json is invalid`;
      }
      const existing = state.mcpJson?.mcpServers ?? {};
      return existing[item.serverName] ? `mcp server '${item.serverName}' conflicts with existing project server` : undefined;
    }
  }
}

export function getCatalogManifestWarnings(items: Record<string, ManifestEntry>, catalog: CatalogData): string[] {
  return Object.values(items).flatMap((entry) => (catalog.byKey.has(entry.key) ? [] : [`managed item missing from catalog: ${entry.key}`]));
}

async function computeManifestWarnings(
  cwd: string,
  items: Record<string, ManifestEntry>,
  settingsJson?: ProjectSettingsJson,
  mcpJson?: ProjectMcpJson,
): Promise<string[]> {
  const warningGroups = await Promise.all(
    Object.values(items).map((entry) => computeManifestEntryWarnings(cwd, entry, settingsJson, mcpJson)),
  );
  return warningGroups.flat();
}

async function computeManifestEntryWarnings(
  cwd: string,
  entry: ManifestEntry,
  settingsJson?: ProjectSettingsJson,
  mcpJson?: ProjectMcpJson,
): Promise<string[]> {
  const warnings: string[] = [];

  switch (entry.type) {
    case "skill":
    case "prompt":
    case "extension": {
      const missingTargets = await Promise.all(
        entry.targetPaths.map(async (targetPath) => (
          (await pathExists(targetPath)) ? undefined : `drift detected: managed ${entry.type} '${entry.id}' missing target ${targetPath}`
        )),
      );
      warnings.push(...missingTargets.flatMap((warning) => (warning ? [warning] : [])));

      warnings.push(
        ...entry.settingsChanges.flatMap((change) => {
          const values = change.kind === "extensions" ? settingsJson?.extensions ?? [] : [];
          return values.includes(change.value)
            ? []
            : [`drift detected: managed ${entry.type} '${entry.id}' missing settings reference ${change.value}`];
        }),
      );
      break;
    }
    case "mcp": {
      const servers = mcpJson?.mcpServers ?? {};
      if (!entry.serverName || !servers[entry.serverName]) {
        warnings.push(`drift detected: managed mcp '${entry.id}' missing server entry ${entry.serverName ?? entry.id}`);
      }
      break;
    }
  }

  const isCatalogFragment = !entry.sourcePath.startsWith(cwd) && entry.sourcePath.includes("#");
  if (!isCatalogFragment) {
    const sourcePath = entry.sourcePath.split("#", 1)[0]!;
    if (!(await pathExists(sourcePath))) {
      warnings.push(`drift detected: managed ${entry.type} '${entry.id}' missing catalog source ${sourcePath}`);
    }
  }

  return warnings;
}

async function loadProjectSettings(settingsPath: string): Promise<LoadResult<ProjectSettingsJson>> {
  try {
    return { value: await readProjectSettings(settingsPath) };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

async function loadProjectMcp(projectMcpPath: string): Promise<LoadResult<ProjectMcpJson>> {
  try {
    return { value: await readProjectMcp(projectMcpPath) };
  } catch (error) {
    return { error: toErrorMessage(error) };
  }
}

async function readProjectSettings(settingsPath: string): Promise<ProjectSettingsJson | undefined> {
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isJsonObject(parsed)) {
    throw new Error(`Invalid project settings: ${settingsPath}`);
  }

  if (
    parsed.extensions !== undefined
    && (!Array.isArray(parsed.extensions) || !parsed.extensions.every((entry): entry is string => typeof entry === "string"))
  ) {
    throw new Error(`Invalid project settings: ${settingsPath}`);
  }

  return parsed as ProjectSettingsJson;
}

function targetExistsUnmanaged(targetPath: string, state: ProjectState): boolean {
  if (!existsSync(targetPath)) return false;
  return !Object.values(state.manifest.items).some((entry) => entry.targetPaths.includes(targetPath));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

type LoadResult<T> = {
  value?: T;
  error?: string;
};

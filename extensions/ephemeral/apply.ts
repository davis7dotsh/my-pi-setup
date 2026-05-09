import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ApplyConflict, ApplyResult, CatalogData, CatalogItem, EphemeralManifest, ManifestEntry, ProjectSettingsJson, ProjectState } from "./types.ts";
import { writeManifest } from "./manifest.ts";
import { cloneProjectMcp, writeProjectMcp } from "./mcp.ts";
import { getInstallConflict } from "./project-state.ts";
import { ensureTrailingNewline, getProjectPaths, resolveProjectPath } from "./util.ts";

export async function applySelection(
  cwd: string,
  catalog: CatalogData,
  state: ProjectState,
  desiredKeys: Set<string>,
): Promise<ApplyResult> {
  const manifest: EphemeralManifest = {
    version: state.manifest.version,
    items: { ...state.manifest.items },
  };

  const currentKeys = new Set(Object.keys(state.manifest.items));
  const additions: CatalogItem[] = [];
  for (const key of setDifference(desiredKeys, currentKeys)) {
    const item = catalog.byKey.get(key);
    if (item) additions.push(item);
  }

  const removals: ManifestEntry[] = [];
  for (const key of setDifference(currentKeys, desiredKeys)) {
    const entry = state.manifest.items[key];
    if (entry) removals.push(entry);
  }

  const conflictByKey = new Map<string, ApplyConflict>();
  for (const item of additions) {
    const conflict = getInstallConflict(item, { ...state, manifest });
    if (conflict) {
      conflictByKey.set(item.key, { key: item.key, message: conflict });
    }
  }

  for (const entry of removals) {
    const conflict = getRemovalConflict(entry, state);
    if (conflict) {
      conflictByKey.set(entry.key, { key: entry.key, message: conflict });
    }
  }

  const removedKeys: string[] = [];
  for (const entry of removals) {
    if (conflictByKey.has(entry.key)) continue;
    await removeManagedEntry(entry, state);
    delete manifest.items[entry.key];
    removedKeys.push(entry.key);
  }

  const addedKeys: string[] = [];
  for (const item of additions) {
    if (conflictByKey.has(item.key)) continue;
    const entry = await installCatalogItem(item, cwd, state);
    manifest.items[item.key] = entry;
    addedKeys.push(item.key);
  }

  await writeManifest(getProjectPaths(cwd).manifestPath, manifest);

  return {
    addedKeys,
    removedKeys,
    conflicts: Array.from(conflictByKey.values()),
    warnings: [],
  };
}

function getRemovalConflict(entry: ManifestEntry, state: ProjectState): string | undefined {
  if (entry.settingsChanges.length > 0 && state.settingsError) {
    return `managed extension '${entry.label}' cannot be removed because .pi/settings.json is invalid`;
  }
  if (entry.type === "mcp" && state.mcpError) {
    return `managed mcp server '${entry.label}' cannot be removed because .pi/mcp.json is invalid`;
  }
  return undefined;
}

async function installCatalogItem(item: CatalogItem, cwd: string, state: ProjectState): Promise<ManifestEntry> {
  const installedAt = new Date().toISOString();

  switch (item.type) {
    case "skill": {
      const targetDir = resolveProjectPath(cwd, ".pi", "skills", item.id);
      await mkdir(dirname(targetDir), { recursive: true });
      await cp(item.sourceDir, targetDir, { recursive: true });
      return {
        key: item.key,
        type: item.type,
        category: item.category,
        id: item.id,
        label: item.label,
        installMode: item.installMode,
        sourcePath: item.sourcePath,
        targetPaths: [targetDir],
        settingsChanges: [],
        installedAt,
        catalogFingerprint: item.catalogFingerprint,
      };
    }
    case "prompt": {
      const targetFile = resolveProjectPath(cwd, ".pi", "prompts", item.fileName);
      await mkdir(dirname(targetFile), { recursive: true });
      await cp(item.sourceFile, targetFile);
      return {
        key: item.key,
        type: item.type,
        category: item.category,
        id: item.id,
        label: item.label,
        installMode: item.installMode,
        sourcePath: item.sourcePath,
        targetPaths: [targetFile],
        settingsChanges: [],
        installedAt,
        catalogFingerprint: item.catalogFingerprint,
      };
    }
    case "extension": {
      if (item.extensionKind === "single-file") {
        const targetFile = resolveProjectPath(cwd, ".pi", "extensions", item.entryName);
        await mkdir(dirname(targetFile), { recursive: true });
        await cp(item.sourceFileOrDir, targetFile);
        return {
          key: item.key,
          type: item.type,
          category: item.category,
          id: item.id,
          label: item.label,
          installMode: item.installMode,
          sourcePath: item.sourcePath,
          targetPaths: [targetFile],
          settingsChanges: [],
          installedAt,
          catalogFingerprint: item.catalogFingerprint,
          extensionKind: item.extensionKind,
        };
      }

      const targetDir = resolveProjectPath(cwd, ".pi", "ephemeral", "extensions", item.entryName);
      await mkdir(dirname(targetDir), { recursive: true });
      await cp(item.sourceFileOrDir, targetDir, { recursive: true });

      const settingsValue = resolve(targetDir);
      state.settingsJson = await addExtensionSetting(state.paths.settingsPath, settingsValue, state.settingsJson);

      return {
        key: item.key,
        type: item.type,
        category: item.category,
        id: item.id,
        label: item.label,
        installMode: item.installMode,
        sourcePath: item.sourcePath,
        targetPaths: [targetDir],
        settingsChanges: [{
          file: state.paths.settingsPath,
          kind: "extensions",
          value: settingsValue,
        }],
        installedAt,
        catalogFingerprint: item.catalogFingerprint,
        extensionKind: item.extensionKind,
      };
    }
    case "mcp": {
      const nextMcp = cloneProjectMcp(state.mcpJson);
      nextMcp.mcpServers ??= {};
      nextMcp.mcpServers[item.serverName] = item.serverConfig;
      await writeProjectMcp(state.paths.projectMcpPath, nextMcp);
      state.mcpJson = nextMcp;
      return {
        key: item.key,
        type: item.type,
        category: item.category,
        id: item.id,
        label: item.label,
        installMode: item.installMode,
        sourcePath: item.sourcePath,
        targetPaths: [state.paths.projectMcpPath],
        settingsChanges: [],
        installedAt,
        catalogFingerprint: item.catalogFingerprint,
        serverName: item.serverName,
      };
    }
  }
}

async function removeManagedEntry(entry: ManifestEntry, state: ProjectState): Promise<void> {
  switch (entry.type) {
    case "skill":
    case "prompt":
    case "extension": {
      await Promise.all(entry.targetPaths.map((targetPath) => rm(targetPath, { recursive: true, force: true })));

      if (entry.settingsChanges.length === 0) {
        break;
      }

      if (state.settingsError) {
        throw new Error(`Cannot remove managed extension '${entry.id}' because .pi/settings.json is invalid`);
      }

      const extensionValuesToRemove = entry.settingsChanges.flatMap((change) => (change.kind === "extensions" ? [change.value] : []));
      if (extensionValuesToRemove.length > 0) {
        state.settingsJson = await removeExtensionSettings(
          entry.settingsChanges[0]!.file,
          extensionValuesToRemove,
          state.settingsJson,
        );
      }
      break;
    }
    case "mcp": {
      if (state.mcpError) {
        throw new Error(`Cannot remove managed MCP server '${entry.id}' because .pi/mcp.json is invalid`);
      }

      const nextMcp = cloneProjectMcp(state.mcpJson);
      nextMcp.mcpServers ??= {};
      delete nextMcp.mcpServers[entry.serverName!];
      await writeProjectMcp(state.paths.projectMcpPath, nextMcp);
      state.mcpJson = nextMcp;
      break;
    }
  }
}

async function addExtensionSetting(settingsPath: string, value: string, initialSettings?: ProjectSettingsJson): Promise<ProjectSettingsJson> {
  const settings = cloneProjectSettings(initialSettings);
  const nextValues = Array.from(new Set<string>([...(settings.extensions ?? []), value]))
    .sort((left, right) => left.localeCompare(right));
  settings.extensions = nextValues;
  await writeSettings(settingsPath, settings);
  return settings;
}

async function removeExtensionSettings(
  settingsPath: string,
  valuesToRemove: string[],
  initialSettings?: ProjectSettingsJson,
): Promise<ProjectSettingsJson> {
  const settings = cloneProjectSettings(initialSettings);
  const valuesToRemoveSet = new Set(valuesToRemove);
  const nextValues = (settings.extensions ?? [])
    .filter((entry) => !valuesToRemoveSet.has(entry))
    .sort((left, right) => left.localeCompare(right));

  if (nextValues.length > 0) settings.extensions = nextValues;
  else delete settings.extensions;

  await writeSettings(settingsPath, settings);
  return settings;
}

function setDifference<T>(left: Set<T>, right: Set<T>): T[] {
  return Array.from(left).filter((value) => !right.has(value));
}

function cloneProjectSettings(value?: ProjectSettingsJson): ProjectSettingsJson {
  if (!value) {
    return {};
  }

  return value.extensions
    ? { ...value, extensions: [...value.extensions] }
    : { ...value };
}

async function writeSettings(settingsPath: string, settings: ProjectSettingsJson): Promise<void> {
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, ensureTrailingNewline(JSON.stringify(settings, null, 2)), "utf8");
}

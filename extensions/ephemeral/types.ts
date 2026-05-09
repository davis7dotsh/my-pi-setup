export type JsonPrimitive = string | number | boolean | null;
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export type EphemeralCategory = "skills" | "prompts" | "extensions" | "mcp";
export type EphemeralResourceType = "skill" | "prompt" | "extension" | "mcp";
export type InstallMode = "copy" | "reference" | "merge";
export type PreviewFormat = "markdown" | "text" | "json";
export type ExtensionCatalogKind = "single-file" | "package";

export interface CatalogItemBase {
  key: string;
  id: string;
  label: string;
  description: string;
  type: EphemeralResourceType;
  category: EphemeralCategory;
  sourcePath: string;
  catalogFingerprint: string;
  previewTitle: string;
  previewFormat: PreviewFormat;
  previewContent: string;
  sortText: string;
}

export interface SkillCatalogItem extends CatalogItemBase {
  type: "skill";
  category: "skills";
  installMode: "copy";
  sourceDir: string;
}

export interface PromptCatalogItem extends CatalogItemBase {
  type: "prompt";
  category: "prompts";
  installMode: "copy";
  sourceFile: string;
  fileName: string;
}

export interface ExtensionCatalogItem extends CatalogItemBase {
  type: "extension";
  category: "extensions";
  installMode: "copy" | "reference";
  extensionKind: ExtensionCatalogKind;
  sourceFileOrDir: string;
  entryName: string;
  packageName?: string;
}

export type ProjectMcpServerConfig = JsonObject;

export interface McpCatalogItem extends CatalogItemBase {
  type: "mcp";
  category: "mcp";
  installMode: "merge";
  sourceFile: string;
  serverName: string;
  serverConfig: ProjectMcpServerConfig;
}

export type CatalogItem = SkillCatalogItem | PromptCatalogItem | ExtensionCatalogItem | McpCatalogItem;

export interface CatalogData {
  items: CatalogItem[];
  byKey: Map<string, CatalogItem>;
  byCategory: Record<EphemeralCategory, CatalogItem[]>;
  warnings: string[];
  catalogRoot: string;
}

export interface SettingChange {
  file: string;
  kind: "extensions";
  value: string;
}

export interface ManifestEntry {
  key: string;
  type: EphemeralResourceType;
  category: EphemeralCategory;
  id: string;
  label: string;
  installMode: InstallMode;
  sourcePath: string;
  targetPaths: string[];
  settingsChanges: SettingChange[];
  installedAt: string;
  catalogFingerprint: string;
  extensionKind?: ExtensionCatalogKind;
  serverName?: string;
}

export interface EphemeralManifest {
  version: 1;
  items: Record<string, ManifestEntry>;
}

export type ProjectSettingsJson = JsonObject & {
  extensions?: string[];
};

export type ProjectMcpJson = JsonObject & {
  mcpServers?: Record<string, ProjectMcpServerConfig>;
};

export interface ProjectPaths {
  manifestPath: string;
  settingsPath: string;
  projectMcpPath: string;
}

export interface ProjectState {
  cwd: string;
  paths: ProjectPaths;
  manifest: EphemeralManifest;
  settingsJson?: ProjectSettingsJson;
  settingsError?: string;
  mcpJson?: ProjectMcpJson;
  mcpError?: string;
  warnings: string[];
}

export interface PendingChangeSummary {
  additions: CatalogItem[];
  removals: ManifestEntry[];
}

export interface ApplyConflict {
  key: string;
  message: string;
}

export interface ApplyResult {
  addedKeys: string[];
  removedKeys: string[];
  conflicts: ApplyConflict[];
  warnings: string[];
}

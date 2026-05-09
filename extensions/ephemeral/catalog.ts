import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { CatalogData, CatalogItem, EphemeralCategory, ExtensionCatalogItem, McpCatalogItem, ProjectMcpServerConfig, PromptCatalogItem, SkillCatalogItem } from "./types.ts";
import {
  CATALOG_ROOT,
  computeFingerprint,
  getDirectoryEntryNames,
  getFirstNonEmptyLine,
  isJsonObject,
  listImmediateDirectories,
  listImmediateFiles,
  parseMarkdownFrontmatter,
  prettyJson,
  resourceKey,
  summarizeMcpServer,
} from "./util.ts";

const CATEGORY_ORDER: EphemeralCategory[] = ["skills", "prompts", "extensions", "mcp"];

interface ScanResult<T extends CatalogItem> {
  items: T[];
  warnings: string[];
}

interface EntryScanResult<T extends CatalogItem> {
  item?: T;
  warnings: string[];
}

export async function scanCatalog(): Promise<CatalogData> {
  const [skills, prompts, extensions, mcp] = await Promise.all([
    scanSkills(),
    scanPrompts(),
    scanExtensions(),
    scanMcp(),
  ]);

  const warnings = [...skills.warnings, ...prompts.warnings, ...extensions.warnings, ...mcp.warnings];
  const items = [...skills.items, ...prompts.items, ...extensions.items, ...mcp.items];

  items.sort((left, right) => {
    const categoryDiff = CATEGORY_ORDER.indexOf(left.category) - CATEGORY_ORDER.indexOf(right.category);
    if (categoryDiff !== 0) return categoryDiff;
    return left.sortText.localeCompare(right.sortText);
  });

  const byCategory: Record<EphemeralCategory, CatalogItem[]> = {
    skills: [],
    prompts: [],
    extensions: [],
    mcp: [],
  };
  const byKey = new Map<string, CatalogItem>();

  for (const item of items) {
    if (byKey.has(item.key)) {
      warnings.push(`Duplicate catalog item key ignored: ${item.key}`);
      continue;
    }
    byKey.set(item.key, item);
    byCategory[item.category].push(item);
  }

  return {
    items: Array.from(byKey.values()),
    byKey,
    byCategory,
    warnings,
    catalogRoot: CATALOG_ROOT,
  };
}

async function scanSkills(): Promise<ScanResult<SkillCatalogItem>> {
  const skillsRoot = join(CATALOG_ROOT, "skills");
  const directories = await listImmediateDirectories(skillsRoot);
  const results = await Promise.all(directories.map((directory) => scanSkillDirectory(directory)));
  return collectResults(results);
}

async function scanPrompts(): Promise<ScanResult<PromptCatalogItem>> {
  const promptsRoot = join(CATALOG_ROOT, "prompts");
  const files = await listImmediateFiles(promptsRoot, (fileName) => fileName.endsWith(".md"));
  const results = await Promise.all(files.map((file) => scanPromptFile(file)));
  return collectResults(results);
}

async function scanExtensions(): Promise<ScanResult<ExtensionCatalogItem>> {
  const extensionsRoot = join(CATALOG_ROOT, "extensions");
  const [files, directories] = await Promise.all([
    listImmediateFiles(extensionsRoot, (fileName) => fileName.endsWith(".ts")),
    listImmediateDirectories(extensionsRoot),
  ]);

  const [fileResults, directoryResults] = await Promise.all([
    Promise.all(files.map((file) => scanSingleFileExtension(file))),
    Promise.all(directories.map((directory) => scanPackageExtensionDirectory(directory))),
  ]);

  return collectResults([...fileResults, ...directoryResults]);
}

async function scanMcp(): Promise<ScanResult<McpCatalogItem>> {
  const mcpFile = join(CATALOG_ROOT, "mcp", "mcp.json");
  if (!existsSync(mcpFile)) {
    return { items: [], warnings: [] };
  }

  try {
    const [content, catalogFingerprint] = await Promise.all([
      readFile(mcpFile, "utf8"),
      computeFingerprint(mcpFile),
    ]);

    const parsed = JSON.parse(content) as unknown;
    if (!isJsonObject(parsed)) {
      throw new Error("Invalid MCP catalog file");
    }

    const mcpServersValue = parsed.mcpServers;
    if (mcpServersValue !== undefined && !isJsonObject(mcpServersValue)) {
      throw new Error("Invalid MCP catalog file");
    }

    const warnings: string[] = [];
    const items: McpCatalogItem[] = [];
    const servers = (mcpServersValue ?? {}) as Record<string, ProjectMcpServerConfig>;
    const sortedServers = Object.entries(servers).sort(([left], [right]) => left.localeCompare(right));

    for (const [serverName, serverConfig] of sortedServers) {
      if (!isJsonObject(serverConfig)) {
        warnings.push(`Skipping invalid MCP catalog server: ${serverName}`);
        continue;
      }

      items.push({
        key: resourceKey("mcp", serverName),
        id: serverName,
        label: serverName,
        description: summarizeMcpServer(serverName, serverConfig),
        type: "mcp",
        category: "mcp",
        sourcePath: `${mcpFile}#mcpServers.${serverName}`,
        sourceFile: mcpFile,
        serverName,
        serverConfig,
        installMode: "merge",
        catalogFingerprint,
        previewTitle: serverName,
        previewFormat: "json",
        previewContent: prettyJson({ [serverName]: serverConfig }),
        sortText: serverName.toLowerCase(),
      });
    }

    return { items, warnings };
  } catch {
    return {
      items: [],
      warnings: [`Unable to read MCP catalog file: ${mcpFile}`],
    };
  }
}

async function scanSkillDirectory(directory: string): Promise<EntryScanResult<SkillCatalogItem>> {
  const skillFile = join(directory, "SKILL.md");

  try {
    const [content, catalogFingerprint] = await Promise.all([
      readFile(skillFile, "utf8"),
      computeFingerprint(directory),
    ]);

    const { frontmatter, body } = parseMarkdownFrontmatter(content);
    const skillName = frontmatter.name?.trim() || basename(directory);
    const description = frontmatter.description?.trim() || getFirstNonEmptyLine(body);

    return {
      item: {
        key: resourceKey("skill", skillName),
        id: skillName,
        label: skillName,
        description,
        type: "skill",
        category: "skills",
        sourcePath: directory,
        sourceDir: directory,
        installMode: "copy",
        catalogFingerprint,
        previewTitle: skillName,
        previewFormat: "markdown",
        previewContent: content,
        sortText: skillName.toLowerCase(),
      },
      warnings: [],
    };
  } catch {
    return {
      warnings: [`Skipping skill without readable SKILL.md: ${directory}`],
    };
  }
}

async function scanPromptFile(file: string): Promise<EntryScanResult<PromptCatalogItem>> {
  try {
    const [content, catalogFingerprint] = await Promise.all([
      readFile(file, "utf8"),
      computeFingerprint(file),
    ]);

    const { frontmatter, body } = parseMarkdownFrontmatter(content);
    const fileName = basename(file);
    const label = basename(file, ".md");
    const description = frontmatter.description?.trim() || getFirstNonEmptyLine(body);

    return {
      item: {
        key: resourceKey("prompt", label),
        id: label,
        label,
        description,
        type: "prompt",
        category: "prompts",
        sourcePath: file,
        sourceFile: file,
        fileName,
        installMode: "copy",
        catalogFingerprint,
        previewTitle: label,
        previewFormat: "markdown",
        previewContent: content,
        sortText: label.toLowerCase(),
      },
      warnings: [],
    };
  } catch {
    return {
      warnings: [`Skipping unreadable prompt: ${file}`],
    };
  }
}

async function scanSingleFileExtension(file: string): Promise<EntryScanResult<ExtensionCatalogItem>> {
  const name = basename(file, extname(file));

  try {
    const [previewContent, catalogFingerprint] = await Promise.all([
      readFile(file, "utf8"),
      computeFingerprint(file),
    ]);

    return {
      item: {
        key: resourceKey("extension", name),
        id: name,
        label: name,
        description: "",
        type: "extension",
        category: "extensions",
        sourcePath: file,
        sourceFileOrDir: file,
        entryName: basename(file),
        extensionKind: "single-file",
        installMode: "copy",
        catalogFingerprint,
        previewTitle: name,
        previewFormat: "text",
        previewContent,
        sortText: name.toLowerCase(),
      },
      warnings: [],
    };
  } catch {
    return {
      warnings: [`Skipping unreadable extension file: ${file}`],
    };
  }
}

async function scanPackageExtensionDirectory(directory: string): Promise<EntryScanResult<ExtensionCatalogItem>> {
  const packageJsonPath = join(directory, "package.json");
  const indexPath = join(directory, "index.ts");
  const entryNames = await getDirectoryEntryNames(directory);
  const hasPackageJson = entryNames.includes("package.json");
  const hasIndexTs = entryNames.includes("index.ts");
  if (!hasPackageJson && !hasIndexTs) {
    return { warnings: [] };
  }

  const warnings: string[] = [];
  const catalogFingerprintPromise = computeFingerprint(directory);
  let packageName = basename(directory);
  let description = "";
  let packageSummary = "";

  if (hasPackageJson) {
    try {
      const rawPackageJson = await readFile(packageJsonPath, "utf8");
      packageSummary = rawPackageJson;
      const parsed = JSON.parse(rawPackageJson) as { name?: string; description?: string };
      packageName = parsed.name?.trim() || packageName;
      description = parsed.description?.trim() || "";
    } catch {
      warnings.push(`Failed to parse extension package.json: ${packageJsonPath}`);
    }
  }

  try {
    const catalogFingerprint = await catalogFingerprintPromise;
    const previewLines = [
      `Label: ${packageName}`,
      `Type: package extension`,
      `Source: ${directory}`,
      description ? `Description: ${description}` : "Description: (none)",
      hasIndexTs ? `Entry: ${indexPath}` : "Entry: package.json manifest",
      packageSummary ? "" : undefined,
      packageSummary ? "package.json:" : undefined,
      packageSummary ? packageSummary : undefined,
    ].filter((line): line is string => typeof line === "string");

    return {
      item: {
        key: resourceKey("extension", packageName),
        id: packageName,
        label: packageName,
        description,
        type: "extension",
        category: "extensions",
        sourcePath: directory,
        sourceFileOrDir: directory,
        entryName: basename(directory),
        packageName,
        extensionKind: "package",
        installMode: "reference",
        catalogFingerprint,
        previewTitle: packageName,
        previewFormat: "text",
        previewContent: previewLines.join("\n"),
        sortText: packageName.toLowerCase(),
      },
      warnings,
    };
  } catch {
    return {
      warnings: [...warnings, `Skipping unreadable extension directory: ${directory}`],
    };
  }
}

function collectResults<T extends CatalogItem>(results: EntryScanResult<T>[]): ScanResult<T> {
  const items: T[] = [];
  const warnings: string[] = [];

  for (const result of results) {
    if (result.item) {
      items.push(result.item);
    }
    warnings.push(...result.warnings);
  }

  return { items, warnings };
}

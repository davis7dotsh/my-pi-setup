import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProjectMcpJson, ProjectMcpServerConfig } from "./types.ts";
import { ensureTrailingNewline, isJsonObject } from "./util.ts";

export async function readProjectMcp(projectMcpPath: string): Promise<ProjectMcpJson | undefined> {
  let raw: string;
  try {
    raw = await readFile(projectMcpPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isJsonObject(parsed)) {
    throw new Error(`Invalid project MCP config: ${projectMcpPath}`);
  }

  if (parsed.mcpServers !== undefined) {
    assertProjectMcpServers(parsed.mcpServers, projectMcpPath);
  }

  return parsed as ProjectMcpJson;
}

export function cloneProjectMcp(value?: ProjectMcpJson): ProjectMcpJson {
  if (!value) {
    return { mcpServers: {} };
  }

  const mcpServers = value.mcpServers
    ? Object.fromEntries(Object.entries(value.mcpServers).map(([serverName, serverConfig]) => [serverName, { ...serverConfig }]))
    : {};

  return {
    ...value,
    mcpServers,
  };
}

export async function writeProjectMcp(projectMcpPath: string, value: ProjectMcpJson): Promise<void> {
  await mkdir(dirname(projectMcpPath), { recursive: true });
  await writeFile(projectMcpPath, ensureTrailingNewline(JSON.stringify(value, null, 2)), "utf8");
}

function assertProjectMcpServers(value: unknown, projectMcpPath: string): asserts value is Record<string, ProjectMcpServerConfig> {
  if (!isJsonObject(value)) {
    throw new Error(`Invalid project MCP config: ${projectMcpPath}`);
  }

  for (const [serverName, serverConfig] of Object.entries(value)) {
    if (!isJsonObject(serverConfig)) {
      throw new Error(`Invalid MCP server config for '${serverName}': ${projectMcpPath}`);
    }
  }
}

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@mariozechner/pi-coding-agent";
import type { McpExtensionState } from "./state.js";
import { Type } from "@sinclair/typebox";
import { showStatus, showTools, reconnectServers, authenticateServer, removeAuth, openMcpPanel } from "./commands.js";
import { loadMcpConfig } from "./config.js";
import { buildProxyDescription, createDirectToolExecutor, renderDirectToolCall, resolveDirectTools } from "./direct-tools.js";
import { flushMetadataCache, initializeMcp, updateStatusBar } from "./init.js";
import { loadMetadataCache } from "./metadata-cache.js";
import { McpOAuthCallback } from "./mcp-oauth-callback.js";
import { executeCall, executeConnect, executeDescribe, executeList, executeSearch, executeStatus, executeUiMessages } from "./proxy-modes.js";
import { getConfigPathFromArgv, truncateAtWord } from "./utils.js";
import { Text } from "@mariozechner/pi-tui";

type McpProxyParams = {
  tool?: string;
  args?: string;
  connect?: string;
  describe?: string;
  search?: string;
  regex?: boolean;
  includeSchemas?: boolean;
  server?: string;
  action?: string;
};

function formatMcpProxyArgs(input: unknown): string {
  const params = (input && typeof input === "object" && !Array.isArray(input)) ? input as McpProxyParams : {};
  if (params.tool) {
    let text = `call ${params.server ? `${params.server}/` : ""}${params.tool}`;
    if (params.args) {
      try {
        text += `\narguments:\n${JSON.stringify(JSON.parse(params.args), null, 2)}`;
      } catch {
        text += `\narguments:\n${params.args}`;
      }
    } else {
      text += `\narguments:\n{}`;
    }
    return text;
  }

  if (params.connect) return `connect ${params.connect}`;
  if (params.describe) return `describe ${params.describe}`;
  if (params.search) return `search ${params.regex ? "(regex) " : ""}${params.search}`;
  if (params.server) return `list ${params.server}`;
  if (params.action) return `action ${params.action}`;
  return "status";
}

export default function mcpAdapter(pi: ExtensionAPI) {
  let state: McpExtensionState | null = null;
  let initPromise: Promise<McpExtensionState> | null = null;
  let initGeneration = 0;

  async function disposeState(current: McpExtensionState | null, reason: string): Promise<void> {
    if (!current) return;

    if (current.uiServer) {
      current.uiServer.close(reason);
      current.uiServer = null;
    }

    flushMetadataCache(current);
    await current.lifecycle.gracefulShutdown();

    if (current.ui) {
      current.ui.setStatus("mcp", "");
    }
  }

  async function cleanupCurrentState(reason: string): Promise<void> {
    const current = state;
    state = null;
    initPromise = null;

    await McpOAuthCallback.stop().catch(() => {});
    await disposeState(current, reason);
  }

  const earlyConfigPath = getConfigPathFromArgv();
  const earlyConfig = loadMcpConfig(earlyConfigPath);
  const earlyCache = loadMetadataCache();
  const prefix = earlyConfig.settings?.toolPrefix ?? "server";

  const envRaw = process.env.MCP_DIRECT_TOOLS;
  const directSpecs = envRaw === "__none__"
    ? []
    : resolveDirectTools(
        earlyConfig,
        earlyCache,
        prefix,
        envRaw?.split(",").map(s => s.trim()).filter(Boolean),
      );

  for (const spec of directSpecs) {
    pi.registerTool({
      name: spec.prefixedName,
      label: `MCP: ${spec.originalName}`,
      description: spec.description || "(no description)",
      promptSnippet: truncateAtWord(spec.description, 100) || `MCP tool from ${spec.serverName}`,
      parameters: Type.Unsafe<Record<string, unknown>>(spec.inputSchema || { type: "object", properties: {} }),
      execute: createDirectToolExecutor(() => state, () => initPromise, spec),
      renderCall: renderDirectToolCall(spec),
    });
  }

  const getPiTools = (): ToolInfo[] => pi.getAllTools();

  pi.registerFlag("mcp-config", {
    description: "Path to MCP config file",
    type: "string",
  });

  pi.on("session_start", async (event, ctx) => {
    const generation = ++initGeneration;
    await cleanupCurrentState(`session_start:${event.reason}`);

    const promise = initializeMcp(pi, ctx);
    initPromise = promise;

    promise.then(async (s) => {
      if (generation !== initGeneration) {
        await disposeState(s, "stale_init");
        return;
      }

      state = s;
      if (initPromise === promise) {
        initPromise = null;
      }
      updateStatusBar(s);
    }).catch(err => {
      if (generation !== initGeneration) {
        return;
      }

      console.error("MCP initialization failed:", err);
      if (initPromise === promise) {
        initPromise = null;
      }
    });
  });

  pi.on("session_shutdown", async () => {
    initGeneration++;
    await cleanupCurrentState("session_shutdown");
  });

  pi.registerCommand("mcp", {
    description: "Show MCP server status",
    getArgumentCompletions: (prefix: string) => {
      const config = state?.config ?? earlyConfig;
      const parts = prefix.split(/\s+/);

      if (parts.length <= 1) {
        const subcommands = [
          { value: "reconnect", label: "reconnect  (reconnect servers)" },
          { value: "tools", label: "tools  (list all tools)" },
          { value: "status", label: "status  (show server status)" },
        ];
        const filtered = prefix ? subcommands.filter(i => i.value.startsWith(prefix)) : subcommands;
        return filtered.length > 0 ? filtered : null;
      }

      // "/mcp reconnect ..." → complete server names
      if (parts[0] === "reconnect" && parts.length <= 2) {
        const partial = parts[1] ?? "";
        const servers = Object.keys(config.mcpServers);
        const items = servers.map(name => ({ value: `reconnect ${name}`, label: name }));
        const filtered = partial ? items.filter(i => i.label.startsWith(partial)) : items;
        return filtered.length > 0 ? filtered : null;
      }

      return null;
    },
    handler: async (args, ctx) => {
      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch {
          if (ctx.hasUI) ctx.ui.notify("MCP initialization failed", "error");
          return;
        }
      }
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }

      const parts = args?.trim()?.split(/\s+/) ?? [];
      const subcommand = parts[0] ?? "";
      const targetServer = parts[1];

      switch (subcommand) {
        case "reconnect":
          await reconnectServers(state, ctx, targetServer);
          break;
        case "tools":
          await showTools(state, ctx);
          break;
        case "status":
        case "":
        default:
          if (ctx.hasUI) {
            await openMcpPanel(state, pi, ctx, earlyConfigPath);
          } else {
            await showStatus(state, ctx);
          }
          break;
      }
    },
  });

  pi.registerCommand("mcp-auth", {
    description: "Authenticate with an MCP server (OAuth). Use 'remove <server>' to clear credentials.",
    getArgumentCompletions: (prefix: string) => {
      const config = state?.config ?? earlyConfig;
      const servers = Object.entries(config.mcpServers)
        .filter(([, def]) => def.auth === "oauth")
        .map(([name]) => name);

      const parts = prefix.split(/\s+/);

      // "/mcp-auth rem..." → complete "remove"
      if (parts.length <= 1) {
        const items = [
          ...servers.map(name => ({ value: name, label: `${name}  (authenticate)` })),
          { value: "remove", label: "remove  (clear credentials)" },
        ];
        const filtered = prefix ? items.filter(i => i.value.startsWith(prefix)) : items;
        return filtered.length > 0 ? filtered : null;
      }

      // "/mcp-auth remove ..." → complete server names
      if (parts[0] === "remove" && parts.length <= 2) {
        const partial = parts[1] ?? "";
        // For remove, show all OAuth servers (even those without stored tokens)
        const items = servers.map(name => ({ value: `remove ${name}`, label: name }));
        const filtered = partial ? items.filter(i => i.label.startsWith(partial)) : items;
        return filtered.length > 0 ? filtered : null;
      }

      return null;
    },
    handler: async (args, ctx) => {
      const parts = args?.trim().split(/\s+/) ?? [];
      const subcommand = parts[0] ?? "";

      if (!subcommand) {
        if (ctx.hasUI) ctx.ui.notify("Usage: /mcp-auth <server-name>\n       /mcp-auth remove <server-name>", "error");
        return;
      }

      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch {
          if (ctx.hasUI) ctx.ui.notify("MCP initialization failed", "error");
          return;
        }
      }
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }

      if (subcommand === "remove") {
        const serverName = parts[1];
        if (!serverName) {
          if (ctx.hasUI) ctx.ui.notify("Usage: /mcp-auth remove <server-name>", "error");
          return;
        }
        await removeAuth(serverName, ctx);
        return;
      }

      // Default: authenticate
      await authenticateServer(subcommand, state.config, ctx, state);
    },
  });

  pi.registerTool({
    name: "mcp",
    label: "MCP",
    description: buildProxyDescription(earlyConfig, earlyCache, directSpecs),
    promptSnippet: "MCP gateway - connect to MCP servers and call their tools",
    parameters: Type.Object({
      tool: Type.Optional(Type.String({ description: "Tool name to call (e.g., 'xcodebuild_list_sims')" })),
      args: Type.Optional(Type.String({ description: "Arguments as JSON string (e.g., '{\"key\": \"value\"}')" })),
      connect: Type.Optional(Type.String({ description: "Server name to connect (lazy connect + metadata refresh)" })),
      describe: Type.Optional(Type.String({ description: "Tool name to describe (shows parameters)" })),
      search: Type.Optional(Type.String({ description: "Search tools by name/description" })),
      regex: Type.Optional(Type.Boolean({ description: "Treat search as regex (default: substring match)" })),
      includeSchemas: Type.Optional(Type.Boolean({ description: "Include parameter schemas in search results (default: true)" })),
      server: Type.Optional(Type.String({ description: "Filter to specific server (also disambiguates tool calls)" })),
      action: Type.Optional(Type.String({ description: "Action: 'ui-messages' to retrieve prompts/intents from UI sessions" })),
    }),
    renderCall(params, theme) {
      const text = theme.fg("toolTitle", theme.bold("mcp")) + " " + theme.fg("muted", formatMcpProxyArgs(params));
      return new Text(text, 0, 0);
    },
    async execute(_toolCallId, params: McpProxyParams, _signal, _onUpdate, _ctx) {
      let parsedArgs: Record<string, unknown> | undefined;
      if (params.args) {
        try {
          parsedArgs = JSON.parse(params.args);
          if (typeof parsedArgs !== "object" || parsedArgs === null || Array.isArray(parsedArgs)) {
            const gotType = Array.isArray(parsedArgs) ? "array" : parsedArgs === null ? "null" : typeof parsedArgs;
            return {
              content: [{ type: "text" as const, text: `Invalid args: expected a JSON object, got ${gotType}` }],
              isError: true,
              details: { error: "invalid_args_type" },
            };
          }
        } catch (e) {
          return {
            content: [{ type: "text" as const, text: `Invalid args JSON: ${e instanceof Error ? e.message : e}` }],
            isError: true,
            details: { error: "invalid_args" },
          };
        }
      }

      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch {
          return {
            content: [{ type: "text" as const, text: "MCP initialization failed" }],
            details: { error: "init_failed" },
          };
        }
      }
      if (!state) {
        return {
          content: [{ type: "text" as const, text: "MCP not initialized" }],
          details: { error: "not_initialized" },
        };
      }

      if (params.action === "ui-messages") {
        return executeUiMessages(state);
      }
      if (params.tool) {
        return executeCall(state, params.tool, parsedArgs, params.server);
      }
      if (params.connect) {
        return executeConnect(state, params.connect);
      }
      if (params.describe) {
        return executeDescribe(state, params.describe);
      }
      if (params.search) {
        return executeSearch(state, params.search, params.regex, params.server, params.includeSchemas, getPiTools);
      }
      if (params.server) {
        return executeList(state, params.server);
      }
      return executeStatus(state);
    },
  });
}

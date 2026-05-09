import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { McpExtensionState } from "./state.js";
import type { McpConfig, ServerEntry, McpPanelCallbacks, McpPanelResult } from "./types.js";
import { getServerProvenance, writeDirectToolsConfig } from "./config.js";
import { lazyConnect, updateMetadataCache, updateStatusBar, getFailureAgeSeconds } from "./init.js";
import { NeedsAuthError } from "./errors.js";
import { loadMetadataCache } from "./metadata-cache.js";
import { McpAuth } from "./mcp-auth.js";
import { McpOAuthProvider } from "./mcp-oauth-provider.js";
import { McpOAuthCallback } from "./mcp-oauth-callback.js";
import { buildToolMetadata } from "./tool-metadata.js";
import { logger } from "./logger.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomBytes } from "node:crypto";

export async function showStatus(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  const lines: string[] = ["MCP Server Status:", ""];

  for (const name of Object.keys(state.config.mcpServers)) {
    const connection = state.manager.getConnection(name);
    const metadata = state.toolMetadata.get(name);
    const toolCount = metadata?.length ?? 0;
    const failedAgo = getFailureAgeSeconds(state, name);
    const definition = state.config.mcpServers[name];
    let status = "not connected";
    let statusIcon = "○";
    let failed = false;

    if (connection?.status === "connected") {
      status = "connected";
      statusIcon = "✓";
    } else if (state.needsAuth.has(name)) {
      status = "needs auth";
      statusIcon = "🔑";
    } else if (failedAgo !== null) {
      status = `failed ${failedAgo}s ago`;
      statusIcon = "✗";
      failed = true;
    } else if (metadata !== undefined) {
      status = "cached";
    }

    // Show auth status for OAuth servers
    if (definition?.auth === "oauth" && connection?.status === "connected") {
      const authStatus = McpAuth.getAuthStatus(name);
      if (authStatus === "expired") {
        status += " (token expired)";
      }
    }

    const toolSuffix = failed ? "" : ` (${toolCount} tools${status === "cached" ? ", cached" : ""})`;
    lines.push(`${statusIcon} ${name}: ${status}${toolSuffix}`);
  }

  if (Object.keys(state.config.mcpServers).length === 0) {
    lines.push("No MCP servers configured");
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

export async function showTools(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  const allTools = [...state.toolMetadata.values()].flat().map(m => m.name);

  if (allTools.length === 0) {
    ctx.ui.notify("No MCP tools available", "info");
    return;
  }

  const lines = [
    "MCP Tools:",
    "",
    ...allTools.map(t => `  ${t}`),
    "",
    `Total: ${allTools.length} tools`,
  ];

  ctx.ui.notify(lines.join("\n"), "info");
}

export async function reconnectServers(
  state: McpExtensionState,
  ctx: ExtensionContext,
  targetServer?: string
): Promise<void> {
  if (targetServer && !state.config.mcpServers[targetServer]) {
    if (ctx.hasUI) {
      ctx.ui.notify(`Server "${targetServer}" not found in config`, "error");
    }
    return;
  }

  const entries = targetServer
    ? [[targetServer, state.config.mcpServers[targetServer]] as [string, ServerEntry]]
    : Object.entries(state.config.mcpServers);

  for (const [name, definition] of entries) {
    try {
      await state.manager.close(name);

      const connection = await state.manager.connect(name, definition);
      const prefix = state.config.settings?.toolPrefix ?? "server";

      const { metadata, failedTools } = buildToolMetadata(connection.tools, connection.resources, definition, name, prefix);
      state.toolMetadata.set(name, metadata);
      updateMetadataCache(state, name);
      state.failureTracker.delete(name);
      state.needsAuth.delete(name);

      if (ctx.hasUI) {
        ctx.ui.notify(
          `MCP: Reconnected to ${name} (${connection.tools.length} tools, ${connection.resources.length} resources)`,
          "info"
        );
        if (failedTools.length > 0) {
          ctx.ui.notify(`MCP: ${name} - ${failedTools.length} tools skipped`, "warning");
        }
      }
    } catch (error) {
      if (error instanceof NeedsAuthError) {
        // Server still needs auth — clean up transport and mark it
        await error.transport.close().catch(() => {});
        state.needsAuth.add(name);
        if (ctx.hasUI) {
          ctx.ui.notify(`MCP: "${name}" requires authentication. Run /mcp-auth ${name}`, "warning");
        }
      } else {
        const message = error instanceof Error ? error.message : String(error);
        state.failureTracker.set(name, Date.now());
        if (ctx.hasUI) {
          ctx.ui.notify(`MCP: Failed to reconnect to ${name}: ${message}`, "error");
        }
      }
    }
  }

  updateStatusBar(state);
}

// ── OAuth Authentication Flow ──────────────────────────────────────────────

/**
 * Start the OAuth flow: create auth provider, trigger SDK auth, capture auth URL.
 */
async function startAuth(
  serverName: string,
  definition: ServerEntry,
): Promise<{ authorizationUrl: string; transport: StreamableHTTPClientTransport } | null> {
  // Start the callback server — get the actual port it bound to
  const callbackPort = await McpOAuthCallback.ensureRunning();

  // Generate and store state BEFORE creating the provider
  const oauthState = randomBytes(32).toString("hex");
  McpAuth.updateOAuthState(serverName, oauthState);

  // Create auth provider with the actual callback port
  let capturedUrl: URL | undefined;
  const authProvider = new McpOAuthProvider(
    serverName,
    definition.url!,
    {
      clientId: definition.oauthClientId,
      clientSecret: definition.oauthClientSecret,
      scope: definition.oauthScope,
    },
    {
      onRedirect: async (url) => {
        capturedUrl = url;
      },
    },
    callbackPort,
  );

  // Create transport with auth provider
  const transport = new StreamableHTTPClientTransport(new URL(definition.url!), {
    authProvider,
  });

  // Try to connect — this will trigger the OAuth flow
  const client = new Client({ name: "pi-mcp-oauth", version: "1.0.0" });
  try {
    await client.connect(transport);
    // If we get here, we're already authenticated (tokens were valid)
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    return null;
  } catch (error) {
    // Always close the probe client — we only need the transport for finishAuth()
    await client.close().catch(() => {});
    if ((error instanceof UnauthorizedError || (error instanceof Error && error.message.includes("OAuth"))) && capturedUrl) {
      return { authorizationUrl: capturedUrl.toString(), transport };
    }
    await transport.close().catch(() => {});
    throw error;
  }
}

/**
 * Complete OAuth: exchange auth code for tokens via transport.finishAuth().
 */
async function finishAuth(
  serverName: string,
  authorizationCode: string,
  transport: StreamableHTTPClientTransport,
): Promise<void> {
  await transport.finishAuth(authorizationCode);
  McpAuth.clearCodeVerifier(serverName);
  logger.debug(`${serverName}: oauth flow completed`);
}

/**
 * Full authenticate flow: start auth → open browser → wait for callback → finish auth → reconnect.
 */
export async function authenticateServer(
  serverName: string,
  config: McpConfig,
  ctx: ExtensionContext,
  state?: McpExtensionState,
): Promise<void> {
  if (!ctx.hasUI) return;

  const definition = config.mcpServers[serverName];
  if (!definition) {
    ctx.ui.notify(`Server "${serverName}" not found in config`, "error");
    return;
  }

  if (definition.auth !== "oauth") {
    ctx.ui.notify(
      `Server "${serverName}" does not use OAuth authentication.\n` +
      `Current auth mode: ${definition.auth ?? "none"}`,
      "error",
    );
    return;
  }

  if (!definition.url) {
    ctx.ui.notify(
      `Server "${serverName}" has no URL configured (OAuth requires HTTP transport)`,
      "error",
    );
    return;
  }

  ctx.ui.notify(`Starting OAuth flow for "${serverName}"...`, "info");

  // Track the transport so we can clean it up in all code paths
  let pendingTransport: StreamableHTTPClientTransport | undefined;

  try {
    // Start the auth flow
    const result = await startAuth(serverName, definition);

    if (!result) {
      // Already authenticated
      ctx.ui.notify(`"${serverName}" is already authenticated. Reconnecting...`, "info");
      if (state) {
        await reconnectServers(state, ctx, serverName);
      }
      return;
    }

    const { authorizationUrl, transport } = result;
    pendingTransport = transport;

    // Get the state that was stored in startAuth
    const oauthState = McpAuth.getOAuthState(serverName);
    if (!oauthState) {
      throw new Error("OAuth state not found — this should not happen");
    }

    // Register the callback BEFORE opening the browser
    const callbackPromise = McpOAuthCallback.waitForCallback(oauthState);

    // Open browser
    try {
      const { default: open } = await import("open");
      await open(authorizationUrl);
      ctx.ui.notify("Browser opened for authorization. Waiting for callback...", "info");
    } catch {
      // Browser opening failed (headless, SSH, etc.)
      ctx.ui.notify(
        `Could not open browser. Please open this URL manually:\n\n${authorizationUrl}`,
        "warning",
      );
    }

    // Wait for the callback
    const code = await callbackPromise;

    // Validate state
    const storedState = McpAuth.getOAuthState(serverName);
    if (storedState !== oauthState) {
      McpAuth.clearOAuthState(serverName);
      throw new Error("OAuth state mismatch — potential CSRF attack");
    }
    McpAuth.clearOAuthState(serverName);

    // Exchange code for tokens
    await finishAuth(serverName, code, transport);

    ctx.ui.notify(`✓ "${serverName}" authenticated successfully!`, "info");

    // Reconnect with the new tokens
    if (state) {
      state.needsAuth.delete(serverName);
      await reconnectServers(state, ctx, serverName);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`OAuth failed for "${serverName}": ${message}`, "error");
    logger.debug(`${serverName}: oauth error: ${message}`);
  } finally {
    // Always close the auth transport — reconnectServers() creates its own
    await pendingTransport?.close().catch(() => {});
  }
}

/**
 * Remove stored OAuth credentials for a server.
 */
export async function removeAuth(
  serverName: string,
  ctx: ExtensionContext,
): Promise<void> {
  if (!ctx.hasUI) return;

  // Read the OAuth state BEFORE deleting so we can cancel any pending auth
  const oauthState = McpAuth.getOAuthState(serverName);
  if (oauthState) {
    McpOAuthCallback.cancelPending(oauthState);
  }

  McpAuth.remove(serverName);
  ctx.ui.notify(`Removed OAuth credentials for "${serverName}"`, "info");
}

// ── MCP Panel ──────────────────────────────────────────────────────────────

export async function openMcpPanel(
  state: McpExtensionState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configOverridePath?: string,
): Promise<void> {
  const config = state.config;
  const cache = loadMetadataCache();
  const provenanceMap = getServerProvenance(pi.getFlag("mcp-config") as string | undefined ?? configOverridePath);

  const callbacks: McpPanelCallbacks = {
    reconnect: async (serverName: string) => {
      return lazyConnect(state, serverName);
    },
    getConnectionStatus: (serverName: string) => {
      if (state.needsAuth.has(serverName)) {
        return "needs-auth";
      }
      const definition = config.mcpServers[serverName];
      if (definition?.auth === "oauth") {
        const authStatus = McpAuth.getAuthStatus(serverName);
        if (authStatus === "not_authenticated" || authStatus === "expired") {
          return "needs-auth";
        }
      }
      const connection = state.manager.getConnection(serverName);
      if (connection?.status === "connected") return "connected";
      if (getFailureAgeSeconds(state, serverName) !== null) return "failed";
      return "idle";
    },
    refreshCacheAfterReconnect: (serverName: string) => {
      const freshCache = loadMetadataCache();
      return freshCache?.servers?.[serverName] ?? null;
    },
  };

  const { createMcpPanel } = await import("./mcp-panel.js");

  const panelResult = await new Promise<McpPanelResult>((resolve) => {
    ctx.ui.custom(
      (tui, _theme, _keybindings, done) => {
        return createMcpPanel(config, cache, provenanceMap, callbacks, tui, (result: McpPanelResult) => {
          done(result);
          resolve(result);
        });
      },
      { overlay: true, overlayOptions: { anchor: "center", width: 82 } },
    );
  });

  if (!panelResult.cancelled && panelResult.changes.size > 0) {
    writeDirectToolsConfig(panelResult.changes, provenanceMap, config);
    ctx.ui.notify("Direct tools updated. Restart pi to apply.", "info");
  }

  // User pressed Enter on a needs-auth server — trigger OAuth flow
  if (panelResult.authServer) {
    await authenticateServer(panelResult.authServer, config, ctx, state);
  }
}

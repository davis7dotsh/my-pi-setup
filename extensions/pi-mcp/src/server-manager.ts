import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  McpTool,
  McpResource,
  ServerDefinition,
  ServerStreamResultPatchNotification,
  Transport,
} from "./types.js";
import { serverStreamResultPatchNotificationSchema } from "./types.js";
import { NeedsAuthError, NeedsClientRegistrationError } from "./errors.js";
import { McpOAuthProvider, type McpOAuthConfig, type McpOAuthCallbacks } from "./mcp-oauth-provider.js";
import { resolveNpxBinary } from "./npx-resolver.js";
import { logger } from "./logger.js";

interface ServerConnection {
  client: Client;
  transport: Transport;
  definition: ServerDefinition;
  tools: McpTool[];
  resources: McpResource[];
  lastUsedAt: number;
  inFlight: number;
  status: "connected" | "closed";
}

type UiStreamListener = (serverName: string, notification: ServerStreamResultPatchNotification["params"]) => void;

export class McpServerManager {
  private connections = new Map<string, ServerConnection>();
  private connectPromises = new Map<string, Promise<ServerConnection>>();
  private uiStreamListeners = new Map<string, UiStreamListener>();
  
  async connect(name: string, definition: ServerDefinition): Promise<ServerConnection> {
    // Dedupe concurrent connection attempts
    if (this.connectPromises.has(name)) {
      return this.connectPromises.get(name)!;
    }
    
    // Reuse existing connection if healthy
    const existing = this.connections.get(name);
    if (existing?.status === "connected") {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    
    const promise = this.createConnection(name, definition);
    this.connectPromises.set(name, promise);
    
    try {
      const connection = await promise;
      this.connections.set(name, connection);
      return connection;
    } finally {
      this.connectPromises.delete(name);
    }
  }
  
  private async createConnection(
    name: string,
    definition: ServerDefinition
  ): Promise<ServerConnection> {
    const client = new Client({ name: `pi-mcp-${name}`, version: "1.0.0" });
    
    let transport: Transport;
    
    try {
      if (definition.command) {
        let command = definition.command;
        let args = definition.args ?? [];

        if (command === "npx" || command === "npm") {
          const resolved = await resolveNpxBinary(command, args);
          if (resolved) {
            command = resolved.isJs ? "node" : resolved.binPath;
            args = resolved.isJs ? [resolved.binPath, ...resolved.extraArgs] : resolved.extraArgs;
            logger.debug(`${name} resolved to ${resolved.binPath} (skipping npm parent)`);
          }
        }

        transport = new StdioClientTransport({
          command,
          args,
          env: resolveEnv(definition.env),
          cwd: definition.cwd,
          stderr: definition.debug ? "inherit" : "ignore",
        });
      } else if (definition.url) {
        // HTTP transport with fallback — may throw NeedsAuthError
        transport = await this.createHttpTransport(definition, name);
      } else {
        throw new Error(`Server ${name} has no command or url`);
      }
    } catch (error) {
      // createHttpTransport can throw NeedsAuthError before transport is assigned.
      // Always clean up the client we already created.
      await client.close().catch(() => {});
      throw error;
    }
    
    try {
      await client.connect(transport);
      this.attachAdapterNotificationHandlers(name, client);
      
      // Discover tools and resources
      const [tools, resources] = await Promise.all([
        this.fetchAllTools(client),
        this.fetchAllResources(client),
      ]);
      
      return {
        client,
        transport,
        definition,
        tools,
        resources,
        lastUsedAt: Date.now(),
        inFlight: 0,
        status: "connected",
      };
    } catch (error) {
      // Clean up both client and transport on any error
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      throw error;
    }
  }
  
  private async createHttpTransport(definition: ServerDefinition, serverName?: string): Promise<Transport> {
    const url = new URL(definition.url!);
    const headers = resolveHeaders(definition.headers) ?? {};

    // ── Bearer auth: static token, unchanged ──
    if (definition.auth === "bearer") {
      const token = definition.bearerToken
        ?? (definition.bearerTokenEnv ? process.env[definition.bearerTokenEnv] : undefined);

      if (!token) {
        const missingSource = definition.bearerTokenEnv
          ? `environment variable "${definition.bearerTokenEnv}"`
          : "configured bearer token";
        throw new Error(`Missing bearer token for MCP server "${serverName ?? definition.url}" (${missingSource})`);
      }

      headers["Authorization"] = `Bearer ${token}`;
    }

    const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;

    // ── OAuth auth: use SDK's auth provider for automatic refresh ──
    let authProvider: McpOAuthProvider | undefined;
    if (definition.auth === "oauth" && serverName) {
      authProvider = new McpOAuthProvider(
        serverName,
        definition.url!,
        {
          clientId: definition.oauthClientId,
          clientSecret: definition.oauthClientSecret,
          scope: definition.oauthScope,
        },
        {
          onRedirect: async (_url) => {
            // Capture only — actual browser opening is handled by startAuth/authenticate
            logger.debug(`${serverName}: oauth redirect requested: ${_url.toString()}`);
          },
        },
      );
    }

    // Build transport options
    const transportOpts: { authProvider?: McpOAuthProvider; requestInit?: { headers: Record<string, string> } } = {};
    if (authProvider) transportOpts.authProvider = authProvider;
    if (requestInit) transportOpts.requestInit = requestInit;
    const hasOpts = Object.keys(transportOpts).length > 0;

    // Try StreamableHTTP first, then SSE fallback
    const transports: Array<{ name: string; factory: () => StreamableHTTPClientTransport | SSEClientTransport }> = [
      {
        name: "StreamableHTTP",
        factory: () => new StreamableHTTPClientTransport(url, hasOpts ? transportOpts : undefined),
      },
      {
        name: "SSE",
        factory: () => new SSEClientTransport(url, hasOpts ? transportOpts : undefined),
      },
    ];

    let lastError: Error | undefined;
    const transportErrors: string[] = [];
    for (const { name, factory } of transports) {
      const transport = factory();
      try {
        const testClient = new Client({ name: "pi-mcp-probe", version: "1.0.0" });
        await testClient.connect(transport);
        await testClient.close().catch(() => {});
        await transport.close().catch(() => {});

        // Probe succeeded — create a fresh transport for actual use
        return factory();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        await transport.close().catch(() => {});

        // Check for OAuth-specific errors
        const isAuthError =
          error instanceof UnauthorizedError ||
          (authProvider && lastError.message.includes("OAuth"));

        if (isAuthError && serverName) {
          // Check if this is a "needs registration" error
          if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
            throw new NeedsClientRegistrationError(serverName);
          }
          // Server needs auth — throw with transport for finishAuth later
          const pendingTransport = factory();
          throw new NeedsAuthError(serverName, pendingTransport);
        }

        logger.debug(`${serverName ?? "?"}: ${name} transport failed: ${lastError.message}`);
        transportErrors.push(`${name}: ${lastError.message}`);
      }
    }

    if (transportErrors.length > 0) {
      throw new Error(`All transports failed for "${serverName ?? definition.url}": ${transportErrors.join(" | ")}`);
    }

    throw lastError ?? new Error("All transports failed");
  }
  
  private async fetchAllTools(client: Client): Promise<McpTool[]> {
    const allTools: McpTool[] = [];
    let cursor: string | undefined;
    
    do {
      const result = await client.listTools(cursor ? { cursor } : undefined);
      allTools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
    } while (cursor);
    
    return allTools;
  }
  
  private async fetchAllResources(client: Client): Promise<McpResource[]> {
    try {
      const allResources: McpResource[] = [];
      let cursor: string | undefined;
      
      do {
        const result = await client.listResources(cursor ? { cursor } : undefined);
        allResources.push(...(result.resources ?? []));
        cursor = result.nextCursor;
      } while (cursor);
      
      return allResources;
    } catch {
      // Server may not support resources
      return [];
    }
  }

  private attachAdapterNotificationHandlers(serverName: string, client: Client): void {
    client.setNotificationHandler(serverStreamResultPatchNotificationSchema, (notification) => {
      const listener = this.uiStreamListeners.get(notification.params.streamToken);
      if (!listener) return;
      listener(serverName, notification.params);
    });
  }

  registerUiStreamListener(streamToken: string, listener: UiStreamListener): void {
    this.uiStreamListeners.set(streamToken, listener);
  }

  removeUiStreamListener(streamToken: string): void {
    this.uiStreamListeners.delete(streamToken);
  }

  async readResource(name: string, uri: string): Promise<ReadResourceResult> {
    const connection = this.connections.get(name);
    if (!connection || connection.status !== "connected") {
      throw new Error(`Server "${name}" is not connected`);
    }

    try {
      this.touch(name);
      this.incrementInFlight(name);
      return await connection.client.readResource({ uri });
    } finally {
      this.decrementInFlight(name);
      this.touch(name);
    }
  }
  
  async close(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) return;
    
    // Delete from map BEFORE async cleanup to prevent a race where a
    // concurrent connect() creates a new connection that our deferred
    // delete() would then remove, orphaning the new server process.
    connection.status = "closed";
    this.connections.delete(name);
    await connection.client.close().catch(() => {});
    await connection.transport.close().catch(() => {});
  }
  
  async closeAll(): Promise<void> {
    const names = [...this.connections.keys()];
    await Promise.all(names.map(name => this.close(name)));
  }
  
  getConnection(name: string): ServerConnection | undefined {
    return this.connections.get(name);
  }
  
  getAllConnections(): Map<string, ServerConnection> {
    return new Map(this.connections);
  }

  touch(name: string): void {
    const connection = this.connections.get(name);
    if (connection) {
      connection.lastUsedAt = Date.now();
    }
  }

  incrementInFlight(name: string): void {
    const connection = this.connections.get(name);
    if (connection) {
      connection.inFlight = (connection.inFlight ?? 0) + 1;
    }
  }

  decrementInFlight(name: string): void {
    const connection = this.connections.get(name);
    if (connection && connection.inFlight) {
      connection.inFlight--;
    }
  }

  isIdle(name: string, timeoutMs: number): boolean {
    const connection = this.connections.get(name);
    if (!connection || connection.status !== "connected") return false;
    if (connection.inFlight > 0) return false;
    return (Date.now() - connection.lastUsedAt) > timeoutMs;
  }
}

/**
 * Resolve environment variables with interpolation.
 */
function resolveEnv(env?: Record<string, string>): Record<string, string> {
  // Copy process.env, filtering out undefined values
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      resolved[key] = value;
    }
  }
  
  if (!env) return resolved;
  
  for (const [key, value] of Object.entries(env)) {
    // Support ${VAR} and $env:VAR interpolation
    resolved[key] = value
      .replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "")
      .replace(/\$env:(\w+)/g, (_, name) => process.env[name] ?? "");
  }
  
  return resolved;
}

/**
 * Resolve headers with environment variable interpolation.
 */
function resolveHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return undefined;
  
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = value
      .replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "")
      .replace(/\$env:(\w+)/g, (_, name) => process.env[name] ?? "");
  }
  return resolved;
}

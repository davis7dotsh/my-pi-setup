// mcp-oauth-provider.ts — OAuthClientProvider implementation for MCP SDK
// Bridges our credential storage with the SDK's auth layer so it can
// automatically attach tokens, refresh on 401, and handle PKCE.

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthTokens,
  OAuthClientInformation,
  OAuthClientInformationFull,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { McpAuth } from "./mcp-auth.js";
import { McpOAuthCallback, CALLBACK_PATH } from "./mcp-oauth-callback.js";
import { logger } from "./logger.js";
import { randomBytes } from "node:crypto";

export interface McpOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
}

export interface McpOAuthCallbacks {
  onRedirect: (url: URL) => void | Promise<void>;
}

export class McpOAuthProvider implements OAuthClientProvider {
  private callbackPort: number | undefined;

  constructor(
    private serverName: string,
    private serverUrl: string,
    private config: McpOAuthConfig,
    private callbacks: McpOAuthCallbacks,
    callbackPort?: number,
  ) {
    this.callbackPort = callbackPort;
  }

  get redirectUrl(): string {
    // Use the provided port, or read from the running server, or fall back to preferred
    const port = this.callbackPort ?? McpOAuthCallback.getPort() ?? 19876;
    return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: "Pi Coding Agent",
      client_uri: "https://github.com/badlogic/pi-mono",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.config.clientSecret ? "client_secret_post" : "none",
    };
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    // Check config first (pre-registered client)
    if (this.config.clientId) {
      return {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      };
    }

    // Check stored client info (from dynamic registration)
    const entry = McpAuth.getForUrl(this.serverName, this.serverUrl);
    if (entry?.clientInfo) {
      // Check if client secret has expired
      if (
        entry.clientInfo.clientSecretExpiresAt &&
        entry.clientInfo.clientSecretExpiresAt < Date.now() / 1000
      ) {
        logger.debug(`${this.serverName}: client secret expired, need to re-register`);
        return undefined;
      }
      return {
        client_id: entry.clientInfo.clientId,
        client_secret: entry.clientInfo.clientSecret,
      };
    }

    // No client info or URL changed — will trigger dynamic registration
    return undefined;
  }

  async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
    McpAuth.updateClientInfo(
      this.serverName,
      {
        clientId: info.client_id,
        clientSecret: info.client_secret,
        clientIdIssuedAt: info.client_id_issued_at,
        clientSecretExpiresAt: info.client_secret_expires_at,
      },
      this.serverUrl,
    );
    logger.debug(`${this.serverName}: saved dynamically registered client (${info.client_id})`);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const entry = McpAuth.getForUrl(this.serverName, this.serverUrl);
    if (!entry?.tokens) return undefined;

    return {
      access_token: entry.tokens.accessToken,
      token_type: "Bearer",
      refresh_token: entry.tokens.refreshToken,
      expires_in: entry.tokens.expiresAt
        ? Math.max(0, Math.floor(entry.tokens.expiresAt - Date.now() / 1000))
        : undefined,
      scope: entry.tokens.scope,
    };
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    McpAuth.updateTokens(
      this.serverName,
      {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: tokens.expires_in ? Date.now() / 1000 + tokens.expires_in : undefined,
        scope: tokens.scope,
      },
      this.serverUrl,
    );
    logger.debug(`${this.serverName}: saved oauth tokens`);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    logger.debug(`${this.serverName}: redirect to authorization: ${authorizationUrl.toString()}`);
    await this.callbacks.onRedirect(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    McpAuth.updateCodeVerifier(this.serverName, codeVerifier);
  }

  async codeVerifier(): Promise<string> {
    const entry = McpAuth.get(this.serverName);
    if (!entry?.codeVerifier) {
      throw new Error(`No code verifier saved for MCP server: ${this.serverName}`);
    }
    return entry.codeVerifier;
  }

  async saveState(state: string): Promise<void> {
    McpAuth.updateOAuthState(this.serverName, state);
  }

  async state(): Promise<string> {
    const entry = McpAuth.get(this.serverName);
    if (entry?.oauthState) {
      return entry.oauthState;
    }

    // Generate a new state if none exists — the SDK calls state() as a
    // generator, not just a reader, so we need to produce a value even when
    // startAuth() hasn't pre-saved one.
    const newState = randomBytes(32).toString("hex");
    McpAuth.updateOAuthState(this.serverName, newState);
    return newState;
  }

  async invalidateCredentials(type: "all" | "client" | "tokens"): Promise<void> {
    logger.debug(`${this.serverName}: invalidating credentials (${type})`);
    const entry = McpAuth.get(this.serverName);
    if (!entry) return;

    switch (type) {
      case "all":
        McpAuth.remove(this.serverName);
        break;
      case "client":
        delete entry.clientInfo;
        McpAuth.set(this.serverName, entry);
        break;
      case "tokens":
        delete entry.tokens;
        McpAuth.set(this.serverName, entry);
        break;
    }
  }
}

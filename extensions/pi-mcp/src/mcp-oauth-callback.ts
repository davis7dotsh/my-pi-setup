// mcp-oauth-callback.ts — Local HTTP server for OAuth callback
// Listens on 127.0.0.1 for the browser redirect after user authorizes.
// Prefers port 19876 but falls back to an OS-assigned port if it's in use.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import { logger } from "./logger.js";

const PREFERRED_PORT = 19876;
const CALLBACK_PATH = "/mcp/oauth/callback";

// ── HTML Templates ─────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const HTML_SUCCESS = `<!DOCTYPE html>
<html>
<head>
  <title>Pi - Authorization Successful</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #4ade80; margin-bottom: 1rem; }
    p { color: #aaa; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Successful</h1>
    <p>You can close this window and return to Pi.</p>
  </div>
  <script>setTimeout(() => window.close(), 2000);</script>
</body>
</html>`;

function htmlError(error: string): string {
  const safe = escapeHtml(error);
  return `<!DOCTYPE html>
<html>
<head>
  <title>Pi - Authorization Failed</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #eee; }
    .container { text-align: center; padding: 2rem; }
    h1 { color: #f87171; margin-bottom: 1rem; }
    p { color: #aaa; }
    .error { color: #fca5a5; font-family: monospace; margin-top: 1rem; padding: 1rem; background: rgba(248,113,113,0.1); border-radius: 0.5rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorization Failed</h1>
    <p>An error occurred during authorization.</p>
    <div class="error">${safe}</div>
  </div>
</body>
</html>`;
}

// ── Pending Auth Tracking ──────────────────────────────────────────────────

interface PendingAuth {
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

// ── Callback Server ────────────────────────────────────────────────────────

let server: Server | undefined;
let actualPort: number | undefined;
const pendingAuths = new Map<string, PendingAuth>();

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function respond(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const port = actualPort ?? PREFERRED_PORT;
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

  if (url.pathname !== CALLBACK_PATH) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  logger.debug(`oauth callback: code=${!!code} state=${state} error=${error}`);

  // Enforce state parameter
  if (!state) {
    const msg = "Missing required state parameter";
    logger.debug(`oauth callback: ${msg}`);
    respond(res, 400, htmlError(msg));
    return;
  }

  if (error) {
    const msg = errorDescription || error;
    const pending = pendingAuths.get(state);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingAuths.delete(state);
      pending.reject(new Error(msg));
    }
    respond(res, 200, htmlError(msg));
    return;
  }

  if (!code) {
    respond(res, 400, htmlError("No authorization code provided"));
    return;
  }

  // Validate state against pending auths
  if (!pendingAuths.has(state)) {
    const msg = "Invalid or expired state parameter";
    logger.debug(`oauth callback: ${msg} (pending: ${[...pendingAuths.keys()].join(",")})`);
    respond(res, 400, htmlError(msg));
    return;
  }

  const pending = pendingAuths.get(state)!;
  clearTimeout(pending.timeout);
  pendingAuths.delete(state);
  pending.resolve(code);

  respond(res, 200, HTML_SUCCESS);
}

// ── Port binding ───────────────────────────────────────────────────────────

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(port, "127.0.0.1");
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      resolve(false);
    });
  });
}

function tryListen(srv: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    srv.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(err);
      } else {
        reject(err);
      }
    });
    srv.listen(port, "127.0.0.1", () => {
      const addr = srv.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      resolve(boundPort);
    });
  });
}

// ── Public API ─────────────────────────────────────────────────────────────

export namespace McpOAuthCallback {
  /**
   * Start the callback server if not already running.
   * Tries port 19876 first, falls back to an OS-assigned port.
   * Returns the actual port the server is listening on.
   */
  export async function ensureRunning(): Promise<number> {
    if (server && actualPort) return actualPort;

    const srv = createServer(handleRequest);

    try {
      // Try preferred port first
      actualPort = await tryListen(srv, PREFERRED_PORT);
    } catch {
      // Preferred port in use (another pi instance, etc.) — bind to OS-assigned port
      logger.debug(`oauth callback: port ${PREFERRED_PORT} in use, binding to random port`);
      actualPort = await tryListen(srv, 0);
    }

    server = srv;
    logger.debug(`oauth callback server started on port ${actualPort}`);
    return actualPort;
  }

  /**
   * Get the port the callback server is listening on.
   * Returns undefined if not running.
   */
  export function getPort(): number | undefined {
    return actualPort;
  }

  /**
   * Get the full callback URL for the currently running server.
   */
  export function getCallbackUrl(): string {
    const port = actualPort ?? PREFERRED_PORT;
    return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  }

  /**
   * Register a pending auth and wait for the callback.
   * Returns the authorization code from the callback.
   */
  export function waitForCallback(oauthState: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (pendingAuths.has(oauthState)) {
          pendingAuths.delete(oauthState);
          reject(new Error("OAuth callback timeout — authorization took too long (5 min limit)"));
        }
      }, CALLBACK_TIMEOUT_MS);

      pendingAuths.set(oauthState, { resolve, reject, timeout });
    });
  }

  /**
   * Cancel a pending auth.
   */
  export function cancelPending(oauthState: string): void {
    const pending = pendingAuths.get(oauthState);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingAuths.delete(oauthState);
      pending.reject(new Error("Authorization cancelled"));
    }
  }

  /**
   * Stop the callback server and reject all pending auths.
   */
  export async function stop(): Promise<void> {
    if (server) {
      await new Promise<void>((resolve) => {
        server!.close(() => resolve());
      });
      server = undefined;
      actualPort = undefined;
      logger.debug("oauth callback server stopped");
    }

    for (const [_state, pending] of pendingAuths) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("OAuth callback server stopped"));
    }
    pendingAuths.clear();
  }

  export function isRunning(): boolean {
    return server !== undefined;
  }
}

export { CALLBACK_PATH, PREFERRED_PORT };

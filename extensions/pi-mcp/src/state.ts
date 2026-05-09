import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { TextContent, ImageContent } from "@mariozechner/pi-ai";
import type { ConsentManager } from "./consent-manager.js";
import type { McpLifecycleManager } from "./lifecycle.js";
import type { McpServerManager } from "./server-manager.js";
import type { ToolMetadata, McpConfig, UiSessionMessages, UiStreamSummary } from "./types.js";
import type { UiResourceHandler } from "./ui-resource-handler.js";
import type { UiServerHandle } from "./ui-server.js";

export interface CompletedUiSession {
  serverName: string;
  toolName: string;
  completedAt: Date;
  reason: string;
  messages: UiSessionMessages;
  stream?: UiStreamSummary;
}

export type SendMessageFn = (
  message: {
    customType: string;
    content: string | (TextContent | ImageContent)[];
    display: boolean;
    details?: unknown;
  },
  options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }
) => void;

export interface McpExtensionState {
  manager: McpServerManager;
  lifecycle: McpLifecycleManager;
  toolMetadata: Map<string, ToolMetadata[]>;
  config: McpConfig;
  failureTracker: Map<string, number>;
  needsAuth: Set<string>; // Servers that need OAuth authentication
  uiResourceHandler: UiResourceHandler;
  consentManager: ConsentManager;
  uiServer: UiServerHandle | null;
  completedUiSessions: CompletedUiSession[];
  openBrowser: (url: string) => Promise<void>;
  ui?: ExtensionContext["ui"];
  sendMessage?: SendMessageFn;
}

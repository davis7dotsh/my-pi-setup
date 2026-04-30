import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@mariozechner/pi-ai";

const HUNDRED_YEARS_MS = 100 * 365 * 24 * 60 * 60 * 1000;

export default function (pi: ExtensionAPI) {
  pi.registerProvider("opencode", {
    oauth: {
      name: "OpenCode Zen",

      async login(callbacks: OAuthLoginCallbacks) {
        callbacks.onProgress?.(
          "Paste your OpenCode Zen API key. It will be saved in ~/.pi/agent/auth.json.",
        );

        const apiKey = (
          await callbacks.onPrompt({
            message: "OpenCode Zen API key",
            placeholder: "sk-...",
          })
        ).trim();

        if (!apiKey) {
          throw new Error("OpenCode Zen API key is required.");
        }

        return {
          access: apiKey,
          refresh: apiKey,
          expires: Date.now() + HUNDRED_YEARS_MS,
        };
      },

      async refreshToken(credentials: OAuthCredentials) {
        return {
          ...credentials,
          expires: Date.now() + HUNDRED_YEARS_MS,
        };
      },

      getApiKey(credentials: OAuthCredentials) {
        return credentials.access;
      },
    },
  });
}

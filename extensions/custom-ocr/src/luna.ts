/**
 * Default backend: GPT-5.6 Luna through Pi's model registry and OAuth.
 *
 * Uses the same `completeSimple` path as Pi's own nested model calls, so no
 * separate SDK or credential store is involved. PDFs and multi-page files are
 * rasterized locally first and passed as page images.
 */
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { LUNA_SYSTEM_PROMPT, lunaUserPrompt } from "./prompts.ts";

export const LUNA_PROVIDER = "openai-codex";
export const LUNA_MODEL_ID = "gpt-5.6-luna";

const LUNA_MAX_TOKENS = 16_000;
const LUNA_TIMEOUT_MS = 300_000;

export class LunaError extends Error {
  override readonly name = "LunaError";
}

export interface LunaImage {
  readonly page: number;
  readonly data: string;
  readonly mimeType: string;
}

export async function parseWithLuna(options: {
  readonly modelRegistry: ModelRegistry;
  readonly images: readonly LunaImage[];
  readonly question?: string;
  readonly signal?: AbortSignal;
}) {
  const model = options.modelRegistry.find(LUNA_PROVIDER, LUNA_MODEL_ID);
  if (!model) {
    throw new LunaError(
      `Model ${LUNA_PROVIDER}/${LUNA_MODEL_ID} is unavailable. Sign in with /login (Codex) or switch to private mode with /private-image on.`,
    );
  }
  const auth = await options.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new LunaError(auth.error);

  const response = await completeSimple(
    model,
    {
      systemPrompt: LUNA_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: lunaUserPrompt(
                options.question,
                options.images.map((image) => image.page),
              ),
            },
            ...options.images.map((image) => ({
              type: "image" as const,
              data: image.data,
              mimeType: image.mimeType,
            })),
          ],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: auth.apiKey,
      env: auth.env,
      headers: auth.headers,
      maxTokens: LUNA_MAX_TOKENS,
      maxRetries: 1,
      reasoning: "low",
      signal: options.signal,
      timeoutMs: LUNA_TIMEOUT_MS,
    },
  );

  if (response.stopReason === "aborted") {
    throw new LunaError("Luna request was cancelled.");
  }
  if (response.stopReason === "error") {
    throw new LunaError(response.errorMessage ?? "Luna request failed.");
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) throw new LunaError("Luna returned an empty response.");
  return text;
}

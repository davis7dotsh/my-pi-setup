/**
 * Hosted parser backend through Pi's model registry.
 *
 * The default is the public stable OpenAI GPT-4.1 vision model. Set
 * CUSTOM_OCR_PROVIDER and CUSTOM_OCR_MODEL to select another configured Pi
 * model with image input support. Pi owns authentication and provider routing.
 */
import type { Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { HOSTED_SYSTEM_PROMPT, hostedUserPrompt } from "./prompts.ts";

export const DEFAULT_HOSTED_PROVIDER = "openai";
export const DEFAULT_HOSTED_MODEL_ID = "gpt-4.1";
export const HOSTED_PROVIDER_ENV = "CUSTOM_OCR_PROVIDER";
export const HOSTED_MODEL_ENV = "CUSTOM_OCR_MODEL";

const HOSTED_MAX_TOKENS = 16_000;
const HOSTED_TIMEOUT_MS = 300_000;

export class ProviderParserError extends Error {
  override readonly name = "ProviderParserError";
}

export interface HostedModelSelection {
  readonly provider: string;
  readonly modelId: string;
}

export interface HostedImage {
  readonly page: number;
  readonly data: string;
  readonly mimeType: string;
}

export interface HostedParseResult {
  readonly text: string;
  readonly usage: Usage;
}

export function getHostedModelSelection(
  env: Readonly<Record<string, string | undefined>> = process.env,
): HostedModelSelection {
  return {
    provider: env[HOSTED_PROVIDER_ENV]?.trim() || DEFAULT_HOSTED_PROVIDER,
    modelId: env[HOSTED_MODEL_ENV]?.trim() || DEFAULT_HOSTED_MODEL_ID,
  };
}

export function formatHostedModel(selection: HostedModelSelection) {
  return `${selection.provider}/${selection.modelId}`;
}

export async function parseWithProviderModel(options: {
  readonly modelRegistry: ModelRegistry;
  readonly selection: HostedModelSelection;
  readonly images: readonly HostedImage[];
  readonly question?: string;
  readonly signal?: AbortSignal;
}): Promise<HostedParseResult> {
  const modelName = formatHostedModel(options.selection);
  const model = options.modelRegistry.find(
    options.selection.provider,
    options.selection.modelId,
  );
  if (!model) {
    throw new ProviderParserError(
      `Model ${modelName} is unavailable. Choose a configured public model with ${HOSTED_PROVIDER_ENV} and ${HOSTED_MODEL_ENV}, then authenticate its provider with /login or the provider's environment variable.`,
    );
  }
  if (!model.input.includes("image")) {
    throw new ProviderParserError(
      `Model ${modelName} does not support image input. Choose a vision-capable model with ${HOSTED_PROVIDER_ENV} and ${HOSTED_MODEL_ENV}.`,
    );
  }

  const response = await options.modelRegistry
    .streamSimple(
      model,
      {
        systemPrompt: HOSTED_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: hostedUserPrompt(
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
        maxTokens: HOSTED_MAX_TOKENS,
        maxRetries: 1,
        signal: options.signal,
        timeoutMs: HOSTED_TIMEOUT_MS,
      },
    )
    .result();

  if (response.stopReason === "aborted") {
    throw new ProviderParserError("Hosted parser request was cancelled.");
  }
  if (response.stopReason === "error") {
    throw new ProviderParserError(
      response.errorMessage ?? `Hosted parser request to ${modelName} failed.`,
    );
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) {
    throw new ProviderParserError(
      `Hosted parser model ${modelName} returned an empty response.`,
    );
  }
  return { text, usage: response.usage };
}

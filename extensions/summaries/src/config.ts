import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Data, Effect } from "effect";

class ConfigWriteError extends Data.TaggedError("ConfigWriteError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const REASONING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export interface SummaryConfig {
  readonly provider: string;
  readonly model: string;
  readonly reasoning: ReasoningLevel;
}

export const DEFAULT_SUMMARY_CONFIG: SummaryConfig = {
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  reasoning: "medium",
};

const extensionDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
export const PRIVATE_CONFIG_PATH = join(
  extensionDirectory,
  "config.private.json",
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isReasoningLevel = (value: unknown): value is ReasoningLevel =>
  typeof value === "string" &&
  REASONING_LEVELS.includes(value as ReasoningLevel);

export function parseSummaryConfig(value: unknown) {
  if (!isRecord(value)) return DEFAULT_SUMMARY_CONFIG;

  if (
    typeof value.provider !== "string" ||
    !value.provider.trim() ||
    typeof value.model !== "string" ||
    !value.model.trim() ||
    !isReasoningLevel(value.reasoning)
  ) {
    return DEFAULT_SUMMARY_CONFIG;
  }

  return {
    provider: value.provider.trim(),
    model: value.model.trim(),
    reasoning: value.reasoning,
  } satisfies SummaryConfig;
}

export function loadSummaryConfig() {
  try {
    return parseSummaryConfig(
      JSON.parse(readFileSync(PRIVATE_CONFIG_PATH, "utf8")),
    );
  } catch {
    return DEFAULT_SUMMARY_CONFIG;
  }
}

export function saveSummaryConfig(config: SummaryConfig, signal?: AbortSignal) {
  const tempPath = `${PRIVATE_CONFIG_PATH}.${process.pid}.${randomUUID()}.tmp`;
  const write = Effect.tryPromise({
    try: async (effectSignal) => {
      await mkdir(dirname(PRIVATE_CONFIG_PATH), { recursive: true });
      try {
        await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          signal: effectSignal,
        });
        await rename(tempPath, PRIVATE_CONFIG_PATH);
      } catch (error) {
        await unlink(tempPath).catch(() => undefined);
        throw error;
      }
    },
    catch: (cause) =>
      new ConfigWriteError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(Effect.timeout("5 seconds"));

  return Effect.runPromise(write, signal ? { signal } : undefined);
}

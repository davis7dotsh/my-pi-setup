import {
  complete,
  type Api,
  type Model,
  type ProviderStreamOptions,
  type UserMessage,
} from "@earendil-works/pi-ai/compat";
import {
  getAgentDir,
  ModelSelectorComponent,
  SettingsManager,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const configPath = join(getAgentDir(), "extensions", "advisor.json");
export const ADVISOR_MAX_TOKENS = 16_000;
export const ADVISOR_TIMEOUT_MS = 3 * 60 * 1_000;

const configMutationQueues = new Map<string, Promise<void>>();

const advisorSystemPrompt = `You are Advisor, an independent read-only consultant for another coding agent.

Answer the question using only the material provided. You have no access to files, the shell, tools, the network, or the surrounding session. Do not claim that you inspected, ran, changed, or verified anything. Do not attempt to call tools or delegate work. Be direct, practical, and honest about uncertainty. You may recommend next investigative or implementation steps, but you must not perform them.`;

type AdvisorConfig = {
  provider: string;
  model: string;
};

function configMutationKey(path: string) {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function withConfigMutationQueue<T>(path: string, operation: () => Promise<T>) {
  const key = configMutationKey(path);
  const previous = configMutationQueues.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  configMutationQueues.set(key, tail);
  return result.finally(() => {
    if (configMutationQueues.get(key) === tail) {
      configMutationQueues.delete(key);
    }
  });
}

function isAdvisorConfig(value: unknown): value is AdvisorConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    "provider" in value &&
    typeof value.provider === "string" &&
    value.provider.length > 0 &&
    "model" in value &&
    typeof value.model === "string" &&
    value.model.length > 0
  );
}

export async function loadConfig(path = configPath) {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `Could not read advisor configuration: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error(
      "Advisor configuration contains invalid JSON. Run /advisor reset or choose a model again.",
    );
  }
  if (!isAdvisorConfig(value)) {
    throw new Error(
      "Advisor configuration must contain non-empty provider and model fields. Run /advisor reset or choose a model again.",
    );
  }
  return value;
}

export async function saveConfig(config: AdvisorConfig, path = configPath) {
  return withConfigMutationQueue(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}-${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryPath,
        `${JSON.stringify(config, null, "\t")}\n`,
        {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        },
      );
      await rename(temporaryPath, path);
    } catch (error) {
      // Cleanup is best-effort so it cannot hide the original write or rename failure.
      try {
        await unlink(temporaryPath);
      } catch {
        // Nothing else to do with a temporary file that could not be removed.
      }
      throw error;
    }
  });
}

export async function resetConfig(path = configPath) {
  return withConfigMutationQueue(path, async () => {
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  });
}

function modelName(model: Model<Api>) {
  return `${model.provider}/${model.id}`;
}

type AdvisorResponse = Pick<
  Awaited<ReturnType<typeof complete>>,
  "content" | "errorMessage" | "stopReason"
>;

type AdvisorRequestAuth = Pick<
  ProviderStreamOptions,
  "apiKey" | "headers" | "env"
>;

function textFromResponse(response: AdvisorResponse) {
  return response.content
    .filter(
      (content): content is { type: "text"; text: string } =>
        content.type === "text",
    )
    .map((content) => content.text)
    .join("\n")
    .trim();
}

function truncateUtf8Prefix(value: string, maxBytes: number) {
  const buffer = Buffer.from(value, "utf8");
  let end = Math.min(maxBytes, buffer.length);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

export function processAdvisorResponse(response: AdvisorResponse) {
  if (response.stopReason === "aborted") {
    throw new Error("Advisor request was cancelled");
  }
  if (response.stopReason === "error") {
    throw new Error(
      `Advisor request failed: ${response.errorMessage ?? "unknown provider error"}`,
    );
  }

  const answer = textFromResponse(response);
  if (!answer) throw new Error("Advisor returned no text response");
  const truncation = truncateHead(answer);
  const truncatedContent = truncation.firstLineExceedsLimit
    ? truncateUtf8Prefix(answer, truncation.maxBytes)
    : truncation.content;
  const notices = [
    ...(response.stopReason === "length"
      ? ["[Advisor reached its output limit.]"]
      : []),
    ...(truncation.truncated
      ? ["[Advisor response truncated by the tool.]"]
      : []),
  ];
  return {
    output:
      notices.length > 0
        ? `${truncatedContent}\n\n${notices.join("\n")}`
        : truncatedContent,
    stopReason: response.stopReason,
    truncated: truncation.truncated,
  };
}

export async function requestAdvisor(
  model: Model<Api>,
  params: { question: string; context?: string },
  auth: AdvisorRequestAuth,
  signal?: AbortSignal,
  timeoutMs = ADVISOR_TIMEOUT_MS,
) {
  const userMessage: UserMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: `Question:\n${params.question}${params.context ? `\n\nContext:\n${params.context}` : ""}`,
      },
    ],
    timestamp: Date.now(),
  };
  const requestController = new AbortController();
  let timedOut = false;
  const timeoutDescription =
    timeoutMs % 60_000 === 0
      ? `${timeoutMs / 60_000} minute${timeoutMs === 60_000 ? "" : "s"}`
      : `${timeoutMs} ms`;
  const timeoutError = new Error(
    `Advisor request timed out after ${timeoutDescription}`,
  );
  const abortFromCaller = () => requestController.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });

  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      requestController.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      complete(
        model,
        { systemPrompt: advisorSystemPrompt, messages: [userMessage] },
        {
          ...auth,
          signal: requestController.signal,
          maxTokens: Math.min(model.maxTokens, ADVISOR_MAX_TOKENS),
          timeoutMs,
        },
      ),
      timeoutPromise,
    ]);
    return processAdvisorResponse(response);
  } catch (error) {
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

export default function advisorExtension(
  pi: ExtensionAPI,
  advisorConfigPath = configPath,
) {
  pi.registerCommand("advisor", {
    description: "Configure the model used by the advisor tool",
    handler: async (args, ctx) => {
      const command = args.trim();

      if (command === "status") {
        try {
          const config = await loadConfig(advisorConfigPath);
          ctx.ui.notify(
            config
              ? `Advisor: ${config.provider}/${config.model}`
              : "Advisor is not configured",
            "info",
          );
        } catch (error) {
          ctx.ui.notify(
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
        return;
      }

      if (command === "reset") {
        await resetConfig(advisorConfigPath);
        ctx.ui.notify("Advisor configuration cleared", "info");
        return;
      }

      if (command) {
        const separator = command.indexOf("/");
        if (separator <= 0 || separator === command.length - 1) {
          ctx.ui.notify(
            "Usage: /advisor [provider/model], /advisor status, or /advisor reset",
            "error",
          );
          return;
        }

        const provider = command.slice(0, separator);
        const modelId = command.slice(separator + 1);
        const model = ctx.modelRegistry.find(provider, modelId);
        if (!model) {
          ctx.ui.notify(`Unknown model: ${command}`, "error");
          return;
        }
        if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
          ctx.ui.notify(`No credentials configured for ${command}`, "error");
          return;
        }

        await saveConfig({ provider, model: modelId }, advisorConfigPath);
        ctx.ui.notify(`Advisor set to ${command}`, "info");
        return;
      }

      if (ctx.mode !== "tui") {
        ctx.ui.notify("Usage: /advisor provider/model", "info");
        return;
      }

      let config: AdvisorConfig | undefined;
      try {
        config = await loadConfig(advisorConfigPath);
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
        return;
      }
      const configuredModel = config
        ? ctx.modelRegistry.find(config.provider, config.model)
        : undefined;
      const selected = await ctx.ui.custom<Model<Api> | null>(
        (tui, _theme, _keybindings, done) =>
          new ModelSelectorComponent(
            tui,
            configuredModel,
            SettingsManager.inMemory(),
            ctx.modelRegistry,
            [],
            (model) => done(model),
            () => done(null),
          ),
      );
      if (!selected) return;
      if (!ctx.modelRegistry.hasConfiguredAuth(selected)) {
        ctx.ui.notify(
          `No credentials configured for ${modelName(selected)}`,
          "error",
        );
        return;
      }

      await saveConfig(
        { provider: selected.provider, model: selected.id },
        advisorConfigPath,
      );
      ctx.ui.notify(`Advisor set to ${modelName(selected)}`, "info");
    },
  });

  pi.registerTool({
    name: "advisor",
    label: "Advisor",
    description:
      "Ask the configured read-only advisor model for help with a question. Only the supplied question and context are sent to that model provider; the advisor has no tools and cannot make changes.",
    promptSnippet:
      "Ask the configured read-only advisor for a second opinion on a difficult question",
    promptGuidelines: [
      "Use advisor only when you are stuck on a question that neither you nor the user can answer. Give advisor the relevant facts and ask one focused question; it cannot inspect files or make changes.",
      "Never send credentials, tokens, private keys, or other secrets to advisor. Ask the user before including sensitive or proprietary material they did not explicitly authorize sharing with the configured model provider.",
    ],
    parameters: Type.Object({
      question: Type.String({
        description: "A focused question for the advisor",
        minLength: 1,
        maxLength: 20_000,
      }),
      context: Type.Optional(
        Type.String({
          description:
            "Relevant facts, code, errors, and constraints the advisor needs",
          maxLength: 40_000,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const config = await loadConfig(advisorConfigPath);
      if (!config) {
        throw new Error(
          "Advisor is not configured. The user can choose one with /advisor.",
        );
      }

      const model = ctx.modelRegistry.find(config.provider, config.model);
      if (!model) {
        throw new Error(
          `Configured advisor model is unavailable: ${config.provider}/${config.model}`,
        );
      }
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) {
        throw new Error(auth.error);
      }

      onUpdate?.({
        content: [
          { type: "text", text: `Asking advisor (${modelName(model)})...` },
        ],
        details: { advisor: modelName(model) },
      });
      const result = await requestAdvisor(
        model,
        params,
        { apiKey: auth.apiKey, headers: auth.headers, env: auth.env },
        signal,
      );
      return {
        content: [{ type: "text", text: result.output }],
        details: {
          advisor: modelName(model),
          stopReason: result.stopReason,
          truncated: result.truncated,
        },
      };
    },
  });
}

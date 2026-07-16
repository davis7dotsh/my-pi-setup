import {
  registerFauxProvider,
  type Api,
  type Context,
  type Model,
  type StreamOptions,
} from "@earendil-works/pi-ai/compat";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  RegisteredCommand,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import advisorExtension, {
  ADVISOR_MAX_TOKENS,
  loadConfig,
  processAdvisorResponse,
  requestAdvisor,
  resetConfig,
  saveConfig,
} from "./index.ts";

async function withTemporaryConfig(run: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "pi-advisor-test-"));
  try {
    await run(join(directory, "nested", "advisor.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type CommandDefinition = Omit<RegisteredCommand, "name" | "sourceInfo">;

function captureExtension(configPath: string) {
  let command: CommandDefinition | undefined;
  let tool: ToolDefinition | undefined;
  const pi = {
    registerCommand(name: string, definition: CommandDefinition) {
      if (name === "advisor") command = definition;
    },
    registerTool(definition: ToolDefinition) {
      if (definition.name === "advisor") tool = definition;
    },
  } as unknown as ExtensionAPI;
  advisorExtension(pi, configPath);
  assert.ok(command);
  assert.ok(tool);
  return { command, tool };
}

test("config roundtrip, replacement, validation, and idempotent reset", async () => {
  await withTemporaryConfig(async (path) => {
    assert.equal(await loadConfig(path), undefined);

    await saveConfig({ provider: "provider", model: "first" }, path);
    await saveConfig({ provider: "provider", model: "second" }, path);
    assert.deepEqual(await loadConfig(path), {
      provider: "provider",
      model: "second",
    });

    await writeFile(path, "{broken", "utf8");
    await assert.rejects(loadConfig(path), /invalid JSON/);
    await writeFile(path, JSON.stringify({ provider: "", model: "model" }));
    await assert.rejects(loadConfig(path), /non-empty provider and model/);

    await resetConfig(path);
    await resetConfig(path);
    assert.equal(await loadConfig(path), undefined);
  });
});

test("config mutations remain ordered under concurrent save and reset calls", async () => {
  await withTemporaryConfig(async (path) => {
    await Promise.all(
      Array.from({ length: 80 }, (_, index) =>
        saveConfig({ provider: "provider", model: `model-${index}` }, path),
      ),
    );
    assert.deepEqual(await loadConfig(path), {
      provider: "provider",
      model: "model-79",
    });

    await Promise.all([
      resetConfig(path),
      ...Array.from({ length: 20 }, (_, index) =>
        saveConfig({ provider: "provider", model: `reset-${index}` }, path),
      ),
    ]);
    assert.deepEqual(await loadConfig(path), {
      provider: "provider",
      model: "reset-19",
    });
  });
});

test("response processing reports errors, limits, and tool truncation", () => {
  assert.deepEqual(
    processAdvisorResponse({
      content: [{ type: "text", text: " advice " }],
      stopReason: "stop",
    }),
    { output: "advice", stopReason: "stop", truncated: false },
  );
  assert.match(
    processAdvisorResponse({
      content: [{ type: "text", text: "partial" }],
      stopReason: "length",
    }).output,
    /reached its output limit/,
  );
  assert.throws(
    () =>
      processAdvisorResponse({
        content: [],
        stopReason: "error",
        errorMessage: "provider failed",
      }),
    /provider failed/,
  );
  assert.throws(
    () => processAdvisorResponse({ content: [], stopReason: "aborted" }),
    /cancelled/,
  );
  assert.throws(
    () => processAdvisorResponse({ content: [], stopReason: "stop" }),
    /no text response/,
  );

  const oversizedLine = processAdvisorResponse({
    content: [{ type: "text", text: "€".repeat(20_000) }],
    stopReason: "stop",
  });
  const [retained] = oversizedLine.output.split(
    "\n\n[Advisor response truncated by the tool.]",
  );
  assert.ok(retained.length > 0);
  assert.ok(Buffer.byteLength(retained, "utf8") <= 50 * 1024);
  assert.equal(retained.includes("�"), false);
  assert.equal(oversizedLine.truncated, true);
});

test("advisor requests isolate context and enforce output and time budgets", async () => {
  const faux = registerFauxProvider({
    models: [{ id: "advisor-test", maxTokens: 100_000 }],
  });
  let observed:
    { context: Context; options: StreamOptions | undefined } | undefined;
  try {
    faux.setResponses([
      (context, options) => {
        observed = { context, options };
        return fauxAssistantMessage("independent advice");
      },
    ]);
    const model = faux.getModel() as unknown as Model<Api>;
    const result = await requestAdvisor(
      model,
      { question: "What should change?", context: "Relevant code" },
      { apiKey: "test-key", headers: { "x-test": "yes" } },
      undefined,
      2_000,
    );

    assert.equal(result.output, "independent advice");
    assert.equal(observed?.options?.maxTokens, ADVISOR_MAX_TOKENS);
    assert.equal(observed?.options?.timeoutMs, 2_000);
    assert.equal(observed?.options?.apiKey, "test-key");
    assert.deepEqual(observed?.options?.headers, { "x-test": "yes" });
    assert.equal(observed?.context.tools, undefined);
    assert.match(observed?.context.systemPrompt ?? "", /no access to files/);
    assert.equal(observed?.context.messages.length, 1);
    const message = observed?.context.messages[0];
    assert.equal(message?.role, "user");
    if (message?.role !== "user") assert.fail("expected one user message");
    if (!Array.isArray(message.content)) {
      assert.fail("expected structured user content");
    }
    const content = message.content[0];
    if (typeof content === "string") assert.fail("expected a content block");
    assert.equal(content?.type, "text");
    if (content?.type !== "text") assert.fail("expected text content");
    assert.equal(
      content.text,
      "Question:\nWhat should change?\n\nContext:\nRelevant code",
    );
  } finally {
    faux.unregister();
  }
});

test("advisor request deadline aborts and rejects a stalled provider", async () => {
  const faux = registerFauxProvider({
    models: [{ id: "advisor-timeout", maxTokens: 100_000 }],
  });
  try {
    faux.setResponses([
      (_context, options) =>
        new Promise((_resolve, reject) => {
          const rejectOnAbort = () => reject(new Error("provider aborted"));
          if (options?.signal?.aborted) rejectOnAbort();
          else
            options?.signal?.addEventListener("abort", rejectOnAbort, {
              once: true,
            });
        }),
    ]);
    const model = faux.getModel() as unknown as Model<Api>;
    await assert.rejects(
      requestAdvisor(model, { question: "Stall" }, {}, undefined, 20),
      /timed out after 20 ms/,
    );
  } finally {
    faux.unregister();
  }
});

test("advisor command validates models and authentication before saving", async () => {
  await withTemporaryConfig(async (path) => {
    const faux = registerFauxProvider({
      models: [{ id: "advisor-command", maxTokens: 1_000 }],
    });
    const notifications: string[] = [];
    let authenticated = false;
    try {
      const model = faux.getModel() as unknown as Model<Api>;
      const { command } = captureExtension(path);
      const context = {
        mode: "json",
        modelRegistry: {
          find(provider: string, modelId: string) {
            return provider === model.provider && modelId === model.id
              ? model
              : undefined;
          },
          hasConfiguredAuth() {
            return authenticated;
          },
        },
        ui: {
          notify(message: string) {
            notifications.push(message);
          },
        },
      } as unknown as ExtensionCommandContext;

      await command.handler("invalid", context);
      assert.match(notifications.at(-1) ?? "", /Usage/);
      await command.handler("unknown/model", context);
      assert.match(notifications.at(-1) ?? "", /Unknown model/);
      await command.handler(`${model.provider}/${model.id}`, context);
      assert.match(notifications.at(-1) ?? "", /No credentials configured/);

      authenticated = true;
      await command.handler(`${model.provider}/${model.id}`, context);
      assert.deepEqual(await loadConfig(path), {
        provider: model.provider,
        model: model.id,
      });
      await command.handler("status", context);
      assert.match(notifications.at(-1) ?? "", /Advisor:/);
      await command.handler("reset", context);
      assert.equal(await loadConfig(path), undefined);
    } finally {
      faux.unregister();
    }
  });
});

test("advisor tool fails clearly for missing models and authentication", async () => {
  await withTemporaryConfig(async (path) => {
    const faux = registerFauxProvider({
      models: [{ id: "advisor-tool-errors", maxTokens: 1_000 }],
    });
    try {
      const model = faux.getModel() as unknown as Model<Api>;
      const { tool } = captureExtension(path);
      const execute = tool.execute as unknown as (
        toolCallId: string,
        params: { question: string; context?: string },
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        context: ExtensionContext,
      ) => Promise<unknown>;
      const models = new Map<string, Model<Api>>();
      let authResult:
        { ok: true; apiKey: string } | { ok: false; error: string } = {
        ok: false,
        error: "authentication unavailable",
      };
      const context = {
        modelRegistry: {
          find(provider: string, modelId: string) {
            return models.get(`${provider}/${modelId}`);
          },
          async getApiKeyAndHeaders() {
            return authResult;
          },
        },
      } as unknown as ExtensionContext;

      await assert.rejects(
        execute(
          "call",
          { question: "Question" },
          undefined,
          undefined,
          context,
        ),
        /not configured/,
      );

      await saveConfig({ provider: model.provider, model: model.id }, path);
      await assert.rejects(
        execute(
          "call",
          { question: "Question" },
          undefined,
          undefined,
          context,
        ),
        /unavailable/,
      );

      models.set(`${model.provider}/${model.id}`, model);
      await assert.rejects(
        execute(
          "call",
          { question: "Question" },
          undefined,
          undefined,
          context,
        ),
        /authentication unavailable/,
      );

      authResult = { ok: true, apiKey: "test" };
      faux.setResponses([fauxAssistantMessage("tool advice")]);
      const result = await execute(
        "call",
        { question: "Question" },
        undefined,
        undefined,
        context,
      );
      assert.match(JSON.stringify(result), /tool advice/);
    } finally {
      faux.unregister();
    }
  });
});

test("registered tool warns agents about external sharing and secrets", () => {
  const { tool } = captureExtension("unused-advisor-config.json");

  assert.equal(tool.name, "advisor");
  assert.match(tool.description, /sent to that model provider/);
  assert.match(
    tool.promptGuidelines?.join("\n") ?? "",
    /Never send credentials/,
  );
  assert.match(
    tool.promptGuidelines?.join("\n") ?? "",
    /sensitive or proprietary/,
  );
});

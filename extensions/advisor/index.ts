import { complete, type Model, type UserMessage } from "@earendil-works/pi-ai/compat";
import {
	getAgentDir,
	ModelSelectorComponent,
	SettingsManager,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const configPath = join(getAgentDir(), "extensions", "advisor.json");

const advisorSystemPrompt = `You are Advisor, an independent read-only consultant for another coding agent.

Answer the question using only the material provided. You have no access to files, the shell, tools, the network, or the surrounding session. Do not claim that you inspected, ran, changed, or verified anything. Do not attempt to call tools or delegate work. Be direct, practical, and honest about uncertainty. You may recommend next investigative or implementation steps, but you must not perform them.`;

type AdvisorConfig = {
	provider: string;
	model: string;
};

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

async function loadConfig() {
	try {
		const value: unknown = JSON.parse(await readFile(configPath, "utf8"));
		return isAdvisorConfig(value) ? value : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`Could not read advisor configuration: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function saveConfig(config: AdvisorConfig) {
	await mkdir(dirname(configPath), { recursive: true });
	const temporaryPath = `${configPath}.${process.pid}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
	await rename(temporaryPath, configPath);
}

function modelName(model: Model) {
	return `${model.provider}/${model.id}`;
}

function textFromResponse(response: Awaited<ReturnType<typeof complete>>) {
	return response.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
}

export default function advisorExtension(pi: ExtensionAPI) {
	pi.registerCommand("advisor", {
		description: "Configure the model used by the advisor tool",
		handler: async (args, ctx) => {
			const command = args.trim();

			if (command === "status") {
				const config = await loadConfig();
				ctx.ui.notify(config ? `Advisor: ${config.provider}/${config.model}` : "Advisor is not configured", "info");
				return;
			}

			if (command === "reset") {
				try {
					await unlink(configPath);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				ctx.ui.notify("Advisor configuration cleared", "info");
				return;
			}

			if (command) {
				const separator = command.indexOf("/");
				if (separator <= 0 || separator === command.length - 1) {
					ctx.ui.notify("Usage: /advisor [provider/model], /advisor status, or /advisor reset", "error");
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

				await saveConfig({ provider, model: modelId });
				ctx.ui.notify(`Advisor set to ${command}`, "info");
				return;
			}

			if (ctx.mode !== "tui") {
				ctx.ui.notify("Usage: /advisor provider/model", "info");
				return;
			}

			const config = await loadConfig();
			const configuredModel = config
				? ctx.modelRegistry.find(config.provider, config.model)
				: undefined;
			const selected = await ctx.ui.custom<Model | null>((tui, _theme, _keybindings, done) =>
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

			await saveConfig({ provider: selected.provider, model: selected.id });
			ctx.ui.notify(`Advisor set to ${modelName(selected)}`, "info");
		},
	});

	pi.registerTool({
		name: "advisor",
		label: "Advisor",
		description: "Ask the configured read-only advisor model for help with a question. The advisor has no tools and cannot make changes.",
		promptSnippet: "Ask the configured read-only advisor for a second opinion on a difficult question",
		promptGuidelines: [
			"Use advisor only when you are stuck on a question that neither you nor the user can answer. Give advisor the relevant facts and ask one focused question; it cannot inspect files or make changes.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "A focused question for the advisor", minLength: 1, maxLength: 20_000 }),
			context: Type.Optional(Type.String({ description: "Relevant facts, code, errors, and constraints the advisor needs", maxLength: 40_000 })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const config = await loadConfig();
			if (!config) {
				throw new Error("Advisor is not configured. The user can choose one with /advisor.");
			}

			const model = ctx.modelRegistry.find(config.provider, config.model);
			if (!model) {
				throw new Error(`Configured advisor model is unavailable: ${config.provider}/${config.model}`);
			}
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) {
				throw new Error(auth.ok ? `No credentials configured for advisor ${modelName(model)}` : auth.error);
			}

			onUpdate?.({ content: [{ type: "text", text: `Asking advisor (${modelName(model)})...` }] });
			const userMessage: UserMessage = {
				role: "user",
				content: [{
					type: "text",
					text: `Question:\n${params.question}${params.context ? `\n\nContext:\n${params.context}` : ""}`,
				}],
				timestamp: Date.now(),
			};
			const response = await complete(
				model,
				{ systemPrompt: advisorSystemPrompt, messages: [userMessage] },
				{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal },
			);
			if (response.stopReason === "aborted") {
				throw new Error("Advisor request was cancelled");
			}

			const answer = textFromResponse(response);
			if (!answer) throw new Error("Advisor returned no text response");
			const truncation = truncateHead(answer);
			const output = truncation.truncated
				? `${truncation.content}\n\n[Advisor response truncated.]`
				: truncation.content;
			return {
				content: [{ type: "text", text: output }],
				details: { advisor: modelName(model), truncated: truncation.truncated },
			};
		},
	});
}

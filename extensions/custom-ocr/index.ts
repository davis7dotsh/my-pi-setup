/**
 * custom-ocr — parse images and PDFs with a hosted default (GPT-5.6 Luna via
 * Pi's Codex OAuth) or a fail-closed local pipeline (DeepSeek-OCR → Qwen on
 * MLX) toggled with /private-image.
 *
 * One tool: parse-file(path, question?, pages?).
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Static } from "typebox";
import {
  MAX_PAGES,
  renderFile,
  resolveFile,
  type PageRange,
  type ResolvedFile,
} from "./src/files.ts";
import { parseWithLuna, LUNA_MODEL_ID, LUNA_PROVIDER } from "./src/luna.ts";
import {
  MODE_ENTRY_TYPE,
  parsePrivateImageArgs,
  readModeFromBranch,
  type OcrMode,
} from "./src/mode.ts";
import { saveFullResult, type PageResult } from "./src/output.ts";
import {
  executeParse,
  type ParseDeps,
  type RenderedDocument,
} from "./src/parse.ts";
import {
  FUSION_MAX_TOKENS,
  OCR_MAX_TOKENS,
  OCR_REPETITION_PENALTY,
  PrivateModeError,
  PrivateWorkerManager,
  installInstructions,
  missingModels,
} from "./src/private-runtime.ts";
import { OCR_PROMPT, fusionPrompt } from "./src/prompts.ts";
import { createRuntime, runEffect, type OcrRuntime } from "./src/runtime.ts";

const parseFileParameters = Type.Object({
  path: Type.String({
    description: "Path to a PNG, JPEG, WebP, GIF, TIFF, or PDF file",
  }),
  question: Type.Optional(
    Type.String({
      description:
        "Optional question about the file. Without it, the full text and visual structure are extracted.",
    }),
  ),
  pages: Type.Optional(
    Type.Object(
      {
        start: Type.Integer({ minimum: 1 }),
        end: Type.Integer({ minimum: 1 }),
      },
      {
        description: `Optional 1-based inclusive page range for PDFs/TIFFs (max ${MAX_PAGES} pages per call; defaults to pages 1-${MAX_PAGES})`,
      },
    ),
  ),
});

export type ParseFileInput = Static<typeof parseFileParameters>;

export interface ParseFileDetails {
  mode: OcrMode;
  progress?: string;
  path?: string;
  kind?: string;
  pages?: number;
  totalPages?: number;
  truncated?: boolean;
  warnings?: string[];
  fullResultPath?: string;
}

export default function customOcr(pi: ExtensionAPI) {
  const pythonDir = join(dirname(fileURLToPath(import.meta.url)), "python");

  let mode: OcrMode = "luna";
  let runtime: OcrRuntime | undefined;
  let manager: PrivateWorkerManager | undefined;

  const getRuntime = () => (runtime ??= createRuntime());
  const getManager = () => (manager ??= new PrivateWorkerManager(pythonDir));

  function setMode(next: OcrMode) {
    mode = next;
    pi.appendEntry(MODE_ENTRY_TYPE, { mode: next });
  }

  function restoreMode(ctx: ExtensionContext) {
    mode = readModeFromBranch(ctx.sessionManager.getBranch());
    if (mode === "luna") manager?.stopAll();
  }

  pi.on("session_start", async (_event, ctx) => {
    restoreMode(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreMode(ctx);
  });

  pi.on("session_shutdown", async () => {
    manager?.stopAll();
    manager = undefined;
    const closing = runtime;
    runtime = undefined;
    await closing?.dispose();
  });

  pi.registerCommand("private-image", {
    description:
      "Toggle fully local, fail-closed parsing for parse-file (on/off/status)",
    getArgumentCompletions: (prefix) => {
      const items = ["on", "off", "status"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const action = parsePrivateImageArgs(args, mode);

      if (action.action === "error") {
        ctx.ui.notify(action.message, "error");
        return;
      }

      if (action.action === "status") {
        const lines = [
          `mode: ${mode === "private" ? "private (local MLX)" : `luna (${LUNA_PROVIDER}/${LUNA_MODEL_ID})`}`,
        ];
        for (const report of getManager().status()) {
          const state = report.installed
            ? `${report.status}${report.port ? ` on 127.0.0.1:${report.port}` : ""}${report.error ? ` (${report.error})` : ""}`
            : "weights not installed";
          lines.push(`${report.name}: ${report.modelId} — ${state}`);
        }
        const missing = missingModels();
        if (missing.length > 0) lines.push(installInstructions(missing));
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (action.mode === mode) {
        ctx.ui.notify(
          mode === "private"
            ? "Private image mode is already on."
            : "Private image mode is already off.",
          "info",
        );
        return;
      }

      if (action.mode === "private") {
        const missing = missingModels();
        if (missing.length > 0) {
          ctx.ui.notify(installInstructions(missing), "error");
          return;
        }
        setMode("private");
        ctx.ui.notify(
          "Private image mode ON — parse-file now runs fully local (DeepSeek-OCR → Qwen) and never calls hosted models. Prewarming workers…",
          "info",
        );
        getManager()
          .prewarm()
          .then(() => {
            ctx.ui.notify("Private OCR workers are loaded and ready.", "info");
          })
          .catch((error: unknown) => {
            ctx.ui.notify(
              `Private worker prewarm failed (mode stays private and fail-closed): ${error instanceof Error ? error.message : String(error)}`,
              "error",
            );
          });
        return;
      }

      setMode("luna");
      manager?.stopAll();
      ctx.ui.notify(
        "Private image mode OFF — parse-file uses GPT-5.6 Luna again. Local workers were unloaded.",
        "info",
      );
    },
  });

  pi.registerTool<typeof parseFileParameters, ParseFileDetails>({
    name: "parse-file",
    label: "Parse File",
    description: [
      "Parse an image (PNG, JPEG, WebP, GIF, TIFF) or PDF from disk and return its text and visual structure, optionally answering a question about it.",
      `PDFs and multi-page TIFFs are processed up to ${MAX_PAGES} pages per call (use pages {start,end} to select a range).`,
      "Uses GPT-5.6 Luna by default; after /private-image on it runs a fully local DeepSeek-OCR → Qwen pipeline that never sends file contents to any network service.",
    ].join(" "),
    promptSnippet:
      "Extract text/structure from an image or PDF, or answer a question about it",
    promptGuidelines: [
      "Use parse-file to read the contents of images and PDFs instead of guessing from file names.",
      "Pass a question to parse-file when you need one specific fact from a document instead of the full text.",
    ],
    executionMode: "sequential",
    parameters: parseFileParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const progress = (text: string) => {
        onUpdate?.({
          content: [{ type: "text", text }],
          details: { mode, progress: text },
        });
      };
      const interrupt = {
        signal,
        interruptMessage: "parse-file was cancelled.",
      };

      const deps: ParseDeps = {
        mode,
        resolveFile: (rawPath) =>
          runEffect(getRuntime(), resolveFile(rawPath, ctx.cwd), interrupt),
        render: async (file: ResolvedFile, range: PageRange) => {
          progress(`Rendering ${basename(file.path)}…`);
          const outDir = await mkdtemp(join(tmpdir(), "custom-ocr-"));
          const cleanup = () =>
            rm(outDir, {
              recursive: true,
              force: true,
              maxRetries: 3,
              retryDelay: 100,
            });
          try {
            const manifest = await runEffect(
              getRuntime(),
              renderFile({ file, range, outDir, pythonDir }),
              interrupt,
            );
            return { ...manifest, cleanup } satisfies RenderedDocument;
          } catch (error) {
            await cleanup();
            throw error;
          }
        },
        runLuna: async (doc, question) => {
          progress(`Parsing ${doc.pages.length} page(s) with GPT-5.6 Luna…`);
          const images = [];
          for (const page of doc.pages) {
            images.push({
              page: page.page,
              data: (await readFile(page.path)).toString("base64"),
              mimeType: "image/png",
            });
          }
          return parseWithLuna({
            modelRegistry: ctx.modelRegistry,
            images,
            question,
            signal,
          });
        },
        runPrivate: async (doc, question) => {
          const missing = missingModels();
          if (missing.length > 0) {
            throw new PrivateModeError(installInstructions(missing));
          }
          const workers = getManager();
          const results: PageResult[] = [];
          for (const page of doc.pages) {
            progress(
              `Private OCR — page ${page.page} (${results.length + 1}/${doc.pages.length})…`,
            );
            const ocrText = await workers.generate(
              "ocr",
              {
                imagePath: page.path,
                prompt: OCR_PROMPT,
                maxTokens: OCR_MAX_TOKENS,
                repetitionPenalty: OCR_REPETITION_PENALTY,
              },
              signal,
            );
            progress(
              `Private fusion — page ${page.page} (${results.length + 1}/${doc.pages.length})…`,
            );
            const text = await workers.generate(
              "fusion",
              {
                imagePath: page.path,
                prompt: fusionPrompt(ocrText, question),
                maxTokens: FUSION_MAX_TOKENS,
              },
              signal,
            );
            results.push({ page: page.page, text });
          }
          return results;
        },
        saveFullResult,
      };

      const outcome = await executeParse(params, deps);
      return {
        content: [{ type: "text", text: outcome.text }],
        details: {
          mode: outcome.mode,
          path: outcome.file.path,
          kind: outcome.file.kind,
          pages: outcome.pageCount,
          totalPages: outcome.totalPages,
          truncated: outcome.truncated,
          warnings: [...outcome.warnings],
          fullResultPath: outcome.fullResultPath,
        },
      };
    },
  });
}

/**
 * file-search — first-class `fd` and `rg` tools for pi.
 *
 * On session start the extension resolves a usable binary for each tool:
 * a normally installed system binary is preferred (silently), then an
 * existing fallback in this repo's `bin/` directory (silently), and only
 * when neither exists is an official release downloaded into `bin/` — the
 * single case that shows a UI notification. Tools await that initialization
 * before executing, and report a clear error if it failed.
 */

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Cause, Data, Effect, Exit } from "effect";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  buildFdArgs,
  buildRgArgs,
  FD_MAX_DEPTH_LIMIT,
  FD_MAX_LIMIT,
  RG_MAX_CONTEXT,
  RG_MAX_COUNT_LIMIT,
} from "./src/args.ts";
import {
  currentTarget,
  liveBinaryEnv,
  repositoryBinDir,
  resolveBinary,
  TOOL_SPECS,
  type BinarySource,
  type ResolvedBinary,
} from "./src/binaries.ts";
import { formatOutput } from "./src/output.ts";
import {
  FD_PARAMETER_DESCRIPTIONS,
  FD_PROMPT_GUIDELINES,
  FD_PROMPT_SNIPPET,
  FD_TOOL_DESCRIPTION,
  RG_PARAMETER_DESCRIPTIONS,
  RG_PROMPT_GUIDELINES,
  RG_PROMPT_SNIPPET,
  RG_TOOL_DESCRIPTION,
} from "./src/prompt.ts";

type InitState = Readonly<Record<"fd" | "rg", ResolvedBinary>>;

/** Human-readable install notice, shown only for fresh downloads. */
export function installNotifications(binaries: readonly ResolvedBinary[]) {
  return binaries
    .filter((binary) => binary.source === "installed")
    .map(
      (binary) =>
        `file-search: no system ${binary.tool} found — downloaded ${binary.tool} ${binary.version ?? ""}`.trimEnd() +
        ` to ${repositoryBinDir()}`,
    );
}

class SearchError extends Data.TaggedError("SearchError")<{
  readonly message: string;
}> {}

interface SearchOutcome {
  readonly stdout: string;
  readonly noMatches: boolean;
  readonly binarySource: BinarySource;
}

export interface FdToolDetails {
  readonly binarySource: BinarySource;
  readonly matchCount: number;
  readonly truncated: boolean;
  readonly fullOutputPath?: string;
}

export interface RgToolDetails {
  readonly binarySource: BinarySource;
  readonly outputLines: number;
  readonly truncated: boolean;
  readonly fullOutputPath?: string;
}

const EXEC_TIMEOUT_MS = 60_000;

function causeMessage<E>(cause: Cause.Cause<E>) {
  const [first] = Cause.prettyErrors(cause);
  return first?.message ?? Cause.pretty(cause);
}

function unwrapToolExit<A, E>(exit: Exit.Exit<A, E>, tool: "fd" | "rg") {
  if (Exit.isSuccess(exit)) return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    throw new Error(`${tool} search was cancelled.`);
  }
  throw new Error(causeMessage(exit.cause));
}

function formatOutputEffect(output: string, tempPrefix: string) {
  return Effect.tryPromise({
    try: () => formatOutput(output, { tempPrefix }),
    catch: (cause) =>
      new SearchError({
        message: `Could not format search output: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });
}

export default function fileSearchTools(pi: ExtensionAPI) {
  let notified = false;

  const ensureInitialized = Effect.runSync(
    Effect.cached(
      Effect.gen(function* () {
        const binDir = repositoryBinDir();
        const target = currentTarget();
        const [fd, rg] = yield* Effect.all(
          [
            resolveBinary(TOOL_SPECS.fd, binDir, target, liveBinaryEnv),
            resolveBinary(TOOL_SPECS.rg, binDir, target, liveBinaryEnv),
          ],
          { concurrency: "unbounded" },
        );
        return { fd, rg } satisfies InitState;
      }),
    ),
  );

  pi.on("session_start", async (_event, ctx) => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const state = yield* ensureInitialized;
        if (!ctx.hasUI || notified) return;

        notified = true;
        for (const message of installNotifications(Object.values(state))) {
          ctx.ui.notify(message, "info");
        }
      }),
    );

    if (Exit.isFailure(exit) && ctx.hasUI && !notified) {
      notified = true;
      ctx.ui.notify(
        `file-search setup failed: ${causeMessage(exit.cause)}`,
        "error",
      );
    }
  });

  /** Await init, run the binary via pi.exec with argument arrays, classify exit. */
  function runSearch(tool: "fd" | "rg", args: string[], ctx: ExtensionContext) {
    return Effect.gen(function* () {
      const state = yield* ensureInitialized;
      const binary = state[tool];
      const result = yield* Effect.tryPromise({
        try: (signal) =>
          pi.exec(binary.command, args, {
            cwd: ctx.cwd,
            signal,
          }),
        catch: (cause) =>
          new SearchError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      }).pipe(
        Effect.timeout(EXEC_TIMEOUT_MS),
        Effect.mapError((error) =>
          error._tag === "TimeoutError"
            ? new SearchError({ message: `${tool} timed out.` })
            : error,
        ),
      );

      if (result.killed) {
        return yield* new SearchError({ message: `${tool} was cancelled.` });
      }
      // ripgrep exits 1 for "no matches"; fd exits 0 even with no results.
      if (tool === "rg" && result.code === 1 && !result.stdout.trim()) {
        return {
          stdout: "",
          noMatches: true,
          binarySource: binary.source,
        } satisfies SearchOutcome;
      }
      if (result.code !== 0) {
        const detail = result.stderr.trim() || `exit code ${result.code}`;
        return yield* new SearchError({ message: `${tool} failed: ${detail}` });
      }
      return {
        stdout: result.stdout,
        noMatches: !result.stdout.trim(),
        binarySource: binary.source,
      } satisfies SearchOutcome;
    });
  }

  pi.registerTool<ReturnType<typeof fdParameters>, FdToolDetails>({
    name: "fd",
    label: "Find Files",
    description: FD_TOOL_DESCRIPTION,
    promptSnippet: FD_PROMPT_SNIPPET,
    promptGuidelines: FD_PROMPT_GUIDELINES,
    parameters: fdParameters(),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const outcome = yield* runSearch("fd", buildFdArgs(params), ctx);
          if (outcome.noMatches) {
            return {
              content: [{ type: "text", text: "No files found" }],
              details: {
                binarySource: outcome.binarySource,
                matchCount: 0,
                truncated: false,
              },
            } satisfies AgentToolResult<FdToolDetails>;
          }

          const formatted = yield* formatOutputEffect(outcome.stdout, "pi-fd-");
          return {
            content: [{ type: "text", text: formatted.text }],
            details: {
              binarySource: outcome.binarySource,
              matchCount: formatted.lineCount,
              truncated: formatted.truncated,
              fullOutputPath: formatted.fullOutputPath,
            },
          } satisfies AgentToolResult<FdToolDetails>;
        }),
        signal ? { signal } : undefined,
      );
      return unwrapToolExit(exit, "fd");
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("fd "));
      text += theme.fg("accent", args.pattern ? `"${args.pattern}"` : "(all)");
      if (args.path) text += theme.fg("muted", ` in ${args.path}`);
      const flags = [
        args.type && `type=${args.type}`,
        args.extension && `ext=${args.extension}`,
        args.glob && "glob",
        args.hidden && "hidden",
        args.max_depth !== undefined && `depth≤${args.max_depth}`,
      ].filter((flag): flag is string => typeof flag === "string");
      if (flags.length > 0) text += " " + theme.fg("dim", flags.join(" "));
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
      const details = result.details;
      if (!details || details.matchCount === 0) {
        return new Text(theme.fg("dim", "No files found"), 0, 0);
      }
      let text = theme.fg(
        "success",
        `${details.matchCount} ${details.matchCount === 1 ? "entry" : "entries"}`,
      );
      if (details.truncated) text += theme.fg("warning", " (truncated)");
      if (expanded)
        text += expandedPreview(result, details.fullOutputPath, theme);
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool<ReturnType<typeof rgParameters>, RgToolDetails>({
    name: "rg",
    label: "Search Content",
    description: RG_TOOL_DESCRIPTION,
    promptSnippet: RG_PROMPT_SNIPPET,
    promptGuidelines: RG_PROMPT_GUIDELINES,
    parameters: rgParameters(),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const exit = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const outcome = yield* runSearch("rg", buildRgArgs(params), ctx);
          if (outcome.noMatches) {
            return {
              content: [{ type: "text", text: "No matches found" }],
              details: {
                binarySource: outcome.binarySource,
                outputLines: 0,
                truncated: false,
              },
            } satisfies AgentToolResult<RgToolDetails>;
          }

          const formatted = yield* formatOutputEffect(outcome.stdout, "pi-rg-");
          return {
            content: [{ type: "text", text: formatted.text }],
            details: {
              binarySource: outcome.binarySource,
              outputLines: formatted.lineCount,
              truncated: formatted.truncated,
              fullOutputPath: formatted.fullOutputPath,
            },
          } satisfies AgentToolResult<RgToolDetails>;
        }),
        signal ? { signal } : undefined,
      );
      return unwrapToolExit(exit, "rg");
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("rg "));
      text += theme.fg("accent", `"${args.pattern}"`);
      if (args.path) text += theme.fg("muted", ` in ${args.path}`);
      const flags = [
        args.glob && `glob=${args.glob}`,
        args.file_type && `type=${args.file_type}`,
        args.fixed_strings && "literal",
        args.hidden && "hidden",
        args.context !== undefined && `ctx=${args.context}`,
      ].filter((flag): flag is string => typeof flag === "string");
      if (flags.length > 0) text += " " + theme.fg("dim", flags.join(" "));
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("warning", "Searching..."), 0, 0);
      const details = result.details;
      if (!details || details.outputLines === 0) {
        return new Text(theme.fg("dim", "No matches found"), 0, 0);
      }
      let text = theme.fg(
        "success",
        `${details.outputLines} output ${details.outputLines === 1 ? "line" : "lines"}`,
      );
      if (details.truncated) text += theme.fg("warning", " (truncated)");
      if (expanded)
        text += expandedPreview(result, details.fullOutputPath, theme);
      return new Text(text, 0, 0);
    },
  });
}

const PREVIEW_LINES = 20;

interface ThemeLike {
  fg(color: string, text: string): string;
}

function expandedPreview(
  result: { content: { type: string; text?: string }[] },
  fullOutputPath: string | undefined,
  theme: ThemeLike,
) {
  let text = "";
  const content = result.content[0];
  if (content?.type === "text" && content.text) {
    const lines = content.text.split("\n");
    for (const line of lines.slice(0, PREVIEW_LINES)) {
      text += `\n${theme.fg("dim", line)}`;
    }
    if (lines.length > PREVIEW_LINES) {
      text += `\n${theme.fg("muted", `... ${lines.length - PREVIEW_LINES} more lines`)}`;
    }
  }
  if (fullOutputPath) {
    text += `\n${theme.fg("dim", `Full output: ${fullOutputPath}`)}`;
  }
  return text;
}

function fdParameters() {
  return Type.Object({
    pattern: Type.Optional(
      Type.String({ description: FD_PARAMETER_DESCRIPTIONS.pattern }),
    ),
    path: Type.Optional(
      Type.String({ description: FD_PARAMETER_DESCRIPTIONS.path }),
    ),
    type: Type.Optional(
      StringEnum(["file", "directory", "symlink"] as const, {
        description: FD_PARAMETER_DESCRIPTIONS.type,
      }),
    ),
    extension: Type.Optional(
      Type.String({ description: FD_PARAMETER_DESCRIPTIONS.extension }),
    ),
    glob: Type.Optional(
      Type.Boolean({ description: FD_PARAMETER_DESCRIPTIONS.glob }),
    ),
    hidden: Type.Optional(
      Type.Boolean({ description: FD_PARAMETER_DESCRIPTIONS.hidden }),
    ),
    max_depth: Type.Optional(
      Type.Integer({
        description: FD_PARAMETER_DESCRIPTIONS.max_depth,
        minimum: 1,
        maximum: FD_MAX_DEPTH_LIMIT,
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: FD_PARAMETER_DESCRIPTIONS.limit,
        minimum: 1,
        maximum: FD_MAX_LIMIT,
      }),
    ),
  });
}

function rgParameters() {
  return Type.Object({
    pattern: Type.String({ description: RG_PARAMETER_DESCRIPTIONS.pattern }),
    path: Type.Optional(
      Type.String({ description: RG_PARAMETER_DESCRIPTIONS.path }),
    ),
    glob: Type.Optional(
      Type.String({ description: RG_PARAMETER_DESCRIPTIONS.glob }),
    ),
    file_type: Type.Optional(
      Type.String({ description: RG_PARAMETER_DESCRIPTIONS.file_type }),
    ),
    case_sensitive: Type.Optional(
      Type.Boolean({ description: RG_PARAMETER_DESCRIPTIONS.case_sensitive }),
    ),
    fixed_strings: Type.Optional(
      Type.Boolean({ description: RG_PARAMETER_DESCRIPTIONS.fixed_strings }),
    ),
    hidden: Type.Optional(
      Type.Boolean({ description: RG_PARAMETER_DESCRIPTIONS.hidden }),
    ),
    context: Type.Optional(
      Type.Integer({
        description: RG_PARAMETER_DESCRIPTIONS.context,
        minimum: 0,
        maximum: RG_MAX_CONTEXT,
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: RG_PARAMETER_DESCRIPTIONS.limit,
        minimum: 1,
        maximum: RG_MAX_COUNT_LIMIT,
      }),
    ),
  });
}

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

type InitState =
  | {
      readonly ok: true;
      readonly fd: ResolvedBinary;
      readonly rg: ResolvedBinary;
    }
  | { readonly ok: false; readonly message: string };

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
  readonly matchingLines: number;
  readonly truncated: boolean;
  readonly fullOutputPath?: string;
}

const EXEC_TIMEOUT_MS = 60_000;

export default function fileSearchTools(pi: ExtensionAPI) {
  let initPromise: Promise<InitState> | undefined;
  let notified = false;

  function ensureInitialized() {
    initPromise ??= (async () => {
      const binDir = repositoryBinDir();
      const target = currentTarget();
      const program = Effect.all(
        [
          resolveBinary(TOOL_SPECS.fd, binDir, target, liveBinaryEnv),
          resolveBinary(TOOL_SPECS.rg, binDir, target, liveBinaryEnv),
        ],
        { concurrency: 2 },
      );

      const exit = await Effect.runPromiseExit(program);
      if (Exit.isSuccess(exit)) {
        const [fd, rg] = exit.value;
        return { ok: true as const, fd, rg };
      }
      const [first] = Cause.prettyErrors(exit.cause);
      return {
        ok: false as const,
        message: first?.message ?? Cause.pretty(exit.cause),
      };
    })();
    return initPromise;
  }

  pi.on("session_start", async (_event, ctx) => {
    const state = await ensureInitialized();
    if (!ctx.hasUI || notified) return;
    notified = true;
    if (!state.ok) {
      ctx.ui.notify(`file-search setup failed: ${state.message}`, "error");
      return;
    }
    for (const message of installNotifications([state.fd, state.rg])) {
      ctx.ui.notify(message, "info");
    }
  });

  /** Await init, run the binary via pi.exec with argument arrays, classify exit. */
  async function runSearch(
    tool: "fd" | "rg",
    args: string[],
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<SearchOutcome> {
    const state = await ensureInitialized();
    if (!state.ok) {
      throw new Error(`The ${tool} tool is unavailable: ${state.message}`);
    }
    const binary = tool === "fd" ? state.fd : state.rg;

    const binarySource = binary.source;
    const program = Effect.tryPromise({
      try: (execSignal) =>
        pi.exec(binary.command, args, {
          cwd: ctx.cwd,
          signal: execSignal,
          timeout: EXEC_TIMEOUT_MS,
        }),
      catch: (cause) =>
        new SearchError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    }).pipe(
      Effect.flatMap((result) => {
        if (result.killed) {
          return Effect.fail(
            new SearchError({ message: `${tool} was cancelled or timed out.` }),
          );
        }
        // ripgrep exits 1 for "no matches"; fd exits 0 even with no results.
        if (tool === "rg" && result.code === 1 && !result.stdout.trim()) {
          return Effect.succeed<SearchOutcome>({
            stdout: "",
            noMatches: true,
            binarySource,
          });
        }
        if (result.code !== 0) {
          const detail = result.stderr.trim() || `exit code ${result.code}`;
          return Effect.fail(
            new SearchError({ message: `${tool} failed: ${detail}` }),
          );
        }
        return Effect.succeed<SearchOutcome>({
          stdout: result.stdout,
          noMatches: !result.stdout.trim(),
          binarySource,
        });
      }),
    );

    const exit = await Effect.runPromiseExit(
      program,
      signal ? { signal } : undefined,
    );
    if (Exit.isSuccess(exit)) return exit.value;
    if (Cause.hasInterruptsOnly(exit.cause)) {
      throw new Error(`${tool} search was cancelled.`);
    }
    const [first] = Cause.prettyErrors(exit.cause);
    throw new Error(first?.message ?? Cause.pretty(exit.cause));
  }

  pi.registerTool<ReturnType<typeof fdParameters>, FdToolDetails>({
    name: "fd",
    label: "Find Files",
    description: FD_TOOL_DESCRIPTION,
    promptSnippet: FD_PROMPT_SNIPPET,
    promptGuidelines: FD_PROMPT_GUIDELINES,
    parameters: fdParameters(),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const outcome = await runSearch("fd", buildFdArgs(params), signal, ctx);

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

      const formatted = await formatOutput(outcome.stdout, {
        tempPrefix: "pi-fd-",
      });
      return {
        content: [{ type: "text", text: formatted.text }],
        details: {
          binarySource: outcome.binarySource,
          matchCount: formatted.lineCount,
          truncated: formatted.truncated,
          fullOutputPath: formatted.fullOutputPath,
        },
      } satisfies AgentToolResult<FdToolDetails>;
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
      const outcome = await runSearch("rg", buildRgArgs(params), signal, ctx);

      if (outcome.noMatches) {
        return {
          content: [{ type: "text", text: "No matches found" }],
          details: {
            binarySource: outcome.binarySource,
            matchingLines: 0,
            truncated: false,
          },
        } satisfies AgentToolResult<RgToolDetails>;
      }

      const formatted = await formatOutput(outcome.stdout, {
        tempPrefix: "pi-rg-",
      });
      return {
        content: [{ type: "text", text: formatted.text }],
        details: {
          binarySource: outcome.binarySource,
          matchingLines: formatted.lineCount,
          truncated: formatted.truncated,
          fullOutputPath: formatted.fullOutputPath,
        },
      } satisfies AgentToolResult<RgToolDetails>;
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
      if (!details || details.matchingLines === 0) {
        return new Text(theme.fg("dim", "No matches found"), 0, 0);
      }
      let text = theme.fg(
        "success",
        `${details.matchingLines} matching ${details.matchingLines === 1 ? "line" : "lines"}`,
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
      Type.Number({
        description: FD_PARAMETER_DESCRIPTIONS.max_depth,
        minimum: 1,
        maximum: FD_MAX_DEPTH_LIMIT,
      }),
    ),
    limit: Type.Optional(
      Type.Number({
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
      Type.Number({
        description: RG_PARAMETER_DESCRIPTIONS.context,
        minimum: 0,
        maximum: RG_MAX_CONTEXT,
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: RG_PARAMETER_DESCRIPTIONS.limit,
        minimum: 1,
        maximum: RG_MAX_COUNT_LIMIT,
      }),
    ),
  });
}

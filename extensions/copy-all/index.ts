import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Data, Effect, Result } from "effect";

class ClipboardError extends Data.TaggedError("ClipboardError")<{
  readonly cause: Error;
}> {}

function textFromContent(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if (!("type" in block)) return "";

      if (
        block.type === "text" &&
        "text" in block &&
        typeof block.text === "string"
      ) {
        return block.text;
      }

      if (block.type === "image") return "[image]";

      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function copyToClipboard(text: string) {
  return Effect.callback<void, ClipboardError>((resume) => {
    const child = spawn("pbcopy");
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) =>
      resume(Effect.fail(new ClipboardError({ cause: error }))),
    );
    child.on("close", (code) => {
      if (code === 0) {
        resume(Effect.void);
      } else {
        resume(
          Effect.fail(
            new ClipboardError({
              cause: new Error(
                stderr.trim() || `pbcopy exited with code ${code}`,
              ),
            }),
          ),
        );
      }
    });

    child.stdin.end(text);

    return Effect.sync(() => {
      if (child.exitCode === null) child.kill();
    });
  });
}

async function runClipboardCopy(text: string, signal: AbortSignal | undefined) {
  const result = await Effect.runPromise(
    Effect.result(copyToClipboard(text)),
    signal ? { signal } : undefined,
  );
  if (Result.isFailure(result)) throw result.failure.cause;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("copy-all", {
    description:
      "Copy all previous user and assistant messages in this thread to the clipboard",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const sections = ctx.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message)
        .filter(
          (message) => message.role === "user" || message.role === "assistant",
        )
        .map((message) => ({
          role: message.role,
          content: textFromContent(message.content).trim(),
        }))
        .filter(({ content }) => content)
        .map(({ role, content }) => `${role.toUpperCase()}:\n${content}`);

      if (sections.length === 0) {
        ctx.ui.notify("No user or assistant messages to copy", "info");
        return;
      }

      await runClipboardCopy(sections.join("\n\n---\n\n"), ctx.signal);
      ctx.ui.notify(`Copied ${sections.length} messages to clipboard`, "info");
    },
  });
}

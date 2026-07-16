import { dirname, join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Effect, FileSystem, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import type { CapturedOutput } from "./output.ts";

const STDERR_MAX_BYTES = 64 * 1024;

interface PreviewState {
  readonly decoder: TextDecoder;
  preview: string;
  totalBytes: number;
  lineBreaks: number;
  trailingLineBreaks: number;
  truncated: boolean;
}

function makePreviewState(): PreviewState {
  return {
    decoder: new TextDecoder(),
    preview: "",
    totalBytes: 0,
    lineBreaks: 0,
    trailingLineBreaks: 0,
    truncated: false,
  };
}

function observeStdout(state: PreviewState, chunk: Uint8Array) {
  state.totalBytes += chunk.byteLength;
  for (const byte of chunk) {
    if (byte === 0x0a) {
      state.lineBreaks++;
      state.trailingLineBreaks++;
    } else {
      state.trailingLineBreaks = 0;
    }
  }

  if (state.truncated) return;
  state.preview += state.decoder.decode(chunk, { stream: true });
  const truncation = truncateHead(state.preview, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (truncation.truncated) {
    state.preview = truncation.content;
    state.truncated = true;
  }
}

function finishStdout(state: PreviewState, fullOutputPath: string) {
  if (!state.truncated) state.preview += state.decoder.decode();
  const totalBytes = state.totalBytes - state.trailingLineBreaks;
  const lineCount =
    totalBytes === 0 ? 0 : state.lineBreaks - state.trailingLineBreaks + 1;
  return {
    preview: state.preview,
    lineCount,
    totalBytes,
    truncated: state.truncated,
    fullOutputPath: state.truncated ? fullOutputPath : undefined,
  } satisfies CapturedOutput;
}

function collectStderr<E, R>(stream: Stream.Stream<Uint8Array, E, R>) {
  return Stream.runFold(
    stream,
    () => Buffer.alloc(0),
    (captured, chunk) => {
      if (captured.byteLength >= STDERR_MAX_BYTES) return captured;
      const remaining = STDERR_MAX_BYTES - captured.byteLength;
      return Buffer.concat([captured, chunk.subarray(0, remaining)]);
    },
  ).pipe(Effect.map((bytes) => bytes.toString("utf8")));
}

export function executeSearchProcess(options: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly tempPrefix: string;
}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectory({
      prefix: options.tempPrefix,
    });
    const fullOutputPath = join(directory, "output.txt");
    let retainDirectory = false;

    return yield* Effect.gen(function* () {
      const preview = makePreviewState();
      const process = yield* ChildProcess.make(options.command, options.args, {
        cwd: options.cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });

      const result = yield* Effect.all(
        {
          exitCode: process.exitCode,
          stdout: process.stdout.pipe(
            Stream.tap((chunk) =>
              Effect.sync(() => observeStdout(preview, chunk)),
            ),
            Stream.run(fs.sink(fullOutputPath)),
          ),
          stderr: collectStderr(process.stderr),
        },
        { concurrency: "unbounded" },
      );
      const output = finishStdout(preview, fullOutputPath);
      retainDirectory = output.truncated;
      return {
        code: Number(result.exitCode),
        stderr: result.stderr,
        output,
      };
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          retainDirectory
            ? Effect.void
            : fs
                .remove(directory, { recursive: true, force: true })
                .pipe(Effect.orDie),
        ),
      ),
    );
  }).pipe(Effect.scoped);
}

export function discardCapturedOutput(output: CapturedOutput) {
  if (!output.fullOutputPath) return Effect.void;
  const directory = dirname(output.fullOutputPath);
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(directory, { recursive: true, force: true });
  });
}

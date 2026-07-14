import { Context, Effect, Layer, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

export interface CommandResult {
  code: number;
  stderr: string;
  stdout: string;
}

interface CommandRunnerShape {
  run(
    command: string,
    args: string[],
    cwd: string,
    timeout: number,
  ): Effect.Effect<CommandResult>;
}

export class CommandRunner extends Context.Service<
  CommandRunner,
  CommandRunnerShape
>()("git-info/CommandRunner") {}

function appendCommandFailure(stderr: string, command: string, error: Error) {
  const failure = `Failed to run ${command}: ${error.message}`;
  return stderr ? `${stderr.trimEnd()}\n${failure}` : failure;
}

export const CommandRunnerLive = Layer.effect(
  CommandRunner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;

    return CommandRunner.of({
      run: (command, args, cwd, timeout) =>
        Effect.suspend(() => {
          let stderr = "";
          let stdout = "";
          const child = ChildProcess.make(command, args, {
            cwd,
            detached: false,
            forceKillAfter: "5 seconds",
            stdin: "ignore",
            stderr: "pipe",
            stdout: "pipe",
          });

          return Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(child);
              const [, , code] = yield* Effect.all(
                [
                  Stream.runForEach(Stream.decodeText(handle.stdout), (chunk) =>
                    Effect.sync(() => {
                      stdout += chunk;
                    }),
                  ),
                  Stream.runForEach(Stream.decodeText(handle.stderr), (chunk) =>
                    Effect.sync(() => {
                      stderr += chunk;
                    }),
                  ),
                  handle.exitCode,
                ],
                { concurrency: "unbounded" },
              );
              return { code: Number(code), stderr, stdout };
            }),
          ).pipe(
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () => Effect.succeed({ code: -1, stderr, stdout }),
            }),
            Effect.catch((error) =>
              Effect.succeed({
                code: 1,
                stderr: appendCommandFailure(stderr, command, error),
                stdout,
              }),
            ),
          );
        }),
    });
  }),
);

export const runCommand = (
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
) =>
  Effect.gen(function* () {
    const commands = yield* CommandRunner;
    return yield* commands.run(command, args, cwd, timeout);
  });

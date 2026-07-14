import assert from "node:assert/strict";
import test from "node:test";
import { Effect } from "effect";
import { CommandRunner } from "./src/process.ts";
import { createRuntime } from "./src/runtime.ts";

const runtime = createRuntime();

test.after(async () => {
  await runtime.dispose();
});

const runNode = (source: string, timeout = 1_000) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const commands = yield* CommandRunner;
      return yield* commands.run(
        process.execPath,
        ["--input-type=module", "--eval", source],
        process.cwd(),
        timeout,
      );
    }),
  );

test("captures output and tolerates command failures", async () => {
  const success = await runNode(
    'process.stdout.write("out"); process.stderr.write("err")',
  );
  assert.deepEqual(success, { code: 0, stderr: "err", stdout: "out" });

  const failure = await runNode("process.exitCode = 7");
  assert.equal(failure.code, 7);
});

test("reports command timeouts as failures", async () => {
  const result = await runNode("setTimeout(() => {}, 1_000)", 20);
  assert.equal(result.code, -1);
});

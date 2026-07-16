import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, FileSystem } from "effect";
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  buildFdArgs,
  buildRgArgs,
  FD_DEFAULT_LIMIT,
  normalizeSearchPath,
} from "./src/args.ts";
import {
  FD_INTEL_DARWIN_VERSION,
  InstallError,
  readBoundedResponse,
  releaseAsset,
  resolveBinary,
  TOOL_SPECS,
  UnsupportedPlatformError,
  type BinaryEnv,
  type ReleaseAsset,
  type ResolvedBinary,
} from "./src/binaries.ts";
import { formatCapturedOutput, formatOutput } from "./src/output.ts";
import { executeSearchProcess } from "./src/process.ts";
import { installNotifications, makeBinaryInitializers } from "./index.ts";

// --- argument construction -------------------------------------------------

it("fd args: defaults list everything with the default limit", () => {
  assert.deepEqual(buildFdArgs({}), [
    "--color=never",
    "--max-results",
    String(FD_DEFAULT_LIMIT),
    "--",
    "",
  ]);
});

it("fd args: all options are translated and pattern stays behind --", () => {
  const args = buildFdArgs({
    pattern: "-rf",
    path: "@src",
    type: "file",
    extension: ".ts",
    glob: true,
    hidden: true,
    max_depth: 3,
    limit: 50,
  });
  assert.deepEqual(args, [
    "--color=never",
    "--hidden",
    "--glob",
    "--type",
    "f",
    "--extension",
    "ts",
    "--max-depth",
    "3",
    "--max-results",
    "50",
    "--",
    "-rf",
    "src",
  ]);
});

it("fd args: out-of-range values are clamped", () => {
  const args = buildFdArgs({ max_depth: 500, limit: 1_000_000 });
  assert.deepEqual(args, [
    "--color=never",
    "--max-depth",
    "64",
    "--max-results",
    "10000",
    "--",
    "",
  ]);
});

it("rg args: defaults use smart-case and safe separators", () => {
  assert.deepEqual(buildRgArgs({ pattern: "--help" }), [
    "--line-number",
    "--color=never",
    "--no-heading",
    "--with-filename",
    "--smart-case",
    "--max-count",
    "100",
    "--",
    "--help",
  ]);
});

it("rg args: all options are translated", () => {
  const args = buildRgArgs({
    pattern: "TODO",
    path: "@lib",
    glob: "*.ts",
    file_type: "ts",
    case_sensitive: true,
    fixed_strings: true,
    hidden: true,
    context: 2,
    limit: 10,
  });
  assert.deepEqual(args, [
    "--line-number",
    "--color=never",
    "--no-heading",
    "--with-filename",
    "--case-sensitive",
    "--fixed-strings",
    "--hidden",
    "--context",
    "2",
    "--glob",
    "*.ts",
    "--type",
    "ts",
    "--max-count",
    "10",
    "--",
    "TODO",
    "lib",
  ]);
});

it("rg args: case_sensitive false forces ignore-case", () => {
  const args = buildRgArgs({ pattern: "x", case_sensitive: false });
  assert.isTrue(args.includes("--ignore-case"));
  assert.isFalse(args.includes("--smart-case"));
});

it("path normalization strips leading @ and expands ~", () => {
  assert.equal(normalizeSearchPath("@src/lib"), "src/lib");
  assert.equal(normalizeSearchPath("~"), homedir());
  assert.equal(normalizeSearchPath("~/projects"), join(homedir(), "projects"));
  assert.equal(normalizeSearchPath(" plain "), "plain");
});

// --- binary resolution -----------------------------------------------------

function makeEnv(options: {
  available?: string[];
  installShouldFail?: boolean;
}): BinaryEnv & { installs: ReleaseAsset[]; probes: string[] } {
  const installs: ReleaseAsset[] = [];
  const probes: string[] = [];
  const installed = new Set<string>();
  return {
    installs,
    probes,
    probe: (command) =>
      Effect.sync(() => {
        probes.push(command);
        return (
          (options.available ?? []).includes(command) || installed.has(command)
        );
      }),
    install: (asset, destination) => {
      if (options.installShouldFail) {
        return Effect.fail(new InstallError({ message: "network down" }));
      }
      return Effect.sync(() => {
        installs.push(asset);
        installed.add(destination);
      });
    },
  };
}

const darwinArm = { os: "darwin", arch: "arm64" } as const;

it.effect("binary resolution: system fd wins and nothing is installed", () =>
  Effect.gen(function* () {
    const env = makeEnv({ available: ["fd"] });
    const resolved = yield* resolveBinary(
      TOOL_SPECS.fd,
      "/repo/bin",
      darwinArm,
      env,
    );

    assert.deepEqual(resolved, {
      tool: "fd",
      command: "fd",
      source: "system",
    });
    assert.equal(env.installs.length, 0);
  }),
);

it.effect("binary resolution: fdfind is accepted as a system fd", () =>
  Effect.gen(function* () {
    const env = makeEnv({ available: ["fdfind"] });
    const resolved = yield* resolveBinary(
      TOOL_SPECS.fd,
      "/repo/bin",
      darwinArm,
      env,
    );

    assert.deepEqual(resolved, {
      tool: "fd",
      command: "fdfind",
      source: "system",
    });
    assert.equal(env.installs.length, 0);
  }),
);

it.effect("binary resolution: existing bin fallback is used silently", () =>
  Effect.gen(function* () {
    const env = makeEnv({ available: ["/repo/bin/rg"] });
    const resolved = yield* resolveBinary(
      TOOL_SPECS.rg,
      "/repo/bin",
      darwinArm,
      env,
    );

    assert.deepEqual(resolved, {
      tool: "rg",
      command: "/repo/bin/rg",
      source: "bundled",
    });
    assert.equal(env.installs.length, 0);
  }),
);

it.effect(
  "binary resolution: missing everywhere triggers exactly one install",
  () =>
    Effect.gen(function* () {
      const env = makeEnv({ available: [] });
      const resolved = yield* resolveBinary(
        TOOL_SPECS.rg,
        "/repo/bin",
        darwinArm,
        env,
      );

      assert.equal(resolved.source, "installed");
      assert.equal(resolved.command, "/repo/bin/rg");
      assert.equal(env.installs.length, 1);
      assert.match(
        env.installs[0].url,
        /^https:\/\/github\.com\/BurntSushi\/ripgrep\//,
      );
    }),
);

it.effect("binary resolution: install failure surfaces a typed error", () =>
  Effect.gen(function* () {
    const env = makeEnv({ available: [], installShouldFail: true });
    const error = yield* Effect.flip(
      resolveBinary(TOOL_SPECS.fd, "/repo/bin", darwinArm, env),
    );

    assert.instanceOf(error, InstallError);
    assert.equal(error.message, "network down");
  }),
);

it.effect(
  "binary resolution: unsupported platform fails without installing",
  () =>
    Effect.gen(function* () {
      const env = makeEnv({ available: [] });
      const error = yield* Effect.flip(
        resolveBinary(
          TOOL_SPECS.fd,
          "/repo/bin",
          { os: "linux", arch: "s390x" },
          env,
        ),
      );

      assert.instanceOf(error, UnsupportedPlatformError);
      assert.equal(env.installs.length, 0);
    }),
);

it.effect("binary resolution: one failed tool does not disable the other", () =>
  Effect.gen(function* () {
    const env = makeEnv({
      available: ["rg"],
      installShouldFail: true,
    });
    const initializers = makeBinaryInitializers("/repo/bin", darwinArm, env);

    const fdError = yield* Effect.flip(initializers.fd);
    const rg = yield* initializers.rg;

    assert.instanceOf(fdError, InstallError);
    assert.deepEqual(rg, { tool: "rg", command: "rg", source: "system" });
  }),
);

it("release assets cover macOS and Linux on arm64 and x64 over HTTPS", () => {
  for (const os of ["darwin", "linux"] as const) {
    for (const arch of ["arm64", "x64"] as const) {
      for (const tool of ["fd", "rg"] as const) {
        const asset = releaseAsset(tool, { os, arch });
        assert.isDefined(asset, `${tool} ${os}/${arch}`);
        assert.match(asset.url, /^https:\/\//);
        assert.isTrue(asset.url.endsWith(asset.fileName));
        assert.match(asset.sha256, /^[a-f0-9]{64}$/);
      }
    }
  }
});

it("linux assets use statically linked musl builds", () => {
  const asset = releaseAsset("fd", { os: "linux", arch: "x64" });
  assert.isTrue(asset?.url.includes("unknown-linux-musl"));
});

it("Intel macOS uses the latest fd release that publishes that target", () => {
  const asset = releaseAsset("fd", { os: "darwin", arch: "x64" });
  assert.equal(asset?.version, FD_INTEL_DARWIN_VERSION);
});

it.effect(
  "bounded downloads reject oversized declared and streamed bodies",
  () =>
    Effect.gen(function* () {
      const request = HttpClientRequest.get(
        "https://example.com/archive.tar.gz",
      );
      const declared = HttpClientResponse.fromWeb(
        request,
        new Response("small", {
          headers: { "content-length": "100" },
        }),
      );
      const declaredError = yield* Effect.flip(
        readBoundedResponse(declared, 10),
      );
      assert.match(declaredError.message, /size limit/);

      const streamed = HttpClientResponse.fromWeb(
        request,
        new Response("this body is too large"),
      );
      const streamedError = yield* Effect.flip(
        readBoundedResponse(streamed, 5),
      );
      assert.match(streamedError.message, /size limit/);
    }),
);

// --- notification policy ----------------------------------------------------

it("notifications: only fresh installs notify", () => {
  const system: ResolvedBinary = {
    tool: "fd",
    command: "fd",
    source: "system",
  };
  const bundled: ResolvedBinary = {
    tool: "rg",
    command: "/repo/bin/rg",
    source: "bundled",
  };
  const installed: ResolvedBinary = {
    tool: "rg",
    command: "/repo/bin/rg",
    source: "installed",
    version: "15.2.0",
  };

  assert.deepEqual(installNotifications([system, bundled]), []);
  const messages = installNotifications([system, installed]);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /downloaded rg 15\.2\.0/);
});

// --- output truncation -------------------------------------------------------

it.effect("process output is streamed to a complete spill file", () =>
  Effect.gen(function* () {
    const result = yield* executeSearchProcess({
      command: process.execPath,
      args: ["-e", 'process.stdout.write("line\\n".repeat(3000))'],
      cwd: process.cwd(),
      tempPrefix: "pi-search-test-",
    });
    const formatted = formatCapturedOutput(result.output);

    assert.equal(result.code, 0);
    assert.isTrue(formatted.truncated);
    assert.equal(formatted.lineCount, 3000);
    assert.match(formatted.text, /2000 of 3000 lines/);
    assert.isDefined(formatted.fullOutputPath);

    const fs = yield* FileSystem.FileSystem;
    const fullOutput = yield* fs.readFileString(formatted.fullOutputPath);
    assert.equal(fullOutput, "line\n".repeat(3000));
    yield* fs.remove(dirname(formatted.fullOutputPath), {
      recursive: true,
      force: true,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("output: small results pass through untouched", async () => {
  const formatted = await formatOutput("a.ts\nb.ts\n", {
    tempPrefix: "pi-fd-",
    persistFullOutput: () => Promise.reject(new Error("should not persist")),
  });
  assert.equal(formatted.text, "a.ts\nb.ts");
  assert.equal(formatted.lineCount, 2);
  assert.isFalse(formatted.truncated);
  assert.isUndefined(formatted.fullOutputPath);
});

it("output: oversized results are truncated and persisted", async () => {
  const bigOutput = Array.from({ length: 3000 }, (_, i) => `file-${i}.ts`).join(
    "\n",
  );
  let persisted: string | undefined;
  const formatted = await formatOutput(bigOutput, {
    tempPrefix: "pi-fd-",
    persistFullOutput: async (full) => {
      persisted = full;
      return "/tmp/fake/output.txt";
    },
  });
  assert.isTrue(formatted.truncated);
  assert.equal(formatted.fullOutputPath, "/tmp/fake/output.txt");
  assert.equal(persisted, bigOutput);
  assert.match(formatted.text, /\[Output truncated: 2000 of 3000 lines/);
  assert.match(
    formatted.text,
    /Full output saved to: \/tmp\/fake\/output\.txt\]/,
  );
  const shownLines = formatted.text.split("\n");
  assert.equal(shownLines[0], "file-0.ts");
});

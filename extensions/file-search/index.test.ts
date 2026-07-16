import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Effect, Exit } from "effect";
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
  type BinaryEnv,
  type ReleaseAsset,
  type ResolvedBinary,
} from "./src/binaries.ts";
import { formatOutput } from "./src/output.ts";
import { awaitWithSignal, installNotifications } from "./index.ts";

// --- argument construction -------------------------------------------------

test("fd args: defaults list everything with the default limit", () => {
  assert.deepEqual(buildFdArgs({}), [
    "--color=never",
    "--max-results",
    String(FD_DEFAULT_LIMIT),
    "--",
    "",
  ]);
});

test("fd args: all options are translated and pattern stays behind --", () => {
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

test("fd args: out-of-range values are clamped", () => {
  const args = buildFdArgs({ max_depth: 500, limit: 1_000_000 });
  assert.ok(args.includes("64"));
  assert.ok(args.includes("10000"));
});

test("rg args: defaults use smart-case and safe separators", () => {
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

test("rg args: all options are translated", () => {
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

test("rg args: case_sensitive false forces ignore-case", () => {
  const args = buildRgArgs({ pattern: "x", case_sensitive: false });
  assert.ok(args.includes("--ignore-case"));
  assert.ok(!args.includes("--smart-case"));
});

test("path normalization strips leading @ and expands ~", () => {
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

test("binary resolution: system fd wins and nothing is installed", async () => {
  const env = makeEnv({ available: ["fd"] });
  const resolved = await Effect.runPromise(
    resolveBinary(TOOL_SPECS.fd, "/repo/bin", darwinArm, env),
  );
  assert.deepEqual(resolved, { tool: "fd", command: "fd", source: "system" });
  assert.equal(env.installs.length, 0);
});

test("binary resolution: fdfind is accepted as a system fd", async () => {
  const env = makeEnv({ available: ["fdfind"] });
  const resolved = await Effect.runPromise(
    resolveBinary(TOOL_SPECS.fd, "/repo/bin", darwinArm, env),
  );
  assert.deepEqual(resolved, {
    tool: "fd",
    command: "fdfind",
    source: "system",
  });
  assert.equal(env.installs.length, 0);
});

test("binary resolution: existing bin fallback is used silently", async () => {
  const env = makeEnv({ available: ["/repo/bin/rg"] });
  const resolved = await Effect.runPromise(
    resolveBinary(TOOL_SPECS.rg, "/repo/bin", darwinArm, env),
  );
  assert.deepEqual(resolved, {
    tool: "rg",
    command: "/repo/bin/rg",
    source: "bundled",
  });
  assert.equal(env.installs.length, 0);
});

test("binary resolution: missing everywhere triggers exactly one install", async () => {
  const env = makeEnv({ available: [] });
  const resolved = await Effect.runPromise(
    resolveBinary(TOOL_SPECS.rg, "/repo/bin", darwinArm, env),
  );
  assert.equal(resolved.source, "installed");
  assert.equal(resolved.command, "/repo/bin/rg");
  assert.equal(env.installs.length, 1);
  assert.match(
    env.installs[0].url,
    /^https:\/\/github\.com\/BurntSushi\/ripgrep\//,
  );
});

test("binary resolution: install failure surfaces a typed error", async () => {
  const env = makeEnv({ available: [], installShouldFail: true });
  const exit = await Effect.runPromiseExit(
    resolveBinary(TOOL_SPECS.fd, "/repo/bin", darwinArm, env),
  );
  assert.ok(Exit.isFailure(exit));
});

test("binary resolution: unsupported platform fails without installing", async () => {
  const env = makeEnv({ available: [] });
  const exit = await Effect.runPromiseExit(
    resolveBinary(
      TOOL_SPECS.fd,
      "/repo/bin",
      { os: "linux", arch: "s390x" },
      env,
    ),
  );
  assert.ok(Exit.isFailure(exit));
  assert.equal(env.installs.length, 0);
});

test("release assets cover macOS and Linux on arm64 and x64 over HTTPS", () => {
  for (const os of ["darwin", "linux"] as const) {
    for (const arch of ["arm64", "x64"] as const) {
      for (const tool of ["fd", "rg"] as const) {
        const asset = releaseAsset(tool, { os, arch });
        assert.ok(asset, `${tool} ${os}/${arch}`);
        assert.match(asset.url, /^https:\/\//);
        assert.ok(asset.url.endsWith(asset.fileName));
        assert.match(asset.sha256, /^[a-f0-9]{64}$/);
      }
    }
  }
});

test("linux assets use statically linked musl builds", () => {
  const asset = releaseAsset("fd", { os: "linux", arch: "x64" });
  assert.ok(asset && asset.url.includes("unknown-linux-musl"));
});

test("Intel macOS uses the latest fd release that publishes that target", () => {
  const asset = releaseAsset("fd", { os: "darwin", arch: "x64" });
  assert.equal(asset?.version, FD_INTEL_DARWIN_VERSION);
});

test("bounded downloads reject oversized declared and streamed bodies", async () => {
  const declared = new Response("small", {
    headers: { "content-length": "100" },
  });
  await assert.rejects(readBoundedResponse(declared, 10), /size limit/);

  const streamed = new Response("this body is too large");
  await assert.rejects(readBoundedResponse(streamed, 5), /size limit/);
});

// --- notification policy ----------------------------------------------------

test("notifications: only fresh installs notify", () => {
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

test("a caller can stop waiting for shared binary initialization", async () => {
  const controller = new AbortController();
  const sharedInitialization = new Promise<string>(() => {});
  const waiting = awaitWithSignal(
    sharedInitialization,
    controller.signal,
    "setup cancelled",
  );
  controller.abort();
  await assert.rejects(waiting, /setup cancelled/);
});

// --- output truncation -------------------------------------------------------

test("output: small results pass through untouched", async () => {
  const formatted = await formatOutput("a.ts\nb.ts\n", {
    tempPrefix: "pi-fd-",
    persistFullOutput: () => Promise.reject(new Error("should not persist")),
  });
  assert.equal(formatted.text, "a.ts\nb.ts");
  assert.equal(formatted.lineCount, 2);
  assert.equal(formatted.truncated, false);
  assert.equal(formatted.fullOutputPath, undefined);
});

test("output: oversized results are truncated and persisted", async () => {
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
  assert.equal(formatted.truncated, true);
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

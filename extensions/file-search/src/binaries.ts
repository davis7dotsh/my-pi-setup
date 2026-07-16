/**
 * Startup resolution of the fd and rg executables.
 *
 * Resolution order (per tool, first usable wins):
 *   1. A normally installed system binary (`fd`/`fdfind`, `rg`) — used silently.
 *   2. An existing fallback in this repository's `bin/` directory — used silently.
 *   3. A fresh download of an official release into `bin/` — the only case that
 *      should surface a UI notification.
 *
 * The decision logic is an Effect over a small injectable environment
 * (`BinaryEnv`) so tests can drive it without touching the filesystem or the
 * network. `liveBinaryEnv` is the real implementation.
 */

import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Data, Effect } from "effect";

const execFileAsync = promisify(execFile);

export const FD_VERSION = "10.4.2";
export const RG_VERSION = "15.2.0";

export type ToolName = "fd" | "rg";
export type BinarySource = "system" | "bundled" | "installed";

export interface ToolSpec {
  readonly tool: ToolName;
  /** Commands probed on PATH, in order. Debian/Ubuntu install fd as `fdfind`. */
  readonly systemCommands: readonly string[];
  /** Executable name used inside release archives and the repo bin directory. */
  readonly binaryName: string;
}

export const TOOL_SPECS: Record<ToolName, ToolSpec> = {
  fd: { tool: "fd", systemCommands: ["fd", "fdfind"], binaryName: "fd" },
  rg: { tool: "rg", systemCommands: ["rg"], binaryName: "rg" },
};

export interface PlatformTarget {
  readonly os: string;
  readonly arch: string;
}

export interface ReleaseAsset {
  readonly url: string;
  readonly fileName: string;
  /** Top-level directory inside the tarball. */
  readonly archiveDir: string;
  readonly binaryName: string;
  readonly version: string;
}

function targetTriple(target: PlatformTarget) {
  const cpu =
    target.arch === "arm64"
      ? "aarch64"
      : target.arch === "x64"
        ? "x86_64"
        : undefined;
  if (!cpu) return undefined;
  if (target.os === "darwin") return `${cpu}-apple-darwin`;
  // musl builds are statically linked, so they run on any Linux distribution.
  if (target.os === "linux") return `${cpu}-unknown-linux-musl`;
  return undefined;
}

/** Official GitHub release asset for a tool on a platform, if supported. */
export function releaseAsset(
  tool: ToolName,
  target: PlatformTarget,
): ReleaseAsset | undefined {
  const triple = targetTriple(target);
  if (!triple) return undefined;

  if (tool === "fd") {
    const archiveDir = `fd-v${FD_VERSION}-${triple}`;
    const fileName = `${archiveDir}.tar.gz`;
    return {
      url: `https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/${fileName}`,
      fileName,
      archiveDir,
      binaryName: "fd",
      version: FD_VERSION,
    };
  }

  const archiveDir = `ripgrep-${RG_VERSION}-${triple}`;
  const fileName = `${archiveDir}.tar.gz`;
  return {
    url: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${fileName}`,
    fileName,
    archiveDir,
    binaryName: "rg",
    version: RG_VERSION,
  };
}

export function currentTarget(): PlatformTarget {
  return { os: process.platform, arch: process.arch };
}

/** Repository root (`~/.pi/agent`) resolved from this module's location. */
export function repositoryBinDir() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return join(moduleDir, "..", "..", "..", "bin");
}

export class UnsupportedPlatformError extends Data.TaggedError(
  "UnsupportedPlatformError",
)<{
  readonly message: string;
}> {}

export class InstallError extends Data.TaggedError("InstallError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface BinaryEnv {
  /** True when the executable exists and runs (`--version` succeeds). */
  readonly probe: (command: string) => Effect.Effect<boolean>;
  /** Download and place a release binary at the destination path. */
  readonly install: (
    asset: ReleaseAsset,
    destination: string,
  ) => Effect.Effect<void, InstallError>;
}

export interface ResolvedBinary {
  readonly tool: ToolName;
  /** Command or absolute path passed to pi.exec. */
  readonly command: string;
  readonly source: BinarySource;
  readonly version?: string;
}

/** Resolve one tool: system binary, existing bin fallback, or fresh install. */
export function resolveBinary(
  spec: ToolSpec,
  binDir: string,
  target: PlatformTarget,
  env: BinaryEnv,
): Effect.Effect<ResolvedBinary, UnsupportedPlatformError | InstallError> {
  return Effect.gen(function* () {
    for (const command of spec.systemCommands) {
      if (yield* env.probe(command)) {
        return { tool: spec.tool, command, source: "system" as const };
      }
    }

    const bundled = join(binDir, spec.binaryName);
    if (yield* env.probe(bundled)) {
      return { tool: spec.tool, command: bundled, source: "bundled" as const };
    }

    const asset = releaseAsset(spec.tool, target);
    if (!asset) {
      return yield* new UnsupportedPlatformError({
        message: `No ${spec.tool} binary is available for ${target.os}/${target.arch}. Install ${spec.tool} manually and restart pi.`,
      });
    }

    yield* env.install(asset, bundled);

    if (!(yield* env.probe(bundled))) {
      return yield* new InstallError({
        message: `${spec.tool} ${asset.version} was installed to ${bundled} but failed to run.`,
      });
    }

    return {
      tool: spec.tool,
      command: bundled,
      source: "installed" as const,
      version: asset.version,
    };
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Real environment: probes via `--version`, installs via HTTPS + tar. */
export const liveBinaryEnv: BinaryEnv = {
  probe: (command) =>
    Effect.promise(async () => {
      try {
        await execFileAsync(command, ["--version"], { timeout: 5_000 });
        return true;
      } catch {
        return false;
      }
    }),

  install: (asset, destination) =>
    Effect.tryPromise({
      try: async () => {
        const url = new URL(asset.url);
        if (url.protocol !== "https:") {
          throw new Error(`refusing non-HTTPS download URL: ${asset.url}`);
        }

        const response = await fetch(asset.url, { redirect: "follow" });
        if (!response.ok) {
          throw new Error(`download failed with HTTP ${response.status}`);
        }
        const bytes = Buffer.from(await response.arrayBuffer());

        const workDir = await mkdtemp(join(tmpdir(), "pi-file-search-"));
        try {
          const archivePath = join(workDir, asset.fileName);
          await writeFile(archivePath, bytes);
          await execFileAsync("tar", ["-xzf", archivePath, "-C", workDir], {
            timeout: 60_000,
          });

          const extracted = join(workDir, asset.archiveDir, asset.binaryName);
          await mkdir(dirname(destination), { recursive: true });
          await copyFile(extracted, destination);
          await chmod(destination, 0o755);
        } finally {
          await rm(workDir, { recursive: true, force: true });
        }
      },
      catch: (cause) =>
        new InstallError({
          message: `Failed to install ${asset.binaryName} ${asset.version} from ${asset.url}: ${errorMessage(cause)}`,
          cause,
        }),
    }),
};

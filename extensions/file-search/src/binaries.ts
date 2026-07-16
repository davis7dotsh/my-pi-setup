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

import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Crypto, Data, Effect, Encoding, FileSystem, Stream } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const execFileAsync = promisify(execFile);

export const FD_VERSION = "10.4.2";
export const FD_INTEL_DARWIN_VERSION = "10.3.0";
export const RG_VERSION = "15.2.0";

const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_DOWNLOAD_REDIRECTS = 10;

const FD_SHA256: Readonly<Record<string, string>> = {
  "aarch64-apple-darwin":
    "623dc0afc81b92e4d4606b380d7bc91916ba7b97814263e554d50923a39e480a",
  "x86_64-apple-darwin":
    "50d30f13fe3d5914b14c4fff5abcbd4d0cdab4b855970a6956f4f006c17117a3",
  "aarch64-unknown-linux-musl":
    "f32d3657473fba74e2600babc8db0b93420d51169223b7e8143b2ed55d8fd9e8",
  "x86_64-unknown-linux-musl":
    "e3257d48e29a6be965187dbd24ce9af564e0fe67b3e73c9bdcd180f4ec11bdde",
};

const RG_SHA256: Readonly<Record<string, string>> = {
  "aarch64-apple-darwin":
    "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4",
  "x86_64-apple-darwin":
    "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1",
  "aarch64-unknown-linux-musl":
    "800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915",
  "x86_64-unknown-linux-musl":
    "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
};

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
  readonly sha256: string;
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
    const sha256 = FD_SHA256[triple];
    if (!sha256) return undefined;
    // fd 10.4.2 dropped the Intel macOS archive, so retain 10.3.0 there.
    const version =
      triple === "x86_64-apple-darwin" ? FD_INTEL_DARWIN_VERSION : FD_VERSION;
    const archiveDir = `fd-v${version}-${triple}`;
    const fileName = `${archiveDir}.tar.gz`;
    return {
      url: `https://github.com/sharkdp/fd/releases/download/v${version}/${fileName}`,
      fileName,
      archiveDir,
      binaryName: "fd",
      version,
      sha256,
    };
  }

  const sha256 = RG_SHA256[triple];
  if (!sha256) return undefined;
  const archiveDir = `ripgrep-${RG_VERSION}-${triple}`;
  const fileName = `${archiveDir}.tar.gz`;
  return {
    url: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${fileName}`,
    fileName,
    archiveDir,
    binaryName: "rg",
    version: RG_VERSION,
    sha256,
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
  /** True when the executable runs and supports the flags this tool requires. */
  readonly probe: (command: string, tool: ToolName) => Effect.Effect<boolean>;
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
      if (yield* env.probe(command, spec.tool)) {
        return { tool: spec.tool, command, source: "system" as const };
      }
    }

    const bundled = join(binDir, spec.binaryName);
    if (yield* env.probe(bundled, spec.tool)) {
      return { tool: spec.tool, command: bundled, source: "bundled" as const };
    }

    const asset = releaseAsset(spec.tool, target);
    if (!asset) {
      return yield* new UnsupportedPlatformError({
        message: `No ${spec.tool} binary is available for ${target.os}/${target.arch}. Install ${spec.tool} manually and restart pi.`,
      });
    }

    yield* env.install(asset, bundled);

    if (!(yield* env.probe(bundled, spec.tool))) {
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

/** Read a response incrementally while enforcing the startup memory bound. */
export function readBoundedResponse<E, R>(
  response: {
    readonly headers: Readonly<Record<string, string | undefined>>;
    readonly stream: Stream.Stream<Uint8Array, E, R>;
  },
  maxBytes = MAX_ARCHIVE_BYTES,
) {
  return Effect.gen(function* () {
    const declaredLength = Number(response.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return yield* Effect.fail(
        new Error(`download exceeds the ${maxBytes}-byte size limit`),
      );
    }

    const result = yield* Stream.runFoldEffect(
      response.stream,
      () => ({ chunks: [] as Uint8Array[], totalBytes: 0 }),
      (accumulator, chunk) => {
        const totalBytes = accumulator.totalBytes + chunk.byteLength;
        if (totalBytes > maxBytes) {
          return Effect.fail(
            new Error(`download exceeds the ${maxBytes}-byte size limit`),
          );
        }
        return Effect.sync(() => {
          accumulator.chunks.push(chunk);
          accumulator.totalBytes = totalBytes;
          return accumulator;
        });
      },
    );

    return Buffer.concat(result.chunks, result.totalBytes);
  });
}

function downloadAsset(client: HttpClient.HttpClient, initialUrl: URL) {
  const scopedClient = client.pipe(HttpClient.withScope);

  return Effect.gen(function* () {
    let url = initialUrl;

    for (let redirects = 0; redirects <= MAX_DOWNLOAD_REDIRECTS; redirects++) {
      if (url.protocol !== "https:") {
        return yield* Effect.fail(
          new Error(`refusing non-HTTPS download URL: ${url.href}`),
        );
      }

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const response = yield* scopedClient.get(url);
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.location;
            if (!location) {
              return yield* Effect.fail(
                new Error(`redirect from ${url.href} had no location header`),
              );
            }
            if (redirects === MAX_DOWNLOAD_REDIRECTS) {
              return yield* Effect.fail(
                new Error(
                  `download exceeded ${MAX_DOWNLOAD_REDIRECTS} redirects`,
                ),
              );
            }
            if (!URL.canParse(location, url)) {
              return yield* Effect.fail(
                new Error(
                  `download returned an invalid redirect URL: ${location}`,
                ),
              );
            }
            return { _tag: "Redirect" as const, url: new URL(location, url) };
          }

          if (response.status < 200 || response.status >= 300) {
            return yield* Effect.fail(
              new Error(`download failed with HTTP ${response.status}`),
            );
          }
          return {
            _tag: "Complete" as const,
            bytes: yield* readBoundedResponse(response),
          };
        }),
      );

      if (result._tag === "Complete") return result.bytes;
      url = result.url;
    }

    return yield* Effect.fail(new Error("download redirect handling failed"));
  });
}

/** Real environment: probes via `--version`, installs via HTTPS + tar. */
export const liveBinaryEnv: BinaryEnv = {
  probe: (command, tool) =>
    Effect.promise(async () => {
      try {
        const args =
          tool === "fd" ? ["--max-results", "1", "--", ""] : ["--version"];
        await execFileAsync(command, args, {
          cwd: tmpdir(),
          timeout: 5_000,
        });
        return true;
      } catch {
        return false;
      }
    }),

  install: (asset, destination) => {
    const install = Effect.gen(function* () {
      if (!URL.canParse(asset.url)) {
        return yield* Effect.fail(
          new Error(`invalid download URL: ${asset.url}`),
        );
      }

      const url = new URL(asset.url);
      const client = yield* HttpClient.HttpClient;
      const fs = yield* FileSystem.FileSystem;
      const crypto = yield* Crypto.Crypto;
      const bytes = yield* downloadAsset(client, url).pipe(
        Effect.timeout(DOWNLOAD_TIMEOUT_MS),
      );

      const digestBytes = yield* crypto.digest("SHA-256", bytes);
      const digest = Encoding.encodeHex(digestBytes);
      if (digest !== asset.sha256) {
        return yield* Effect.fail(
          new Error(
            `SHA-256 mismatch for ${asset.fileName}: expected ${asset.sha256}, received ${digest}`,
          ),
        );
      }

      const workDir = yield* fs.makeTempDirectoryScoped({
        prefix: "pi-file-search-",
      });
      const archivePath = join(workDir, asset.fileName);
      yield* fs.writeFile(archivePath, bytes);

      const tarExitCode = yield* Effect.scoped(
        Effect.gen(function* () {
          const tar = yield* ChildProcess.make(
            "tar",
            ["-xzf", archivePath, "-C", workDir],
            { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
          );
          return yield* tar.exitCode;
        }),
      ).pipe(Effect.timeout(60_000));
      if (tarExitCode !== ChildProcessSpawner.ExitCode(0)) {
        return yield* Effect.fail(
          new Error(`tar failed with exit code ${tarExitCode}`),
        );
      }

      const extracted = join(workDir, asset.archiveDir, asset.binaryName);
      yield* fs.makeDirectory(dirname(destination), { recursive: true });
      const uuid = yield* crypto.randomUUIDv4;
      const stagedDestination = `${destination}.${process.pid}.${uuid}.tmp`;
      yield* Effect.addFinalizer(() =>
        fs.remove(stagedDestination, { force: true }).pipe(Effect.orDie),
      );
      yield* fs.copyFile(extracted, stagedDestination);
      yield* fs.chmod(stagedDestination, 0o755);
      yield* fs.rename(stagedDestination, destination);
    });

    return install.pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.provide(NodeHttpClient.layerFetch),
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
      }),
      Effect.mapError(
        (cause) =>
          new InstallError({
            message: `Failed to install ${asset.binaryName} ${asset.version} from ${asset.url}: ${errorMessage(cause)}`,
            cause,
          }),
      ),
    );
  },
};

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EphemeralManifest } from "./types.ts";
import { MANIFEST_VERSION, ensureTrailingNewline, isJsonObject } from "./util.ts";

export function createEmptyManifest(): EphemeralManifest {
  return {
    version: MANIFEST_VERSION,
    items: {},
  };
}

export async function readManifest(manifestPath: string): Promise<EphemeralManifest> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return createEmptyManifest();
    }
    throw error;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!isJsonObject(parsed) || parsed.version !== MANIFEST_VERSION || !isJsonObject(parsed.items)) {
    throw new Error(`Invalid Ephemeral manifest: ${manifestPath}`);
  }

  const items = parsed.items as Record<string, unknown>;
  if (!Object.values(items).every((item) => isJsonObject(item))) {
    throw new Error(`Invalid Ephemeral manifest: ${manifestPath}`);
  }

  return {
    version: MANIFEST_VERSION,
    items: items as unknown as EphemeralManifest["items"],
  };
}

export async function writeManifest(manifestPath: string, manifest: EphemeralManifest): Promise<void> {
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, ensureTrailingNewline(JSON.stringify(manifest, null, 2)), "utf8");
}

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

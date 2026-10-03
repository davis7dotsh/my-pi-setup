/**
 * Branch-local mode bookkeeping for custom-ocr.
 *
 * The current mode ("hosted" for the provider-backed default, "private" for
 * the fail-closed local pipeline) is persisted as a custom session entry so it
 * survives reload/resume and follows the branch when forked. Every genuinely
 * new session defaults to hosted parsing.
 */

export type OcrMode = "hosted" | "private";

export const MODE_ENTRY_TYPE = "custom-ocr-mode";

export interface ModeEntryData {
  readonly mode: OcrMode;
}

interface BranchEntryLike {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
}

export function isOcrMode(value: unknown): value is OcrMode {
  return value === "hosted" || value === "private";
}

/** Walk the current branch and return the most recent persisted mode. */
export function readModeFromBranch(entries: readonly BranchEntryLike[]) {
  let mode: OcrMode = "hosted";
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== MODE_ENTRY_TYPE) {
      continue;
    }
    const data = entry.data as Partial<ModeEntryData> | undefined;
    if (data && isOcrMode(data.mode)) mode = data.mode;
  }
  return mode;
}

export type PrivateImageAction =
  | { readonly action: "set"; readonly mode: OcrMode }
  | { readonly action: "status" }
  | { readonly action: "error"; readonly message: string };

/**
 * Parse `/private-image` arguments. No argument toggles, `on`/`off` set the
 * mode explicitly, and `status` reports the current state.
 */
export function parsePrivateImageArgs(
  args: string | undefined,
  current: OcrMode,
): PrivateImageAction {
  const trimmed = (args ?? "").trim().toLowerCase();
  if (trimmed === "") {
    return {
      action: "set",
      mode: current === "private" ? "hosted" : "private",
    };
  }
  if (trimmed === "on") return { action: "set", mode: "private" };
  if (trimmed === "off") return { action: "set", mode: "hosted" };
  if (trimmed === "status") return { action: "status" };
  return {
    action: "error",
    message: `Unknown argument "${trimmed}". Use /private-image [on|off|status].`,
  };
}

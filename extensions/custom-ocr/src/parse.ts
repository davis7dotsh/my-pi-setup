/**
 * Backend-agnostic parse orchestration.
 *
 * The tool handler injects concrete backends. The mode switch here is the
 * single decision point between Luna and the private pipeline: when the mode
 * is "private" the Luna backend is structurally unreachable (verified by the
 * privacy sentinel test).
 */
import {
  normalizePageRange,
  type PageRange,
  type ResolvedFile,
} from "./files.ts";
import type { OcrMode } from "./mode.ts";
import { mergePageResults, truncateOutput, type PageResult } from "./output.ts";

export interface ParseRequest {
  readonly path: string;
  readonly question?: string;
  readonly pages?: PageRange;
}

export interface RenderedDocument {
  readonly pages: readonly { readonly page: number; readonly path: string }[];
  readonly totalPages: number;
  readonly warnings: readonly string[];
  cleanup(): Promise<void>;
}

export interface ParseDeps {
  readonly mode: OcrMode;
  resolveFile(rawPath: string): Promise<ResolvedFile>;
  render(file: ResolvedFile, range: PageRange): Promise<RenderedDocument>;
  runLuna(doc: RenderedDocument, question?: string): Promise<string>;
  runPrivate(
    doc: RenderedDocument,
    question?: string,
  ): Promise<readonly PageResult[]>;
  saveFullResult(text: string): Promise<string>;
}

export interface ParseOutcome {
  readonly text: string;
  readonly mode: OcrMode;
  readonly file: ResolvedFile;
  readonly pageCount: number;
  readonly totalPages: number;
  readonly warnings: readonly string[];
  readonly truncated: boolean;
  readonly fullResultPath?: string;
}

export async function executeParse(request: ParseRequest, deps: ParseDeps) {
  const range = normalizePageRange(request.pages);
  const file = await deps.resolveFile(request.path);
  const doc = await deps.render(file, range);
  try {
    const merged =
      deps.mode === "private"
        ? mergePageResults(await deps.runPrivate(doc, request.question))
        : await deps.runLuna(doc, request.question);

    const warningPrefix =
      doc.warnings.length > 0
        ? `${doc.warnings.map((warning) => `⚠ ${warning}`).join("\n")}\n\n`
        : "";
    const decorated = `${warningPrefix}${merged}`;
    const truncation = truncateOutput(decorated);
    let fullResultPath: string | undefined;
    let text = truncation.text;
    if (truncation.truncated) {
      fullResultPath = await deps.saveFullResult(merged);
      const notice = `\n\n[output truncated at Pi's tool limits — full result saved to ${fullResultPath}]`;
      text = `${truncateOutput(decorated, notice).text}${notice}`;
    }

    return {
      text,
      mode: deps.mode,
      file,
      pageCount: doc.pages.length,
      totalPages: doc.totalPages,
      warnings: doc.warnings,
      truncated: truncation.truncated,
      fullResultPath,
    } satisfies ParseOutcome;
  } finally {
    // Cleanup is best-effort after bounded retries in the concrete renderer;
    // it must not replace the OCR result or the actionable backend error.
    await doc.cleanup().catch(() => {});
  }
}

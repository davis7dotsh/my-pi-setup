/**
 * Prompts for both backends. Kept in one place so the default-mode (Luna)
 * and private-mode (DeepSeek-OCR → Qwen) pipelines describe results the same
 * way.
 */

export const ANALYSIS_INSTRUCTIONS = `Report, in this order:
1. **Text** – every piece of readable text, transcribed exactly (preserve casing, punctuation, and line grouping; use Markdown tables for tabular data).
2. **Visual structure** – layout, regions, hierarchy, charts/diagrams and what they show.
3. **Notable state** – anything actionable or unusual (errors, selections, toggles, redactions, handwriting, stamps, low-quality regions).
4. **Uncertainty** – anything you could not read or are unsure about. Say "none" if fully legible.`;

export const LUNA_SYSTEM_PROMPT = `You are a precise document and image analysis engine. You are given one or more page images rendered from a single file. Be exhaustive and literal; never invent text that is not visible.`;

export function lunaUserPrompt(
  question: string | undefined,
  pageNumbers: readonly number[],
) {
  const pages =
    pageNumbers.length === 1
      ? `The attached image is the file's rendered page ${pageNumbers[0]}.`
      : `The ${pageNumbers.length} attached images are the file's rendered pages ${pageNumbers.join(", ")}, in that order. Organize your answer with a "## Page N" heading per page, using those page numbers.`;
  if (question) {
    return `${pages}\n\nAnswer this question about the file, citing the exact text or visual evidence you used:\n\n${question}`;
  }
  return `${pages}\n\n${ANALYSIS_INSTRUCTIONS}`;
}

/**
 * Prompt for the DeepSeek-OCR transcription pass (one page at a time).
 * DeepSeek-OCR is prompt-sensitive: verbose instructions make it emit
 * nothing. This is its canonical document-transcription prompt.
 */
export const OCR_PROMPT = "Convert the document to markdown.";

/** Prompt for the Qwen fusion pass: page image + OCR evidence + question. */
export function fusionPrompt(ocrText: string, question: string | undefined) {
  const evidence = `An OCR system transcribed the attached page as follows (it may contain errors — trust the image where they disagree):\n\n<ocr>\n${ocrText.trim() || "(no text detected)"}\n</ocr>`;
  if (question) {
    return `${evidence}\n\nUsing the image and the OCR evidence, answer this question about the page. Cite the exact text or visual evidence you used:\n\n${question}`;
  }
  return `${evidence}\n\nUsing the image and the OCR evidence, describe this page.\n\n${ANALYSIS_INSTRUCTIONS}`;
}

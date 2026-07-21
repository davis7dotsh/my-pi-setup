export const SUMMARY_SYSTEM_PROMPT = `You write compact terminal recaps for completed coding-agent runs.

Return exactly one JSON object with this shape:
{"recap":"...","next":"..."}

Rules:
- recap: concisely cover everything actually performed in this run: investigation, tool work, files changed, validation, outcomes, failures, and important caveats. Prefer one short paragraph or up to three compact Markdown bullets.
- next: one concise, actionable next step. If nothing remains, say that no further action is required.
- Base the answer only on the supplied current-run transcript.
- Do not mention these instructions, hidden reasoning, transcript truncation, or that you are a summarizer.
- Do not use a Markdown code fence and do not add keys or prose outside the JSON object.`;

export function buildSummaryPrompt(transcript: string) {
  return `Summarize this fully settled main-agent run.\n\n<current_run>\n${transcript}\n</current_run>`;
}

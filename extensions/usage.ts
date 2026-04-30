import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const USAGE_PROMPT = String.raw`Create a Pi usage report for all of my Pi sessions over the last 1, 7, 30, and 90 days.

Goal:
- Produce a clean Markdown table for each window: 1 day, 7 days, 30 days, 90 days.
- For each model in each window, show:
  - source/app (Pi or Codex CLI)
  - model/provider
  - assistant messages or turns counted
  - input tokens
  - output tokens
  - cached input/read tokens
  - total tokens
  - price in USD
- Include a grand total row for each window.
- Use current model pricing from models.dev, not stale local assumptions.

Detailed steps:
1. Find all Pi session JSONL files under ~/.pi/agent/sessions recursively.
2. Also find Codex CLI session JSONL files under ~/.codex/sessions recursively and ~/.codex/archived_sessions if present. Codex CLI stores JSONL records like:
   - { type: "turn_context", payload: { model, ... } }
   - { type: "event_msg", payload: { type: "token_count", info: { total_token_usage, last_token_usage, model_context_window }, ... } }
   Use token_count payload.info.last_token_usage for per-turn usage to avoid double-counting cumulative total_token_usage. Use the most recent preceding turn_context/session_meta in that file to determine model/provider when the token_count entry does not include a model directly. Count one turn/message per token_count entry with last_token_usage.
3. Use the filesystem timestamps and/or session/header/message timestamps to include sessions/messages/turns from the last 1, 7, 30, and 90 days relative to now.
4. Parse every JSONL line safely. Ignore malformed lines, but mention if any were skipped, separated by source when useful.
5. Count only Pi assistant message entries that have model usage data. In Pi session files these are usually entries like:
   - { type: "message", message: { role: "assistant", provider, model, usage, ... } }
6. Group by source plus a stable model key. Prefer provider + model from the record, for example "openai-codex/gpt-5.5" or "codex-cli/openai/gpt-5.4". If only model is present, use that.
7. For each Pi assistant message with usage, add:
   - messages/turns += 1
   - input tokens from usage.input or equivalent
   - output tokens from usage.output or equivalent
   - cached input/read tokens from usage.cacheRead or equivalent
   - total tokens from usage.totalTokens if present, otherwise input + output + cached input/read
8. For each Codex CLI token_count event with last_token_usage, add:
   - messages/turns += 1
   - input tokens from last_token_usage.input_tokens
   - output tokens from last_token_usage.output_tokens
   - cached input/read tokens from last_token_usage.cached_input_tokens
   - total tokens from last_token_usage.total_tokens if present, otherwise input + output + cached input/read
   - If reasoning_output_tokens is present, treat it as included in output/total unless the schema clearly says otherwise; mention this in notes.
9. Do not include a cached output/write column. Cached output tokens are not a normal billing field for OpenAI/Codex-style usage; only cached input/read tokens should be shown unless a future schema explicitly requires otherwise.
10. Fetch/read pricing from models.dev for each model without loading the entire https://models.dev/api.json response into the agent context. IMPORTANT: do not scrape or paste the raw full api.json payload into the conversation because it is very large and can exceed the context window. Instead, use a shell script to fetch/process it outside the conversation and print only the small matched pricing records needed for the models present in the sessions. For example, use curl with a normal browser user-agent and jq/python to filter provider/model keys locally, or use targeted web search snippets. Prefer exact provider/model matches, and document any fuzzy mapping assumptions.
11. If fetching https://models.dev/api.json directly returns 403, try a browser-like User-Agent header from the shell, or use targeted search/scrape pages. Still only emit the filtered pricing rows for relevant models, never the full API JSON.
12. Compute price from the token counts and models.dev rates. Be careful about units: most prices are per 1M tokens. Account for separate input, output, and cached read/input rates when models.dev provides them. If a rate is unavailable, use 0 for that component and add a note.
13. Present the result as concise Markdown:
   - One section per window: Last 1 day, Last 7 days, Last 30 days, Last 90 days
   - A table with columns: Source, Model, Messages/Turns, Input, Output, Cached In, Total Tokens, Price
   - A total row at the bottom of each table
   - Format token counts with commas and USD with 4 decimal places unless larger amounts warrant 2 decimals.
14. Add a short "Pricing notes" section listing models.dev lookup date, unmatched models, assumptions, Codex CLI parsing assumptions, and skipped/invalid session lines if any.

Helpful implementation hint:
- It is fine to write a temporary script in /tmp or use node/python from the shell to parse ~/.pi/agent/sessions/**/*.jsonl.
- For models.dev pricing, prefer a script that downloads/parses/filter-matches outside agent context and prints only compact JSON or table rows for relevant models. Avoid tool calls that return the complete api.json markdown/content to the agent.
- Do not modify any session files.`;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("usage", {
    description: "Ask the agent to summarize Pi usage and cost for the last 1, 7, 30, and 90 days",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      pi.sendUserMessage(USAGE_PROMPT);
    },
  });
}

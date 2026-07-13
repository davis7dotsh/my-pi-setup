/**
 * Formatting helpers (self-contained copies of the v1 shared helpers:
 * context-utilization + activity-status).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";

export interface ContextUtilization {
  /** Current conversation context occupancy; undefined while unknown. */
  tokens?: number | null;
  /** Capacity of the model currently serving the conversation. */
  contextWindow?: number | null;
}

function usableTokens(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function usableCapacity(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function contextPercent(usage: ContextUtilization) {
  const tokens = usableTokens(usage.tokens);
  const capacity = usableCapacity(usage.contextWindow);
  if (tokens === undefined || capacity === undefined) return undefined;
  return Math.round(Math.min(100, Math.max(0, (tokens / capacity) * 100)));
}

export function formatCompactTokens(count: number) {
  if (count < 1000) return Math.round(count).toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * Render `%/capacity`. If occupancy is unknown, retain the useful capacity
 * as `?%/capacity`; with no valid capacity, omit the statistic entirely.
 */
export function formatContextUtilization(usage: ContextUtilization) {
  const capacity = usableCapacity(usage.contextWindow);
  if (capacity === undefined) return "";
  const percent = contextPercent(usage);
  return `${percent === undefined ? "?" : percent}%/${formatCompactTokens(capacity)}`;
}

interface ActivityCounts {
  running: number;
  done: number;
  failed: number;
}

const SQUARE = "■";

export function formatActivityStatus(theme: Theme, counts: ActivityCounts) {
  const parts: string[] = [];
  if (counts.running > 0) {
    parts.push(theme.fg("warning", `${SQUARE} ${counts.running} running`));
  }
  if (counts.done > 0) {
    parts.push(theme.fg("success", `${SQUARE} ${counts.done} done`));
  }
  if (counts.failed > 0) {
    parts.push(theme.fg("error", `${SQUARE} ${counts.failed} failed`));
  }
  parts.push(theme.fg("accent", "/subagents") + theme.fg("dim", " to view"));

  return `${theme.fg("muted", "subagents:")} ${parts.join(theme.fg("dim", " · "))}`;
}

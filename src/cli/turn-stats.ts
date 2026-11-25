import { formatElapsed } from "./activity.js";

/**
 * Output-token throughput. Uses the measured provider-call time, not the whole
 * turn, so tool waits and approvals do not dilute generation speed. Returns
 * undefined when the provider reported no output or no timing.
 */
export function formatTokensPerSecond(
  outputTokens: number,
  modelMs: number,
): string | undefined {
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) return undefined;
  if (!Number.isFinite(modelMs) || modelMs <= 0) return undefined;
  return `${Math.round(outputTokens / (modelMs / 1000))} tok/s`;
}

/** Format a thinking/reasoning duration in the same coarse style as elapsed. */
export function formatThinkingTime(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  if (ms > 0 && ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  return formatElapsed(ms);
}

export interface TurnStatsDetails {
  modelCalls?: number;
  promptTokens?: number;
  cacheHitRate?: number;
}

/** Compact token counts in the same style as the web stats. */
function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  const n = Math.floor(count);
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) {
    const rounded = Math.round(n / 1000);
    return rounded >= 1000 ? "1M" : `${rounded}k`;
  }
  if (n < 10_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  return `${Math.round(n / 1_000_000)}M`;
}

/**
 * End-of-turn elapsed time. Sub-second turns keep a measured fraction instead
 * of rounding to a misleading "0s"; the live activity spinner keeps the coarser
 * formatElapsed.
 */
function formatTurnElapsed(ms: number): string {
  const elapsed = Math.max(0, ms);
  if (elapsed > 0 && elapsed < 1000) return `${(elapsed / 1000).toFixed(1)}s`;
  return formatElapsed(elapsed);
}

/** One end-of-turn metadata line: elapsed wall time and generation speed. */
export function formatTurnStats(
  elapsedMs: number,
  outputTokens: number,
  modelMs: number,
  details?: TurnStatsDetails,
): string {
  const parts = [formatTurnElapsed(elapsedMs)];
  const rate = formatTokensPerSecond(outputTokens, modelMs);
  if (rate) parts.push(rate);
  if (details?.modelCalls && details.modelCalls > 0) {
    parts.push(
      `${details.modelCalls} ${details.modelCalls === 1 ? "call" : "calls"}`,
    );
  }
  if (details?.promptTokens && details.promptTokens > 0) {
    parts.push(`${formatTokenCount(details.promptTokens)} prompt`);
  }
  if (
    details?.cacheHitRate !== undefined &&
    Number.isFinite(details.cacheHitRate) &&
    details.cacheHitRate > 0
  ) {
    parts.push(`${Math.round(details.cacheHitRate)}% cached`);
  }
  return parts.join(" · ");
}

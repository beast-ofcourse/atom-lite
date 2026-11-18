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
): string {
  const parts = [formatTurnElapsed(elapsedMs)];
  const rate = formatTokensPerSecond(outputTokens, modelMs);
  if (rate) parts.push(rate);
  return parts.join(" · ");
}

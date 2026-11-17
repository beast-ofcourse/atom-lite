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

/** One end-of-turn metadata line: elapsed wall time and generation speed. */
export function formatTurnStats(
  elapsedMs: number,
  outputTokens: number,
  modelMs: number,
): string {
  const parts = [formatElapsed(Math.max(0, elapsedMs))];
  const rate = formatTokensPerSecond(outputTokens, modelMs);
  if (rate) parts.push(rate);
  return parts.join(" · ");
}

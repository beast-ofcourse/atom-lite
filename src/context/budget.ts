import type { JsonValue } from "../types.js";
// Token budget helpers. Heuristic estimation: ~4 chars per token.

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * estimateMessageTokens is called for every history message on every context
 * build (once per model turn), so the session's aggregate cost is quadratic
 * in history length. History messages are immutable once appended (turn
 * recorder and session replay construct fresh objects; the agent loop only
 * mutates tool results before recording), so memoizing by object identity is
 * safe: repeated builds of the same message hit the cache. WeakMap keeps
 * keys weak, so no retain cycle on replayed/discarded messages.
 */
const estimateCache = new WeakMap<object, number>();

export function estimateMessageTokens(message: unknown): number {
  if (message !== null && typeof message === "object") {
    const cached = estimateCache.get(message as object);
    if (cached !== undefined) return cached;
    const computed = computeEstimate(message);
    estimateCache.set(message as object, computed);
    return computed;
  }
  return computeEstimate(message);
}

function computeEstimate(message: unknown): number {
  try {
    const sanitized = stripImages(message);
    return Math.ceil(JSON.stringify(sanitized).length / 4);
  } catch {
    return 0;
  }
}

function stripImages(value: unknown): JsonValue {
  if (Array.isArray(value)) {
    return value
      .map((v) => stripImages(v))
      .filter(
        (v) => !(v && typeof v === "object" && (v as any).type === "image"),
      );
  }
  if (value && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "images") continue;
      out[k] = stripImages(v);
    }
    return out;
  }
  return value as JsonValue;
}

import type { FinishReason } from "../types.js";

/** Providers name output-limit truncation differently; other reasons keep legacy behavior. */
export function resolveFinishReason(
  reported: unknown,
  hasToolCalls: boolean,
): FinishReason {
  if (
    reported === "length" ||
    reported === "MAX_TOKENS" ||
    reported === "max_tokens"
  ) {
    return "length";
  }
  return hasToolCalls ? "tool_calls" : "stop";
}

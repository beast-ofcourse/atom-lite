import type { FinishReason } from "../types.js";

/** Map the finish reasons that change how a response must be presented. */
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
  if (reported === "content_filter") return "error";
  return hasToolCalls ? "tool_calls" : "stop";
}

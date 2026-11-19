import type { TokenUsage } from "../types.js";

/**
 * Parse OpenAI-compatible token usage, including the common cache-counter
 * spellings used by OpenAI, OpenRouter and Anthropic-compatible gateways.
 * Cache fields are absent unless the provider actually reported them.
 */
export function parseOpenAIUsage(raw: any): TokenUsage | undefined {
  if (!raw) return undefined;
  const usage: TokenUsage = {
    input: raw.prompt_tokens,
    output: raw.completion_tokens,
    total: raw.total_tokens,
  };

  const details = raw.prompt_tokens_details;
  const cached =
    typeof details?.cached_tokens === "number"
      ? details.cached_tokens
      : typeof raw.cached_tokens === "number"
        ? raw.cached_tokens
        : typeof raw.cache_read_input_tokens === "number"
          ? raw.cache_read_input_tokens
          : undefined;
  if (cached !== undefined) usage.cacheRead = cached;

  const write =
    typeof raw.cache_creation_input_tokens === "number"
      ? raw.cache_creation_input_tokens
      : typeof raw.cache_write_input_tokens === "number"
        ? raw.cache_write_input_tokens
        : undefined;
  if (write !== undefined) usage.cacheWrite = write;

  return usage;
}

/** Parse Gemini usageMetadata into the shared usage shape. */
export function parseGeminiUsage(raw: any): TokenUsage | undefined {
  if (!raw) return undefined;
  const usage: TokenUsage = {
    input: raw.promptTokenCount,
    // Thinking tokens count toward the next request's context, so they fold
    // into generated output (same rule as the Gemini adapter's own parsing).
    output: (raw.candidatesTokenCount ?? 0) + (raw.thoughtsTokenCount ?? 0),
    total: raw.totalTokenCount,
  };
  if (typeof raw.cachedContentTokenCount === "number") {
    usage.cacheRead = raw.cachedContentTokenCount;
  }
  return usage;
}

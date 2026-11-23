import type { TokenUsage } from "../types.js";

/**
 * Parse OpenAI-compatible token usage, including the common cache-counter
 * spellings used by OpenAI, OpenRouter and Anthropic-compatible gateways.
 * Cache fields are absent unless the provider actually reported them.
 */
export function parseOpenAIUsage(raw: any): TokenUsage | undefined {
  if (!raw) return undefined;
  const input =
    typeof raw.prompt_tokens === "number"
      ? raw.prompt_tokens
      : typeof raw.input_tokens === "number"
        ? raw.input_tokens
        : typeof raw.prompt_eval_count === "number"
          ? raw.prompt_eval_count
          : undefined;
  const output =
    typeof raw.completion_tokens === "number"
      ? raw.completion_tokens
      : typeof raw.output_tokens === "number"
        ? raw.output_tokens
        : typeof raw.eval_count === "number"
          ? raw.eval_count
          : undefined;
  const total =
    typeof raw.total_tokens === "number"
      ? raw.total_tokens
      : typeof input === "number" && typeof output === "number"
        ? input + output
        : undefined;
  const usage: TokenUsage = { input, output, total };

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

// Context-window metadata helpers. A model's window is resolved from (in
// order): an explicit provider config override, live provider metadata, or the
// known-model table below.

interface ModelEntry {
  context_length?: number;
  context_window?: number;
  contextWindow?: number;
  max_context_length?: number;
  max_context_window?: number;
  max_model_len?: number;
  max_input_tokens?: number;
  input_token_limit?: number;
  max_context_window_tokens?: number;
  n_ctx?: number;
  max_seq_len?: number;
  limits?: {
    context?: number;
    max_input_tokens?: number;
    max_context_length?: number;
  };
  top_provider?: {
    context_length?: number;
    context_window?: number;
    max_context_length?: number;
  };
  architecture?: {
    context_length?: number;
  };
  capabilities?: unknown;
  modalities?: unknown;
  supported_modalities?: unknown;
  input_modalities?: unknown;
  supports_vision?: boolean;
  vision?: boolean;
  [key: string]: unknown;
}

interface ModalityEntry {
  vision?: boolean;
  image?: boolean;
  [key: string]: unknown;
}

/** Extract a context window from an OpenAI-compatible /models entry. */
export function contextWindowFromModelEntry(
  entry: unknown,
): number | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const e = entry as ModelEntry;
  const candidates = [
    e.context_length,
    e.context_window,
    e.contextWindow,
    e.max_context_length,
    e.max_context_window,
    e.max_model_len,
    e.max_input_tokens,
    e.input_token_limit,
    e.max_context_window_tokens,
    e.n_ctx,
    e.max_seq_len,
    e.limits?.context,
    e.limits?.max_input_tokens,
    e.limits?.max_context_length,
    e.top_provider?.context_length,
    e.top_provider?.context_window,
    e.top_provider?.max_context_length,
    e.architecture?.context_length,
  ];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  }
  return undefined;
}

/**
 * Best-effort context windows for models whose provider does not expose one.
 * Most specific patterns come first. These are display/compaction defaults and
 * are always overridden by live provider metadata when available.
 */
const KNOWN_WINDOWS: Array<[RegExp, number]> = [
  [/gpt-4\.1/, 1_047_576],
  [/gpt-4o|gpt-4-turbo|gpt-4-0125|gpt-4-1106/, 128_000],
  [/gpt-6|gpt-5/, 1_050_000],
  [/o1|o3|o4/, 200_000],
  [/claude/, 200_000],
  [/gemini-1\.5-pro/, 2_097_152],
  [/gemini-1\.5|gemini-2|gemini-3|gemma/, 1_048_576],
  [/grok/, 131_072],
  [/codestral/, 256_000],
  [/mistral-large/, 128_000],
  [/deepseek-v4|deepseek-r1|deepseek-v3/, 1_048_576],
  [/deepseek/, 131_072],
  [/qwen3|qwen2\.5/, 131_072],
  [/qwen/, 32_768],
  [/llama-4/, 1_048_576],
  [/llama-3\.3|llama-3\.2|llama-3\.1/, 131_072],
  [/llama-3/, 8_192],
  [/kilo-auto\/efficient/, 1_000_000],
  [/kilo-auto\/free/, 256_000],
  [/reflection\/beam-free/, 1_048_576],
];

/** Compact token count used by the status line: 999, 1.2k, 256k, 1M. */
export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  const n = Math.floor(count);
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    if (n < 10_000) {
      const k = (n / 1000).toFixed(1).replace(/\.0$/, "");
      return `${k}k`;
    }
    const rounded = Math.round(n / 1000);
    return rounded >= 1000 ? "1M" : `${rounded}k`;
  }
  if (n < 10_000_000) {
    return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  return `${Math.round(n / 1_000_000)}M`;
}

/**
 * Render `used/window`, matching the compact peer style (`1.2k/256k`).
 * Unknown values are shown as `?` rather than a fake number.
 */
export function formatContextUsage(
  used: number | undefined,
  window: number | undefined,
): string {
  const usedText =
    used !== undefined && used > 0
      ? formatTokenCount(used)
      : used === 0
        ? "0"
        : "?";
  if (window === undefined || window <= 0) {
    if (used === undefined) return "?";
    return `${usedText}/?`;
  }
  return `${usedText}/${formatTokenCount(window)}`;
}

/** Guess a context window from the model id when no metadata is available. */
export function knownContextWindow(
  model: string | undefined,
): number | undefined {
  if (!model) return undefined;
  const id = model.toLowerCase();
  for (const [pattern, window] of KNOWN_WINDOWS) {
    if (pattern.test(id)) return window;
  }
  return undefined;
}

/** Extract a vision-support flag from an OpenAI-compatible /models entry. */
export function supportsVisionFromModelEntry(
  entry: unknown,
): boolean | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const e = entry as ModelEntry;
  const caps = [
    e.capabilities,
    e.modalities,
    e.supported_modalities,
    e.input_modalities,
  ];
  for (const c of caps) {
    if (Array.isArray(c)) {
      const lower = c.map((x) => String(x).toLowerCase());
      if (lower.some((x) => x.includes("vision") || x.includes("image")))
        return true;
      if (
        lower.length > 0 &&
        lower.every((x) => x === "text" || x === "text-only")
      )
        return false;
    }
    if (typeof c === "object" && c) {
      const m = c as ModalityEntry;
      if (m.vision === true || m.image === true) return true;
    }
  }
  if (typeof e.supports_vision === "boolean") return e.supports_vision;
  if (typeof e.vision === "boolean") return e.vision;
  return undefined;
}

/** Best-effort vision capability by model id/name. */
export function knownVisionModel(
  model: string | undefined,
): boolean | undefined {
  if (!model) return undefined;
  const id = model.toLowerCase();
  const visionPatterns = [
    /gpt-4o/,
    /gpt-4\.1/,
    /gpt-4-turbo/,
    /o[134]-.*vision/,
    /claude-3/,
    /claude-sonnet-4/,
    /claude-opus-4/,
    /gemini/,
    /llava/,
    /bakllava/,
    /moondream/,
    /pixtral/,
    /qwen.*vl/,
    /qwen2\.5-vl/,
    /gemma-3/,
    /minicpm-v/,
    /internvl/,
  ];
  if (visionPatterns.some((p) => p.test(id))) return true;
  // Explicit non-vision hints
  return undefined;
}

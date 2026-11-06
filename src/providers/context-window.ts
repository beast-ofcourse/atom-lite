// Context-window metadata helpers. A model's window is resolved from (in
// order): an explicit provider config override, live provider metadata, or the
// known-model table below.

/** Extract a context window from an OpenAI-compatible /models entry. */
export function contextWindowFromModelEntry(
  entry: unknown,
): number | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const e = entry as Record<string, any>;
  const candidates = [
    e.context_length,
    e.context_window,
    e.contextWindow,
    e.max_context_length,
    e.max_context_window,
    e.limits?.context,
    e.top_provider?.context_length,
    e.top_provider?.context_window,
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
  [/o3|o4-mini/, 200_000],
  [/gpt-3\.5/, 16_385],
  [/claude/, 200_000],
  [/gemini-1\.5-pro/, 2_097_152],
  [/gemini-1\.5|gemini-2/, 1_048_576],
  [/grok/, 131_072],
  [/codestral/, 256_000],
  [/mistral-large/, 128_000],
  [/llama-3|llama3|llama-4|mixtral|deepseek|qwen/, 131_072],
  [/kilo-auto\/free/, 256_000],
  [/kilo-auto\/efficient/, 1_000_000],
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
  if (window === undefined || window <= 0) return usedText;
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
  const e = entry as Record<string, any>;
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
      if (c.vision === true || c.image === true) return true;
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

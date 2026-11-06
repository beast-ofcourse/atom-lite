// Token budget helpers. Heuristic estimation: ~4 chars per token.

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessageTokens(message: unknown): number {
  try {
    const sanitized = stripImages(message);
    return Math.ceil(JSON.stringify(sanitized).length / 4);
  } catch {
    return 0;
  }
}

function stripImages(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map((v) => stripImages(v))
      .filter(
        (v) => !(v && typeof v === "object" && (v as any).type === "image"),
      );
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "images") continue;
      out[k] = stripImages(v);
    }
    return out;
  }
  return value;
}

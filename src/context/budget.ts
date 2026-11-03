// Token budget helpers. Heuristic estimation: ~4 chars per token.

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessageTokens(message: unknown): number {
  try {
    return Math.ceil(JSON.stringify(message).length / 4);
  } catch {
    return 0;
  }
}
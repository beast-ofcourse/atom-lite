export function retryDelayMs(
  response: Response,
  attempt: number,
  baseMs: number,
): number {
  const ra = response.headers.get("retry-after");
  if (ra) {
    const sec = Number(ra);
    if (Number.isFinite(sec) && sec >= 0) {
      return Math.min(sec * 1000, 30000);
    }
    const date = Date.parse(ra);
    if (!isNaN(date)) {
      const ms = date - Date.now();
      if (ms > 0) return Math.min(ms, 30000);
    }
  }
  return baseMs * 2 ** attempt;
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

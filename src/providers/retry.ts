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
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("USER_CANCELLED"));
      return;
    }
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("USER_CANCELLED"));
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

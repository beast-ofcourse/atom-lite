/** A small process-lifetime LRU used by both web tools. */
export interface BoundedCache<T> {
  get(key: string): T | undefined;
  put(key: string, value: T): void;
}

export function createBoundedCache<T>(maxEntries: number): BoundedCache<T> {
  const entries = new Map<string, T>();
  return {
    get(key) {
      return entries.get(key);
    },
    put(key, value) {
      if (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(key, value);
    },
  };
}

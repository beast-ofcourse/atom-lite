import { resolve } from "node:path";
import { realpathSync, existsSync } from "node:fs";

export type Release = () => void;

/** Bound the live lock map; evicting a held lock would allow two owners. */
export const MAX_LOCK_CACHE_ENTRIES = 1024;

function canonical(key: string): string {
  let cursor = key;
  while (!existsSync(cursor)) {
    const parent = resolve(cursor, "..");
    if (parent === cursor) break;
    cursor = parent;
  }
  if (existsSync(cursor)) {
    try {
      const real = realpathSync(cursor);
      return real + key.slice(cursor.length);
    } catch {
      // fall through
    }
  }
  return key;
}

interface Waiter {
  mode: "read" | "write" | "barrier";
  resolve: (release: Release) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

class RWLock {
  private readers = 0;
  private writer = false;
  private barriers = 0;
  private queue: Waiter[] = [];

  /** No holders and no waiters: safe to drop from the manager's cache. */
  isIdle(): boolean {
    return (
      this.readers === 0 &&
      !this.writer &&
      this.barriers === 0 &&
      this.queue.length === 0
    );
  }

  acquire(
    mode: "read" | "write" | "barrier",
    signal?: AbortSignal,
  ): Promise<Release> {
    const key = ""; // unused; lock instance is per-resource
    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = { mode, resolve, reject, signal };
      const tryAcquire = (): boolean => {
        if (signal?.aborted) return false;
        if (mode === "read") {
          if (!this.writer && this.barriers === 0 && this.queue.length === 0) {
            this.readers++;
            waiter.resolve(() => {
              this.readers--;
              this.drain();
            });
            return true;
          }
        } else if (mode === "write") {
          if (this.readers === 0 && !this.writer && this.barriers === 0) {
            this.writer = true;
            waiter.resolve(() => {
              this.writer = false;
              this.drain();
            });
            return true;
          }
        } else {
          // Barriers are shared with other barriers but exclusive with all
          // file reads and writes.
          if (this.readers === 0 && !this.writer && this.queue.length === 0) {
            this.barriers++;
            waiter.resolve(() => {
              this.barriers--;
              this.drain();
            });
            return true;
          }
        }
        return false;
      };

      if (tryAcquire()) return;

      this.queue.push(waiter);
      if (signal) {
        waiter.onAbort = () => {
          const idx = this.queue.indexOf(waiter);
          if (idx >= 0) this.queue.splice(idx, 1);
          reject(new Error("USER_CANCELLED"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
    });
  }

  private detach(waiter: Waiter): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }

  private drain(): void {
    // Process waiters in FIFO order; allow consecutive readers.
    let progressed = true;
    while (progressed && this.queue.length > 0) {
      progressed = false;
      // Find next runnable waiter.
      const idx = this.queue.findIndex((w) => {
        if (w.signal?.aborted) return true;
        if (w.mode === "read") {
          // Without the head check, queued writers starve under reader bursts.
          return !this.writer && this.barriers === 0 && w === this.queue[0];
        }
        if (w.mode === "write") {
          return this.readers === 0 && !this.writer && this.barriers === 0;
        }
        return this.readers === 0 && !this.writer;
      });
      if (idx < 0) break;
      const w = this.queue.splice(idx, 1)[0];
      this.detach(w);
      if (w.signal?.aborted) {
        w.reject(new Error("USER_CANCELLED"));
        progressed = true;
        continue;
      }
      if (w.mode === "read") {
        this.readers++;
        w.resolve(() => {
          this.readers--;
          this.drain();
        });
      } else if (w.mode === "write") {
        this.writer = true;
        w.resolve(() => {
          this.writer = false;
          this.drain();
        });
      } else {
        this.barriers++;
        w.resolve(() => {
          this.barriers--;
          this.drain();
        });
      }
      progressed = true;
      // If a writer just acquired, stop allowing more readers this round.
      if (w.mode === "write") break;
    }
  }
}

export class LockManager {
  private locks = new Map<string, RWLock>();
  private global = new RWLock();
  private canonicalCache = new Map<string, string>();

  /** Read-only observability for bounds tests and long-session diagnostics. */
  get cacheStats(): { canonicalKeys: number; locks: number } {
    return {
      canonicalKeys: this.canonicalCache.size,
      locks: this.locks.size,
    };
  }

  private canonicalKey(key: string): string {
    const cached = this.canonicalCache.get(key);
    if (cached !== undefined) {
      // Refresh recency so the cache behaves as an LRU, not a FIFO.
      this.canonicalCache.delete(key);
      this.canonicalCache.set(key, cached);
      return cached;
    }
    const k = canonical(key);
    this.canonicalCache.set(key, k);
    return k;
  }

  private getLock(key: string): RWLock {
    const k = this.canonicalKey(key);
    let l = this.locks.get(k);
    if (l) {
      this.locks.delete(k);
      this.locks.set(k, l);
      return l;
    }
    if (this.locks.size >= MAX_LOCK_CACHE_ENTRIES) {
      // Never evict a lock that is held or has waiters: a new lock object for
      // the same resource would permit concurrent access.
      for (const [existingKey, existing] of this.locks) {
        if (existing.isIdle()) {
          this.locks.delete(existingKey);
          break;
        }
      }
    }
    l = new RWLock();
    this.locks.set(k, l);
    return l;
  }

  async acquireRead(key: string, signal?: AbortSignal): Promise<Release> {
    const g = await this.global.acquire("read", signal);
    try {
      const f = await this.getLock(key).acquire("read", signal);
      return () => {
        f();
        g();
      };
    } catch (err) {
      try {
        g();
      } catch {
        // Ignore release errors.
      }
      throw err;
    }
  }

  async acquireWrite(key: string, signal?: AbortSignal): Promise<Release> {
    const g = await this.global.acquire("read", signal);
    try {
      const f = await this.getLock(key).acquire("write", signal);
      return () => {
        f();
        g();
      };
    } catch (err) {
      try {
        g();
      } catch {
        // Ignore release errors.
      }
      throw err;
    }
  }

  async acquireGlobal(signal?: AbortSignal): Promise<Release> {
    return this.global.acquire("write", signal);
  }

  /** Shared barrier used by parallel bash calls: exclusive with file ops. */
  async acquireGlobalBarrier(signal?: AbortSignal): Promise<Release> {
    return this.global.acquire("barrier", signal);
  }
}

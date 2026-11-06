import { resolve } from "node:path";
import { realpathSync, existsSync } from "node:fs";

export type Release = () => void;

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
}

class RWLock {
  private readers = 0;
  private writer = false;
  private barriers = 0;
  private queue: Waiter[] = [];

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
        const onAbort = () => {
          const idx = this.queue.indexOf(waiter);
          if (idx >= 0) this.queue.splice(idx, 1);
          reject(new Error("USER_CANCELLED"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
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
          return !this.writer && this.barriers === 0;
        }
        if (w.mode === "write") {
          return this.readers === 0 && !this.writer && this.barriers === 0;
        }
        return this.readers === 0 && !this.writer;
      });
      if (idx < 0) break;
      const w = this.queue.splice(idx, 1)[0];
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

  private canonicalKey(key: string): string {
    const cached = this.canonicalCache.get(key);
    if (cached !== undefined) return cached;
    const k = canonical(key);
    this.canonicalCache.set(key, k);
    return k;
  }

  private getLock(key: string): RWLock {
    const k = this.canonicalKey(key);
    let l = this.locks.get(k);
    if (!l) {
      l = new RWLock();
      this.locks.set(k, l);
    }
    return l;
  }

  async acquireRead(key: string, signal?: AbortSignal): Promise<Release> {
    const g = await this.global.acquire("read", signal);
    const f = await this.getLock(key).acquire("read", signal);
    return () => {
      f();
      g();
    };
  }

  async acquireWrite(key: string, signal?: AbortSignal): Promise<Release> {
    const g = await this.global.acquire("read", signal);
    const f = await this.getLock(key).acquire("write", signal);
    return () => {
      f();
      g();
    };
  }

  async acquireGlobal(signal?: AbortSignal): Promise<Release> {
    return this.global.acquire("write", signal);
  }

  /** Shared barrier used by parallel bash calls: exclusive with file ops. */
  async acquireGlobalBarrier(signal?: AbortSignal): Promise<Release> {
    return this.global.acquire("barrier", signal);
  }
}

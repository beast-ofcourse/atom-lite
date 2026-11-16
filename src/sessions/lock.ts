import {
  closeSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";

/** Who currently owns a session's JSONL log. */
export interface LockHolder {
  pid: number;
  host: string;
  sessionId: string;
  startedAt: string;
}

export class SessionLockError extends Error {
  constructor(
    readonly sessionId: string,
    readonly holder: LockHolder,
  ) {
    super(
      `session ${sessionId} is already open in PID ${holder.pid} on ${holder.host}`,
    );
    this.name = "SessionLockError";
  }
}

export interface SessionLockOptions {
  /**
   * How long a lock whose owning process is gone is left alone before it is
   * reclaimed. Keeps a crash-restart from racing a just-dying process.
   */
  reclaimAfterMs?: number;
}

interface ActiveLock {
  holder: LockHolder;
  count: number;
}

const activeLocks = new Map<string, ActiveLock>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once("exit", () => {
    for (const lockPath of activeLocks.keys()) {
      try {
        unlinkSync(lockPath);
      } catch {
        // best effort: a stale lock is reclaimed by the next owner
      }
    }
    activeLocks.clear();
  });
}

function register(lockPath: string, holder: LockHolder): SessionLock {
  activeLocks.set(lockPath, { holder, count: 1 });
  return new SessionLock(lockPath, holder);
}

function join(lockPath: string, holder: LockHolder): SessionLock {
  const existing = activeLocks.get(lockPath);
  if (existing) {
    existing.count++;
    return new SessionLock(lockPath, existing.holder);
  }
  // The file already carries this PID (for example another store instance),
  // so adopt it and leave the unlink to the last releaser.
  return register(lockPath, holder);
}

export class SessionLock {
  constructor(
    readonly path: string,
    readonly holder: LockHolder,
  ) {}

  /**
   * Release one ownership share. Same-process re-entry is ref-counted: the
   * lock file stays until the last session object in this process releases.
   */
  release(): void {
    const active = activeLocks.get(this.path);
    if (!active) return;
    active.count--;
    if (active.count > 0) return;
    activeLocks.delete(this.path);
    try {
      unlinkSync(this.path);
    } catch {
      // already gone
    }
  }
}

function readHolder(lockPath: string): LockHolder | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as LockHolder;
    if (!parsed || typeof parsed.pid !== "number") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function lockAgeMs(lockPath: string): number {
  try {
    return Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Synchronous sleep, used while reclaiming a dead owner's lock. */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Acquire `<session>.jsonl.lock` for one live owner. Locks are PID-based: a
 * live owner refuses the acquisition with a `SessionLockError`, a dead owner
 * is reclaimed after a short grace period, and the current process is allowed
 * to re-enter (the terminal can reopen its own session).
 */
export function acquireSessionLock(
  lockPath: string,
  sessionId: string,
  options: SessionLockOptions = {},
): SessionLock {
  installExitHook();
  const reclaimAfterMs = Math.max(0, options.reclaimAfterMs ?? 250);
  let lastHolder: LockHolder | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      const holder: LockHolder = {
        pid: process.pid,
        host: hostname(),
        sessionId,
        startedAt: new Date().toISOString(),
      };
      writeSync(fd, JSON.stringify(holder) + "\n");
      closeSync(fd);
      return register(lockPath, holder);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    const holder = readHolder(lockPath);
    lastHolder = holder;
    if (holder && holder.pid === process.pid) {
      return join(lockPath, holder);
    }
    if (holder && processAlive(holder.pid)) {
      throw new SessionLockError(sessionId, holder);
    }

    if (attempt === 0) {
      const age = lockAgeMs(lockPath);
      if (Number.isFinite(age) && age < reclaimAfterMs) {
        sleepSync(reclaimAfterMs - age);
      }
      // Re-read before reclaiming: the file may have been created moments ago
      // and only now contain its holder, and a live holder must never be
      // unlinked by a reader that caught it mid-write.
      const fresh = readHolder(lockPath);
      if (fresh && fresh.pid !== process.pid && processAlive(fresh.pid)) {
        throw new SessionLockError(sessionId, fresh);
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // another process may have reclaimed it first
      }
    }
  }
  throw new SessionLockError(
    sessionId,
    lastHolder ?? {
      pid: 0,
      host: "unknown",
      sessionId,
      startedAt: new Date(0).toISOString(),
    },
  );
}

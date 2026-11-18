/**
 * A contained extension failure. Every extension callback runs behind a
 * Boundary; nothing it throws, rejects, hangs, or leaves behind from a previous
 * generation escapes as an unhandled rejection or an unbounded wait.
 */
export interface BoundaryError {
  extensionId: string;
  /** Event or method name, e.g. `on:session_end` or `command:/deploy`. */
  method: string;
  message: string;
  stack?: string;
  phase: "throw" | "reject" | "timeout" | "stale";
}

export interface BoundaryMeta {
  extensionId: string;
  method: string;
}

export interface BoundaryOptions {
  /** Reports the current reload generation. */
  generation: () => number;
  /**
   * Overrides generation equality. During staging both the committed and the
   * pending generation are live: the outgoing set must still observe
   * session_shutdown while the incoming set activates.
   */
  isLive?: () => boolean;
  /** Maximum time a single callback may run before it is timed out. */
  timeoutMs: number;
  /** Receives exactly one entry per contained failure. */
  onError: (error: BoundaryError) => void;
}

interface RunOptions {
  /** Re-throw a contained failure after reporting it (for command dispatch). */
  rethrow?: boolean;
}

const TIMEOUT_MESSAGE = "handler timed out";

/**
 * A generation-bound execution boundary. One instance is created per load
 * generation, so a callback captured before a reload is stale afterwards and
 * cannot mutate the new extension set.
 */
export class ExtensionBoundary {
  readonly generation: number;

  constructor(private readonly options: BoundaryOptions) {
    this.generation = options.generation();
  }

  isStale(): boolean {
    return this.options.isLive
      ? !this.options.isLive()
      : this.generation !== this.options.generation();
  }

  async run<T>(
    meta: BoundaryMeta,
    fn: () => T | Promise<T>,
    options: RunOptions = {},
  ): Promise<T | undefined> {
    if (this.isStale()) {
      this.report(meta, "stale", "handler skipped: stale generation");
      return undefined;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(fn),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(TIMEOUT_MESSAGE)),
            this.options.timeoutMs,
          );
        }),
      ]);
      if (this.isStale()) {
        this.report(
          meta,
          "stale",
          "handler result discarded: stale generation",
        );
        return undefined;
      }
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const phase = err.message === TIMEOUT_MESSAGE ? "timeout" : "reject";
      this.report(meta, phase, err.message, err.stack);
      if (options.rethrow) throw err;
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private report(
    meta: BoundaryMeta,
    phase: BoundaryError["phase"],
    message: string,
    stack?: string,
  ): void {
    this.options.onError({
      extensionId: meta.extensionId,
      method: meta.method,
      message,
      stack,
      phase,
    });
  }
}

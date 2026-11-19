import type { Message } from "../types.js";

export interface WarmingOptions {
  provider: {
    generate(request: any): Promise<any>;
  };
  model: string;
  getMessages(): Message[] | null;
  intervalMs: number;
  durationMs: number;
  schedule?: (fn: () => void, ms: number) => number;
  cancel?: (handle: number) => void;
}

/** Opt-in keep-alive that reuses the last context while the prompt cache lives. */
export class CacheWarmer {
  active = false;
  private intervalHandle: number | undefined;
  private durationHandle: number | undefined;
  private readonly schedule: (fn: () => void, ms: number) => number;
  private readonly cancel: (handle: number) => void;

  constructor(private readonly options: WarmingOptions) {
    this.schedule =
      options.schedule ??
      ((fn, ms) => setInterval(fn, ms) as unknown as number);
    this.cancel =
      options.cancel ??
      ((handle) => clearInterval(handle as unknown as ReturnType<typeof setInterval>));
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.intervalHandle = this.schedule(
      () => void this.tick(),
      this.options.intervalMs,
    );
    this.durationHandle = this.schedule(
      () => this.stop(),
      this.options.durationMs,
    );
  }

  stop(): void {
    if (this.intervalHandle !== undefined) this.cancel(this.intervalHandle);
    if (this.durationHandle !== undefined) this.cancel(this.durationHandle);
    this.intervalHandle = undefined;
    this.durationHandle = undefined;
    this.active = false;
  }

  /** Send one keep-alive call. A reported cache miss ends warming. */
  async tick(): Promise<void> {
    if (!this.active) return;
    const messages = this.options.getMessages();
    if (!messages || messages.length === 0) return;
    try {
      const response = await this.options.provider.generate({
        model: this.options.model,
        messages,
        tools: [],
      });
      const usage = response?.usage;
      const reportsCounters =
        usage &&
        (usage.cacheRead !== undefined || usage.cacheWrite !== undefined);
      if (reportsCounters && usage.cacheRead === 0) this.stop();
    } catch {
      this.stop();
    }
  }
}

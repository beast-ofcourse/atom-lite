/**
 * In-memory observability for one extension, reset whenever the loader stages
 * a fresh extension set. Records are bounded: a runaway `pi.metric` loop cannot
 * grow the host without limit. Doctor consumes only the snapshot — raw metric
 * values and attribute payloads never leave this process.
 */
export const MAX_OBSERVABILITY_RECORDS = 1000;

export interface SpanRecord {
  name: string;
  durationMs: number;
  outcome: "ok" | "error";
  error?: string;
  value?: unknown;
}

export interface MetricRecord {
  name: string;
  value: number;
  attrs?: Record<string, unknown>;
}

export interface ObservabilityRecords {
  spans: SpanRecord[];
  metrics: MetricRecord[];
}

export interface ObservabilitySnapshot {
  spanCount: number;
  metricCount: number;
  errorCount: number;
  lastError?: string;
}

function boundedPush<T>(records: T[], record: T): void {
  records.push(record);
  if (records.length > MAX_OBSERVABILITY_RECORDS) {
    records.splice(0, records.length - MAX_OBSERVABILITY_RECORDS);
  }
}

export class ExtensionObservability {
  private readonly spans: SpanRecord[] = [];
  private readonly metrics: MetricRecord[] = [];

  /** Run `fn`, recording its duration and outcome, then preserve its result. */
  async span<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      const value = await fn();
      boundedPush(this.spans, {
        name,
        durationMs: performance.now() - started,
        outcome: "ok",
        value,
      });
      return value;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      boundedPush(this.spans, {
        name,
        durationMs: performance.now() - started,
        outcome: "error",
        error: message,
      });
      throw error;
    }
  }

  /** Record a counter. Attributes stay in-process; doctor never exports them. */
  metric(name: string, value: number, attrs?: Record<string, unknown>): void {
    boundedPush(this.metrics, { name, value, attrs });
  }

  records(): ObservabilityRecords {
    return { spans: [...this.spans], metrics: [...this.metrics] };
  }

  /** The only observability data exposed to diagnostics. */
  snapshot(): ObservabilitySnapshot {
    let errorCount = 0;
    let lastError: string | undefined;
    for (const span of this.spans) {
      if (span.outcome !== "error") continue;
      errorCount++;
      lastError = span.error;
    }
    return {
      spanCount: this.spans.length,
      metricCount: this.metrics.length,
      errorCount,
      ...(lastError === undefined ? {} : { lastError }),
    };
  }
}

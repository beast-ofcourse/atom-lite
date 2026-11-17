import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  MessageAttribution,
  PrefixInfo,
} from "../context/attribution.js";
import type { TokenUsage } from "../types.js";

/** Explicit price for a model, in USD per one million tokens. */
export interface ModelPricing {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export type PricingMap = Record<string, ModelPricing>;

/**
 * Cost of a call and the counterfactual cost with no cache reuse. Missing
 * rates are treated as zero; absent pricing yields no monetary fields at all.
 */
export function computeUsageCost(
  pricing: ModelPricing | undefined,
  usage: TokenUsage,
): { costUsd: number; costIfNoCacheUsd: number } | undefined {
  if (!pricing || (pricing.input === undefined && pricing.output === undefined)) {
    return undefined;
  }
  const inputRate = (pricing.input ?? 0) / 1_000_000;
  const outputRate = (pricing.output ?? 0) / 1_000_000;
  const readRate = (pricing.cacheRead ?? pricing.input ?? 0) / 1_000_000;
  const writeRate = (pricing.cacheWrite ?? pricing.input ?? 0) / 1_000_000;
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cachedRead = usage.cacheRead ?? 0;
  const cachedWrite = usage.cacheWrite ?? 0;
  return {
    costUsd:
      input * inputRate +
      output * outputRate +
      cachedRead * readRate +
      cachedWrite * writeRate,
    costIfNoCacheUsd: (input + cachedRead) * inputRate + output * outputRate,
  };
}

/** Reported token counts for one model call. Unreported fields are null. */
export interface LedgerUsage {
  input: number | null;
  output: number | null;
  total: number | null;
  /** Present only when the provider reported a cache read/write counter. */
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * One per-call record. Deliberately limited to identifiers and counts: no
 * prompt, tool output, assistant text, or file content may enter the ledger.
 */
export interface UsageRecord {
  timestamp: string;
  sessionId: string;
  requestId: string;
  provider: string;
  model: string;
  usage: LedgerUsage;
  /** Estimated token contribution of each outgoing message component. */
  attribution?: MessageAttribution;
  /** Whether this call followed a compaction of the context. */
  compacted?: boolean;
  /** Stable-prefix size/hash and drift flag, when a cache mode is enabled. */
  prefix?: PrefixInfo;
  /** Present only when an explicit price is configured for the model. */
  costUsd?: number;
  costIfNoCacheUsd?: number;
}

export interface UsageLedger {
  record(record: UsageRecord): void;
  /** Optional explicit prices, keyed by model id. Never fetched remotely. */
  prices?: PricingMap;
}

/** Identity of a model call, supplied by whichever component issues it. */
export interface UsageCallContext {
  sessionId: string;
  requestId: string;
  provider: string;
  model: string;
  attribution?: MessageAttribution;
  compacted?: boolean;
  prefix?: PrefixInfo;
}

/**
 * Shared recorder so every model call — including the compaction summarizer,
 * which bypasses the agent turn's model-turn helper — produces one record.
 */
export function recordModelUsage(
  ledger: UsageLedger | undefined,
  context: UsageCallContext,
  usage: TokenUsage = {},
): void {
  if (!ledger) return;
  try {
    const cost = computeUsageCost(ledger.prices?.[context.model], usage);
    ledger.record({
      timestamp: new Date().toISOString(),
      ...context,
      ...(cost ? { costUsd: cost.costUsd, costIfNoCacheUsd: cost.costIfNoCacheUsd } : {}),
      usage: {
        input: usage.input ?? null,
        output: usage.output ?? null,
        total: usage.total ?? null,
        ...(usage.cacheRead !== undefined ? { cacheRead: usage.cacheRead } : {}),
        ...(usage.cacheWrite !== undefined
          ? { cacheWrite: usage.cacheWrite }
          : {}),
      },
    });
  } catch {
    // A ledger implementation must never break the model call it observes.
  }
}

/** Append-only, local JSONL ledger. Writes are best-effort and never throw. */
export class FileUsageLedger implements UsageLedger {
  private dirReady = false;
  readonly prices?: PricingMap;

  constructor(filePath: string, prices?: PricingMap) {
    this.filePath = filePath;
    this.prices = prices;
  }

  private readonly filePath: string;

  record(record: UsageRecord): void {
    try {
      if (!this.dirReady) {
        mkdirSync(dirname(this.filePath), { recursive: true });
        this.dirReady = true;
      }
      appendFileSync(this.filePath, JSON.stringify(record) + "\n", "utf8");
    } catch {
      // Observability must never break an agent turn.
    }
  }
}

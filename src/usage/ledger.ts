import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MessageAttribution } from "../context/attribution.js";

/** Reported token counts for one model call. Unreported fields are null. */
export interface LedgerUsage {
  input: number | null;
  output: number | null;
  total: number | null;
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
}

export interface UsageLedger {
  record(record: UsageRecord): void;
}

/** Identity of a model call, supplied by whichever component issues it. */
export interface UsageCallContext {
  sessionId: string;
  requestId: string;
  provider: string;
  model: string;
  attribution?: MessageAttribution;
  compacted?: boolean;
}

/**
 * Shared recorder so every model call — including the compaction summarizer,
 * which bypasses the agent turn's model-turn helper — produces one record.
 */
export function recordModelUsage(
  ledger: UsageLedger | undefined,
  context: UsageCallContext,
  usage: { input?: number; output?: number; total?: number } = {},
): void {
  if (!ledger) return;
  try {
    ledger.record({
      timestamp: new Date().toISOString(),
      ...context,
      usage: {
        input: usage.input ?? null,
        output: usage.output ?? null,
        total: usage.total ?? null,
      },
    });
  } catch {
    // A ledger implementation must never break the model call it observes.
  }
}

/** Append-only, local JSONL ledger. Writes are best-effort and never throw. */
export class FileUsageLedger implements UsageLedger {
  private dirReady = false;

  constructor(private readonly filePath: string) {}

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
